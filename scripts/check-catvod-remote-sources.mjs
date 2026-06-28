import fs from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const remoteConfigPath = path.join(root, 'config', 'remote-candidate-sources.json');
const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function redactUrl(url = '') {
  return String(url)
    .replace(/([?&](?:tk|token)=)[^&]+/gi, '$1***')
    .replace(/([?&](?:key|auth|sign|sig)=)[^&]+/gi, '$1***');
}

function parseEnvSources() {
  const raw = process.env.CATVOD_REMOTE_SOURCES || process.env.CATVOD_REMOTE_URLS || '';
  if (!raw.trim()) return [];

  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .map((item, index) => {
        if (typeof item === 'string') {
          return { name: `CatVod private source ${index + 1}`, url: item, timeoutMs: 12000, private: true };
        }
        return {
          name: item.name || `CatVod private source ${index + 1}`,
          url: item.url,
          timeoutMs: item.timeoutMs || 12000,
          private: true,
        };
      })
      .filter((item) => /^https?:\/\//i.test(item.url || ''));
  } catch {
    return raw
      .split(/[\n,]+/)
      .map((url, index) => ({ name: `CatVod private source ${index + 1}`, url: url.trim(), timeoutMs: 12000, private: true }))
      .filter((item) => /^https?:\/\//i.test(item.url || ''));
  }
}

function toRegexList(values = []) {
  return values.map((value) => new RegExp(value, 'i'));
}

function attr(line, name) {
  const reg = new RegExp(`${name}="([^"]*)"`);
  return reg.exec(line)?.[1] || '';
}

async function fetchText(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    const latencyMs = Math.round(performance.now() - started);
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, text: await res.text(), contentType, finalUrl: res.url, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

function parseM3u(text, sourceName) {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('#EXTINF')) continue;
    const url = lines[i + 1] || '';
    const commaIndex = line.lastIndexOf(',');
    const displayName = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : '';
    const tvgName = attr(line, 'tvg-name');
    const groupTitle = attr(line, 'group-title');
    items.push({ sourceName, title: tvgName || displayName || 'Unknown', groupTitle, url, rawLine: line });
  }
  return items;
}

function classifyItem(item, filter) {
  const url = String(item.url || '').trim();
  const titleText = [item.title, item.groupTitle, item.rawLine].join(' ');
  const acceptedUrlPatterns = toRegexList(filter.acceptedUrlPatterns || []);
  const blockedUrlPatterns = toRegexList(filter.blockedUrlPatterns || []);
  const blockedTitlePatterns = toRegexList(filter.blockedTitlePatterns || []);

  if (!/^https?:\/\//i.test(url)) return { accepted: false, reason: 'not-http-url' };

  const blockedByUrl = blockedUrlPatterns.find((reg) => reg.test(url));
  if (blockedByUrl) return { accepted: false, reason: `blocked-url-pattern:${blockedByUrl.source}` };

  const blockedByTitle = blockedTitlePatterns.find((reg) => reg.test(titleText));
  if (blockedByTitle) return { accepted: false, reason: `blocked-title-pattern:${blockedByTitle.source}` };

  const acceptedByUrl = acceptedUrlPatterns.find((reg) => reg.test(url));
  if (!acceptedByUrl) return { accepted: false, reason: 'not-direct-live-pattern' };

  return { accepted: true, reason: `accepted-url-pattern:${acceptedByUrl.source}` };
}

async function probeUrl(url, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let sample = '';

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-8191' },
    });
    const latencyMs = Math.round(performance.now() - started);
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok && res.status !== 206) return { ok: false, latencyMs, reason: `HTTP ${res.status}` };

    const reader = res.body?.getReader?.();
    if (reader) {
      try {
        const chunk = await reader.read();
        if (chunk.value) sample = new TextDecoder().decode(chunk.value.slice(0, 8192));
      } finally {
        try { await reader.cancel(); } catch {}
      }
    }

    const isM3u8 = /mpegurl|m3u8|vnd\.apple/i.test(contentType) || sample.includes('#EXTM3U');
    const isMediaLike = /video|mpeg|octet-stream/i.test(contentType);
    return {
      ok: isM3u8 || isMediaLike,
      latencyMs,
      contentType,
      reason: isM3u8 || isMediaLike ? 'playable-response' : 'not-media-response',
    };
  } catch (error) {
    return { ok: false, latencyMs: timeoutMs, reason: error.name || error.message };
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

function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.floor(list.length / 2)];
}

async function checkSource(source, filter, options) {
  const fetchRounds = [];
  const acceptedByUrl = new Map();
  const rejectedReasons = {};

  for (let round = 0; round < options.rounds; round += 1) {
    try {
      const fetched = await fetchText(source.url, source.timeoutMs || 12000);
      const items = parseM3u(fetched.text, source.name);
      let acceptedCount = 0;
      let rejectedCount = 0;

      for (const item of items) {
        const result = classifyItem(item, filter);
        if (result.accepted) {
          acceptedCount += 1;
          if (!acceptedByUrl.has(item.url)) acceptedByUrl.set(item.url, { ...item, reason: result.reason });
        } else {
          rejectedCount += 1;
          rejectedReasons[result.reason] = (rejectedReasons[result.reason] || 0) + 1;
        }
      }

      fetchRounds.push({
        ok: true,
        latencyMs: fetched.latencyMs,
        contentType: fetched.contentType,
        finalUrl: redactUrl(fetched.finalUrl),
        total: items.length,
        acceptedCount,
        rejectedCount,
      });
    } catch (error) {
      fetchRounds.push({ ok: false, latencyMs: source.timeoutMs || 12000, error: error.message });
    }
  }

  const acceptedList = [...acceptedByUrl.values()].slice(0, options.maxProbeUrls);
  const probes = await mapLimit(acceptedList, options.concurrency, async (item) => ({
    title: item.title,
    groupTitle: item.groupTitle,
    url: item.url,
    reason: item.reason,
    probe: await probeUrl(item.url, options.probeTimeoutMs),
  }));

  const fetchOkCount = fetchRounds.filter((item) => item.ok).length;
  const probeOkCount = probes.filter((item) => item.probe.ok).length;
  const fetchSuccessRate = options.rounds ? fetchOkCount / options.rounds : 0;
  const probeSuccessRate = probes.length ? probeOkCount / probes.length : 0;
  const acceptedCounts = fetchRounds.filter((item) => item.ok).map((item) => item.acceptedCount || 0);
  const latencies = fetchRounds.filter((item) => item.ok).map((item) => item.latencyMs || 0);

  const stableEnough = fetchSuccessRate >= 0.67 && median(acceptedCounts) > 0 && probeSuccessRate >= 0.5;

  return {
    name: source.name,
    url: redactUrl(source.url),
    rounds: fetchRounds,
    summary: {
      fetchOkCount,
      fetchRounds: options.rounds,
      fetchSuccessRate,
      medianFetchLatencyMs: median(latencies),
      uniqueDirectCandidates: acceptedByUrl.size,
      medianAcceptedCount: median(acceptedCounts),
      probedCount: probes.length,
      probeOkCount,
      probeSuccessRate,
      stableEnough,
      recommendation: stableEnough ? 'can-test-merge-manually' : 'keep-audit-only',
    },
    rejectedReasons,
    probeSamples: probes.slice(0, 100),
  };
}

async function main() {
  const config = readJson(remoteConfigPath, { filter: {} });
  const sources = parseEnvSources();
  const options = {
    rounds: Number(process.env.CATVOD_CHECK_ROUNDS || 3),
    maxProbeUrls: Number(process.env.CATVOD_CHECK_MAX_PROBE || 80),
    concurrency: Number(process.env.CATVOD_CHECK_CONCURRENCY || 16),
    probeTimeoutMs: Number(process.env.CATVOD_CHECK_PROBE_TIMEOUT_MS || 3500),
  };

  await mkdir(m3uDir, { recursive: true });

  if (!sources.length) {
    await writeFile(
      path.join(m3uDir, 'catvod-token-check-report.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), sourceCount: 0, message: 'No CATVOD_REMOTE_SOURCES configured.' }, null, 2),
      'utf-8'
    );
    console.log('[CATVOD-CHECK] No CATVOD_REMOTE_SOURCES configured.');
    return;
  }

  console.log(`[CATVOD-CHECK] Checking ${sources.length} private CatVod sources`);
  const reports = [];
  for (const source of sources) {
    console.log(`[CATVOD-CHECK] Check source: ${source.name} ${redactUrl(source.url)}`);
    reports.push(await checkSource(source, config.filter || {}, options));
  }

  await writeFile(
    path.join(m3uDir, 'catvod-token-check-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), options, sourceCount: sources.length, reports }, null, 2),
    'utf-8'
  );

  const usableCount = reports.filter((item) => item.summary.stableEnough).length;
  console.log(`[CATVOD-CHECK] Write catvod-token-check-report.json: ${usableCount}/${reports.length} sources can test merge manually`);
}

main().catch((error) => {
  console.error('[CATVOD-CHECK] Check failed:', error);
  process.exitCode = 1;
});
