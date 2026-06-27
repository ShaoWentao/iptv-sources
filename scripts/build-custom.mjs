import fs from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const targetPath = path.join(root, 'config', 'target-channels.json');
const aliasPath = path.join(root, 'config', 'channel-aliases.json');
const candidatePath = path.join(root, 'config', 'candidate-sources.json');
const officialPath = path.join(root, 'config', 'official-overrides.json');

const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function normalizeName(input = '') {
  return String(input)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\-_—–·•.,，。:：()（）\[\]【】《》「」『』]/g, '')
    .replace(/高清|超清|蓝光|标清|频道|频道高清|hd|fhd|uhd|4k超高清|源\d+|线路\d+|备用\d*/g, '')
    .replace(/中央电视台/g, '央视')
    .trim();
}

function safeContains(haystack, needle) {
  if (!needle) return false;
  if (haystack === needle) return true;
  const idx = haystack.indexOf(needle);
  if (idx < 0) return false;
  const end = idx + needle.length;
  const last = needle[needle.length - 1];
  const next = haystack[end] || '';
  if (/\d/.test(last) && /\d/.test(next)) return false;
  return true;
}

function attr(line, name) {
  const reg = new RegExp(`${name}="([^"]*)"`);
  return reg.exec(line)?.[1] || '';
}

function getHostname(url = '') {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isTrustedDomain(url, officialConfig) {
  const host = getHostname(url);
  if (!host) return false;
  return (officialConfig.trustedDomains || []).some((domain) => {
    const normalized = String(domain).toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function parseM3u(text, sourceName, officialConfig = {}) {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('#EXTINF')) continue;
    const url = lines[i + 1] || '';
    if (!/^https?:\/\//i.test(url)) continue;
    const commaIndex = line.lastIndexOf(',');
    const displayName = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : '';
    const tvgName = attr(line, 'tvg-name');
    const groupTitle = attr(line, 'group-title');
    const title = tvgName || displayName;
    if (!title) continue;
    const trustedOfficial = isTrustedDomain(url, officialConfig);
    items.push({
      title,
      displayName,
      tvgName,
      groupTitle,
      url,
      sourceName,
      rawLine: line,
      trustedOfficial,
      officialForced: false,
    });
  }
  return items;
}

function loadOfficialDirectStreams(officialConfig = {}) {
  const items = [];
  for (const stream of officialConfig.directStreams || []) {
    if (!stream?.channel || !/^https?:\/\//i.test(stream.url || '')) continue;
    items.push({
      title: stream.title || stream.channel,
      displayName: stream.channel,
      tvgName: stream.channel,
      groupTitle: stream.group || '官方',
      url: stream.url,
      sourceName: stream.provider || 'official-overrides',
      rawLine: '',
      trustedOfficial: true,
      officialForced: true,
      officialPage: stream.page || '',
      declaredResolution: stream.resolution || '',
      declaredQuality: stream.quality || '',
    });
  }
  return items;
}

async function loadLocalM3uFiles(officialConfig) {
  if (!fs.existsSync(m3uDir)) return [];
  const files = (await readdir(m3uDir)).filter(
    (file) => file.endsWith('.m3u') && !['custom.m3u'].includes(file)
  );
  const items = [];
  for (const file of files) {
    const fullPath = path.join(m3uDir, file);
    const text = await readFile(fullPath, 'utf-8');
    items.push(...parseM3u(text, file, officialConfig));
  }
  return items;
}

async function fetchText(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadRemoteM3u(remoteM3u = [], officialConfig) {
  const items = [];
  for (const source of remoteM3u) {
    const name = source.name || source.url;
    try {
      console.log(`[CUSTOM] Fetch remote candidate: ${name}`);
      const text = await fetchText(source.url, source.timeoutMs || 8000);
      items.push(...parseM3u(text, name, officialConfig));
    } catch (error) {
      console.log(`[CUSTOM] Remote candidate failed: ${name} - ${error.message}`);
    }
  }
  return items;
}

function buildTargets(targetConfig, aliasesConfig) {
  const targets = [];
  for (const group of targetConfig.groups || []) {
    for (const channel of group.channels || []) {
      const aliases = [channel, ...(aliasesConfig[channel] || [])];
      targets.push({
        name: channel,
        group: group.name,
        aliases,
        normalizedAliases: aliases.map(normalizeName).filter(Boolean),
      });
    }
  }
  return targets;
}

function matchTarget(item, targets) {
  const candidates = [item.title, item.displayName, item.tvgName].filter(Boolean).map(normalizeName);
  let best = null;
  for (const target of targets) {
    let score = 0;
    for (const candidate of candidates) {
      for (const alias of target.normalizedAliases) {
        if (candidate === alias) score = Math.max(score, 1000);
        else if (safeContains(candidate, alias)) score = Math.max(score, 760);
        else if (safeContains(alias, candidate) && candidate.length >= 3) score = Math.max(score, 620);
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { target, score };
    }
  }
  return best;
}

function parseResolution(value = '') {
  const matched = String(value).match(/(\d{3,5})x(\d{3,5})/i);
  if (!matched) return { width: 0, height: 0, pixels: 0 };
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  return { width, height, pixels: width * height };
}

function qualityHintScore(text = '') {
  const value = String(text).toLowerCase();
  let score = 0;

  if (/8k|4320/.test(value)) score += 90000;
  if (/4k|2160|uhd|超高清/.test(value)) score += 70000;
  if (/1080p|1080|fhd|fullhd|蓝光/.test(value)) score += 43000;
  if (/720p|720/.test(value)) score += 26000;
  if (/高清|hd/.test(value)) score += 22000;
  if (/576p|576/.test(value)) score += 12000;
  if (/480p|480|360p|360|标清|低清|sd/.test(value)) score -= 38000;

  return score;
}

function officialPriorityScore(item) {
  if (item.officialForced) return 2000000;
  if (item.trustedOfficial) return 1200000;
  return 0;
}

function qualityFromResolution(resolution = '') {
  const { width, height, pixels } = parseResolution(resolution);
  if (!pixels) return { width: 0, height: 0, pixels: 0, label: '', score: 0 };

  if (height >= 4320 || width >= 7680) return { width, height, pixels, label: '8K', score: 90000 };
  if (height >= 2160 || width >= 3840) return { width, height, pixels, label: '4K', score: 70000 };
  if (height >= 1080 || width >= 1920) return { width, height, pixels, label: '1080P', score: 43000 };
  if (height >= 720 || width >= 1280) return { width, height, pixels, label: '720P', score: 26000 };
  if (height >= 576) return { width, height, pixels, label: '576P', score: 12000 };
  return { width, height, pixels, label: `${height}P`, score: -25000 };
}

function collectCandidates(items, targets, maxCandidatesPerChannel) {
  const byChannel = new Map();
  const seen = new Set();

  for (const item of items) {
    const matched = matchTarget(item, targets);
    if (!matched) continue;
    const key = `${matched.target.name}\t${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const preQualityScore = qualityHintScore(
      [item.title, item.displayName, item.tvgName, item.groupTitle, item.sourceName, item.url].join(' ')
    );
    const list = byChannel.get(matched.target.name) || [];
    list.push({
      ...item,
      target: matched.target,
      matchScore: matched.score,
      preQualityScore,
      officialScore: officialPriorityScore(item),
    });
    byChannel.set(matched.target.name, list);
  }

  for (const [name, list] of byChannel) {
    list.sort(
      (a, b) =>
        b.officialScore - a.officialScore ||
        b.matchScore - a.matchScore ||
        b.preQualityScore - a.preQualityScore ||
        a.url.length - b.url.length
    );
    const forcedOfficialCount = list.filter((item) => item.officialForced).length;
    const limit = Math.max(maxCandidatesPerChannel, forcedOfficialCount || 0);
    byChannel.set(name, list.slice(0, limit));
  }
  return byChannel;
}

async function probeUrl(item, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let bytes = 0;
  let sample = '';

  try {
    const res = await fetch(item.url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Range: 'bytes=0-8191',
      },
    });

    if (!res.ok && res.status !== 206) {
      return { ok: false, latencyMs: timeoutMs, reason: `HTTP ${res.status}`, score: 0 };
    }

    const contentType = res.headers.get('content-type') || '';
    const reader = res.body?.getReader?.();
    if (reader) {
      try {
        const chunk = await reader.read();
        if (chunk.value) {
          bytes = chunk.value.byteLength;
          sample = new TextDecoder().decode(chunk.value.slice(0, 8192));
        }
      } finally {
        try {
          await reader.cancel();
        } catch {}
      }
    }

    const latencyMs = Math.round(performance.now() - started);
    const bandwidths = [...sample.matchAll(/BANDWIDTH=(\d+)/g)].map((m) => Number(m[1]));
    const bandwidth = bandwidths.length ? Math.max(...bandwidths) : 0;
    const declaredResolution = item.declaredResolution || '';
    const detectedResolution = sample.match(/RESOLUTION=(\d+x\d+)/i)?.[1] || '';
    const resolution = declaredResolution || detectedResolution;
    const resolutionQuality = qualityFromResolution(resolution);
    const isM3u8 = /mpegurl|m3u8|vnd\.apple/i.test(contentType) || sample.includes('#EXTM3U');
    const hint = qualityHintScore(
      [
        item.title,
        item.displayName,
        item.tvgName,
        item.groupTitle,
        item.sourceName,
        item.url,
        item.declaredQuality,
        sample,
      ].join(' ')
    );

    const bandwidthScore = Math.min(bandwidth / 100, 50000);
    const qualityScore =
      officialPriorityScore(item) +
      resolutionQuality.score +
      hint +
      bandwidthScore;
    const score =
      qualityScore * 10 +
      (isM3u8 ? 6000 : 0) +
      Math.min(bytes, 8192) / 4 -
      latencyMs * 3;

    return {
      ok: true,
      latencyMs,
      contentType,
      bandwidth,
      resolution,
      width: resolutionQuality.width,
      height: resolutionQuality.height,
      pixels: resolutionQuality.pixels,
      qualityLabel: resolutionQuality.label || item.declaredQuality || '',
      qualityScore,
      score,
      trustedOfficial: item.trustedOfficial || item.officialForced,
      officialForced: item.officialForced,
    };
  } catch (error) {
    return { ok: false, latencyMs: timeoutMs, reason: error.name || error.message, score: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

async function probeCandidates(byChannel, targetConfig) {
  const probe = targetConfig.probe || {};
  if (probe.enabled === false) {
    return byChannel;
  }

  const all = [];
  for (const [name, list] of byChannel) {
    list.forEach((item) => all.push({ name, item }));
  }

  console.log(`[CUSTOM] Probe candidates: ${all.length}`);
  const results = await mapLimit(all, probe.concurrency || 24, async ({ name, item }) => {
    const result = await probeUrl(item, probe.timeoutMs || 2500);
    return { name, item: { ...item, probe: result } };
  });

  const next = new Map();
  for (const result of results) {
    const list = next.get(result.name) || [];
    if (result.item.probe.ok) list.push(result.item);
    next.set(result.name, list);
  }

  for (const [name, list] of next) {
    list.sort((a, b) => {
      const officialDelta = (b.officialScore || 0) - (a.officialScore || 0);
      if (officialDelta !== 0) return officialDelta;

      const qualityDelta = (b.probe?.qualityScore || 0) - (a.probe?.qualityScore || 0);
      if (qualityDelta !== 0) return qualityDelta;

      const pixelDelta = (b.probe?.pixels || 0) - (a.probe?.pixels || 0);
      if (pixelDelta !== 0) return pixelDelta;

      const bandwidthDelta = (b.probe?.bandwidth || 0) - (a.probe?.bandwidth || 0);
      if (bandwidthDelta !== 0) return bandwidthDelta;

      return (a.probe?.latencyMs || 99999) - (b.probe?.latencyMs || 99999);
    });
    next.set(name, list);
  }

  return next;
}

function cleanMetaValue(value = '') {
  return String(value).replace(/"/g, '').trim();
}

function makeM3u(targets, byChannel, targetConfig) {
  const epgUrl = targetConfig.epgUrl || '';
  const lines = [`#EXTM3U${epgUrl ? ` x-tvg-url="${epgUrl}"` : ''}`];
  const maxAlternates = targetConfig.maxAlternatesPerChannel || 4;
  const report = [];
  const backups = [];

  for (const target of targets) {
    const list = (byChannel.get(target.name) || []).slice(0, maxAlternates);
    const main = list[0];
    const hiddenBackups = list.slice(1);

    report.push({
      name: target.name,
      group: target.group,
      count: list.length,
      selected: main
        ? {
            title: main.title,
            sourceName: main.sourceName,
            official: main.trustedOfficial || main.officialForced,
            officialForced: main.officialForced,
            officialPage: main.officialPage || '',
            latencyMs: main.probe?.latencyMs,
            resolution: main.probe?.resolution,
            qualityLabel: main.probe?.qualityLabel,
            bandwidth: main.probe?.bandwidth,
            qualityScore: main.probe?.qualityScore,
            url: main.url,
          }
        : null,
      backups: hiddenBackups.map((item, index) => ({
        order: index + 1,
        title: item.title,
        sourceName: item.sourceName,
        official: item.trustedOfficial || item.officialForced,
        officialForced: item.officialForced,
        officialPage: item.officialPage || '',
        latencyMs: item.probe?.latencyMs,
        resolution: item.probe?.resolution,
        qualityLabel: item.probe?.qualityLabel,
        bandwidth: item.probe?.bandwidth,
        qualityScore: item.probe?.qualityScore,
        url: item.url,
      })),
    });

    if (!main) continue;

    backups.push({
      name: target.name,
      group: target.group,
      main: main.url,
      mainOfficial: main.trustedOfficial || main.officialForced,
      backups: hiddenBackups.map((item) => item.url),
      sources: list.map((item, index) => ({
        role: index === 0 ? 'main' : 'backup',
        title: item.title,
        sourceName: item.sourceName,
        official: item.trustedOfficial || item.officialForced,
        officialForced: item.officialForced,
        officialPage: item.officialPage || '',
        latencyMs: item.probe?.latencyMs,
        resolution: item.probe?.resolution,
        qualityLabel: item.probe?.qualityLabel,
        bandwidth: item.probe?.bandwidth,
        qualityScore: item.probe?.qualityScore,
        url: item.url,
      })),
    });

    const title = cleanMetaValue(main.title || target.name);
    const resolution = main.probe?.resolution ? ` resolution="${main.probe.resolution}"` : '';
    const quality = main.probe?.qualityLabel ? ` quality="${main.probe.qualityLabel}"` : '';
    const official = main.trustedOfficial || main.officialForced ? ' official="true"' : '';
    const latency = main.probe?.latencyMs ? ` latency="${main.probe.latencyMs}ms"` : '';
    lines.push('');
    lines.push(
      `#EXTINF:-1 tvg-name="${target.name}" group-title="${target.group}" source-title="${title}"${resolution}${quality}${official}${latency},${target.name}`
    );
    lines.push(main.url);
  }

  return { m3u: `${lines.join('\n')}\n`, report, backups };
}

async function main() {
  const targetConfig = readJson(targetPath);
  const aliasesConfig = readJson(aliasPath);
  const candidateConfig = readJson(candidatePath);
  const officialConfig = readJson(officialPath, { trustedDomains: [], directStreams: [] });
  const targets = buildTargets(targetConfig, aliasesConfig);

  const items = [];
  const officialDirect = loadOfficialDirectStreams(officialConfig);
  items.push(...officialDirect);

  if (candidateConfig.includeGeneratedM3u !== false) {
    items.push(...(await loadLocalM3uFiles(officialConfig)));
  }
  items.push(...(await loadRemoteM3u(candidateConfig.remoteM3u || [], officialConfig)));

  console.log(`[CUSTOM] Loaded official direct streams: ${officialDirect.length}`);
  console.log(`[CUSTOM] Loaded candidates: ${items.length}`);
  const byChannel = collectCandidates(
    items,
    targets,
    targetConfig.maxCandidatesPerChannel || 12
  );
  console.log(`[CUSTOM] Matched target channels: ${byChannel.size}/${targets.length}`);

  const probed = await probeCandidates(byChannel, targetConfig);
  const { m3u, report, backups } = makeM3u(targets, probed, targetConfig);

  await mkdir(m3uDir, { recursive: true });
  await writeFile(path.join(m3uDir, 'custom.m3u'), m3u, 'utf-8');
  await writeFile(
    path.join(m3uDir, 'custom-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2),
    'utf-8'
  );
  await writeFile(
    path.join(m3uDir, 'custom-backups.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), channels: backups }, null, 2),
    'utf-8'
  );

  const available = report.filter((item) => item.selected).length;
  const officialSelected = report.filter((item) => item.selected?.official).length;
  const hiddenBackupCount = backups.reduce((sum, item) => sum + item.backups.length, 0);
  console.log(
    `[CUSTOM] Write custom.m3u: ${available}/${targets.length} channels, ${available} main URLs, ${officialSelected} official main URLs, ${hiddenBackupCount} hidden backup URLs`
  );
}

main().catch((error) => {
  console.error('[CUSTOM] Build custom.m3u failed:', error);
  process.exitCode = 1;
});
