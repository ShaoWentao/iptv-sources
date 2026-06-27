import fs from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const targetPath = path.join(root, 'config', 'target-channels.json');
const aliasPath = path.join(root, 'config', 'channel-aliases.json');
const candidatePath = path.join(root, 'config', 'candidate-sources.json');

const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

function readJson(file) {
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

function parseM3u(text, sourceName) {
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
    items.push({ title, displayName, tvgName, groupTitle, url, sourceName });
  }
  return items;
}

async function loadLocalM3uFiles() {
  if (!fs.existsSync(m3uDir)) return [];
  const files = (await readdir(m3uDir)).filter(
    (file) => file.endsWith('.m3u') && file !== 'custom.m3u'
  );
  const items = [];
  for (const file of files) {
    const fullPath = path.join(m3uDir, file);
    const text = await readFile(fullPath, 'utf-8');
    items.push(...parseM3u(text, file));
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

async function loadRemoteM3u(remoteM3u = []) {
  const items = [];
  for (const source of remoteM3u) {
    const name = source.name || source.url;
    try {
      console.log(`[CUSTOM] Fetch remote candidate: ${name}`);
      const text = await fetchText(source.url, source.timeoutMs || 8000);
      items.push(...parseM3u(text, name));
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

function collectCandidates(items, targets, maxCandidatesPerChannel) {
  const byChannel = new Map();
  const seen = new Set();

  for (const item of items) {
    const matched = matchTarget(item, targets);
    if (!matched) continue;
    const key = `${matched.target.name}\t${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const list = byChannel.get(matched.target.name) || [];
    list.push({ ...item, target: matched.target, matchScore: matched.score });
    byChannel.set(matched.target.name, list);
  }

  for (const [name, list] of byChannel) {
    list.sort((a, b) => b.matchScore - a.matchScore || a.url.length - b.url.length);
    byChannel.set(name, list.slice(0, maxCandidatesPerChannel));
  }
  return byChannel;
}

async function probeUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let bytes = 0;
  let sample = '';

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Range: 'bytes=0-4095',
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
          sample = new TextDecoder().decode(chunk.value.slice(0, 4096));
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
    const resolution = sample.match(/RESOLUTION=(\d+x\d+)/)?.[1] || '';
    const isM3u8 = /mpegurl|m3u8|vnd\.apple/i.test(contentType) || sample.includes('#EXTM3U');
    const score =
      100000 -
      latencyMs * 20 +
      Math.min(bandwidth / 1000, 8000) +
      (isM3u8 ? 1200 : 0) +
      (resolution ? 800 : 0) +
      Math.min(bytes, 4096) / 8;

    return { ok: true, latencyMs, contentType, bandwidth, resolution, score };
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
    const result = await probeUrl(item.url, probe.timeoutMs || 2000);
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
      const delta = (b.probe?.score || 0) - (a.probe?.score || 0);
      if (delta !== 0) return delta;
      return (a.probe?.latencyMs || 99999) - (b.probe?.latencyMs || 99999);
    });
    next.set(name, list);
  }

  return next;
}

function makeM3u(targets, byChannel, targetConfig) {
  const epgUrl = targetConfig.epgUrl || '';
  const lines = [`#EXTM3U${epgUrl ? ` x-tvg-url="${epgUrl}"` : ''}`];
  const maxAlternates = targetConfig.maxAlternatesPerChannel || 4;
  const report = [];

  for (const target of targets) {
    const list = (byChannel.get(target.name) || []).slice(0, maxAlternates);
    report.push({
      name: target.name,
      group: target.group,
      count: list.length,
      sources: list.map((item, index) => ({
        order: index + 1,
        title: item.title,
        sourceName: item.sourceName,
        latencyMs: item.probe?.latencyMs,
        resolution: item.probe?.resolution,
        bandwidth: item.probe?.bandwidth,
        url: item.url,
      })),
    });

    list.forEach((item, index) => {
      const displayName = index === 0 ? target.name : `${target.name} 备用${index}`;
      const title = item.title ? item.title.replace(/"/g, '') : target.name;
      const resolution = item.probe?.resolution ? ` resolution="${item.probe.resolution}"` : '';
      const latency = item.probe?.latencyMs ? ` latency="${item.probe.latencyMs}ms"` : '';
      lines.push('');
      lines.push(
        `#EXTINF:-1 tvg-name="${target.name}" group-title="${target.group}" source-title="${title}"${resolution}${latency},${displayName}`
      );
      lines.push(item.url);
    });
  }

  return { m3u: `${lines.join('\n')}\n`, report };
}

async function main() {
  const targetConfig = readJson(targetPath);
  const aliasesConfig = readJson(aliasPath);
  const candidateConfig = readJson(candidatePath);
  const targets = buildTargets(targetConfig, aliasesConfig);

  const items = [];
  if (candidateConfig.includeGeneratedM3u !== false) {
    items.push(...(await loadLocalM3uFiles()));
  }
  items.push(...(await loadRemoteM3u(candidateConfig.remoteM3u || [])));

  console.log(`[CUSTOM] Loaded candidates: ${items.length}`);
  const byChannel = collectCandidates(
    items,
    targets,
    targetConfig.maxCandidatesPerChannel || 6
  );
  console.log(`[CUSTOM] Matched target channels: ${byChannel.size}/${targets.length}`);

  const probed = await probeCandidates(byChannel, targetConfig);
  const { m3u, report } = makeM3u(targets, probed, targetConfig);

  await mkdir(m3uDir, { recursive: true });
  await writeFile(path.join(m3uDir, 'custom.m3u'), m3u, 'utf-8');
  await writeFile(
    path.join(m3uDir, 'custom-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2),
    'utf-8'
  );

  const available = report.filter((item) => item.count > 0).length;
  const urls = report.reduce((sum, item) => sum + item.count, 0);
  console.log(`[CUSTOM] Write custom.m3u: ${available}/${targets.length} channels, ${urls} playable URLs`);
}

main().catch((error) => {
  console.error('[CUSTOM] Build custom.m3u failed:', error);
  process.exitCode = 1;
});
