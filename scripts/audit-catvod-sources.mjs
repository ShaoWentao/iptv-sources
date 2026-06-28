import fs from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const configPath = path.join(root, 'config', 'catvod-audit-sources.json');
const privateConfigPath = path.join(root, 'config', 'catvod-audit-private.json');
const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function mergeConfig(publicConfig, privateConfig) {
  return {
    ...publicConfig,
    ...privateConfig,
    sources: [...(publicConfig.sources || []), ...(privateConfig.sources || [])],
    classification: {
      ...(publicConfig.classification || {}),
      ...(privateConfig.classification || {}),
    },
  };
}

function redactUrl(url = '') {
  return String(url)
    .replace(/([?&](?:tk|token)=)[^&]+/gi, '$1***')
    .replace(/([?&](?:key|auth|sign|sig)=)[^&]+/gi, '$1***');
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
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), contentType, finalUrl: res.url };
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
    items.push({
      sourceName,
      title: tvgName || displayName || 'Unknown',
      groupTitle,
      url,
      rawLine: line,
    });
  }
  return items;
}

function classify(item, config) {
  const url = String(item.url || '').trim();
  const text = [item.title, item.groupTitle, item.rawLine, url].join(' ');
  const directPatterns = toRegexList(config.classification?.directLivePatterns || []);
  const blockedPatterns = toRegexList(config.classification?.blockedPatterns || []);

  if (!/^https?:\/\//i.test(url)) return { type: 'invalid', usable: false, reason: 'not-http-url' };

  const blocked = blockedPatterns.find((reg) => reg.test(text));
  if (blocked) return { type: 'catvod-or-vod-config', usable: false, reason: `blocked-pattern:${blocked.source}` };

  const direct = directPatterns.find((reg) => reg.test(url));
  if (direct) return { type: 'direct-live-candidate', usable: true, reason: `direct-pattern:${direct.source}` };

  return { type: 'unknown-or-proxy', usable: false, reason: 'not-direct-live-pattern' };
}

function cleanMetaValue(value = '') {
  return String(value).replace(/"/g, '').trim();
}

async function main() {
  const publicConfig = readJson(configPath, { sources: [], classification: {} });
  const privateConfig = readJson(privateConfigPath, { sources: [] });
  const config = mergeConfig(publicConfig, privateConfig);
  const report = [];
  const directCandidates = [];

  if (fs.existsSync(privateConfigPath)) {
    console.log('[CATVOD] Loaded private token sources from config/catvod-audit-private.json');
  }

  for (const source of config.sources || []) {
    const sourceReport = {
      name: source.name,
      url: source.private ? redactUrl(source.url) : source.url,
      ok: false,
      contentType: '',
      finalUrl: '',
      total: 0,
      counts: {},
      items: [],
      error: '',
      private: Boolean(source.private),
    };

    try {
      console.log(`[CATVOD] Fetch: ${source.name} ${source.private ? redactUrl(source.url) : source.url}`);
      const { text, contentType, finalUrl } = await fetchText(source.url, source.timeoutMs || 10000);
      const items = parseM3u(text, source.name);
      sourceReport.ok = true;
      sourceReport.contentType = contentType;
      sourceReport.finalUrl = source.private ? redactUrl(finalUrl) : finalUrl;
      sourceReport.total = items.length;

      for (const item of items) {
        const result = classify(item, config);
        sourceReport.counts[result.type] = (sourceReport.counts[result.type] || 0) + 1;
        const row = {
          title: item.title,
          groupTitle: item.groupTitle,
          url: item.url,
          type: result.type,
          usable: result.usable,
          reason: result.reason,
        };
        sourceReport.items.push(row);
        if (result.usable) directCandidates.push({ ...row, sourceName: source.name });
      }
    } catch (error) {
      sourceReport.error = error.message;
      console.log(`[CATVOD] Failed: ${source.name} - ${error.message}`);
    }

    report.push(sourceReport);
  }

  const lines = [
    '#EXTM3U',
    '# CatVod audit direct-live candidates only. This file is for manual review, not for automatic official playlist use.',
  ];

  for (const item of directCandidates) {
    const title = cleanMetaValue(item.title);
    const group = cleanMetaValue(item.groupTitle || 'CatVod审计候选');
    const source = cleanMetaValue(item.sourceName);
    lines.push('');
    lines.push(`#EXTINF:-1 tvg-name="${title}" group-title="${group}" source-name="${source}",${title}`);
    lines.push(item.url);
  }

  await mkdir(m3uDir, { recursive: true });
  await writeFile(path.join(m3uDir, 'catvod-audit-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2), 'utf-8');
  await writeFile(path.join(m3uDir, 'catvod-direct-candidates.m3u'), `${lines.join('\n')}\n`, 'utf-8');

  console.log(`[CATVOD] Write catvod-audit-report.json`);
  console.log(`[CATVOD] Write catvod-direct-candidates.m3u: ${directCandidates.length} direct candidates`);
}

main().catch((error) => {
  console.error('[CATVOD] Audit failed:', error);
  process.exitCode = 1;
});
