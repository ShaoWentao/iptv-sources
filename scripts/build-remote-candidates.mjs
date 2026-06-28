import fs from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const remoteConfigPath = path.join(root, 'config', 'remote-candidate-sources.json');

const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
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
      rawLine: line,
      title: tvgName || displayName || 'Unknown',
      groupTitle,
      url,
    });
  }
  return items;
}

function classifyItem(item, filter) {
  const url = String(item.url || '').trim();
  const titleText = [item.title, item.groupTitle, item.rawLine].join(' ');
  const acceptedUrlPatterns = toRegexList(filter.acceptedUrlPatterns || []);
  const blockedUrlPatterns = toRegexList(filter.blockedUrlPatterns || []);
  const blockedTitlePatterns = toRegexList(filter.blockedTitlePatterns || []);

  if (!/^https?:\/\//i.test(url)) {
    return { accepted: false, reason: 'not-http-url' };
  }

  const blockedByUrl = blockedUrlPatterns.find((reg) => reg.test(url));
  if (blockedByUrl) {
    return { accepted: false, reason: `blocked-url-pattern:${blockedByUrl.source}` };
  }

  const blockedByTitle = blockedTitlePatterns.find((reg) => reg.test(titleText));
  if (blockedByTitle) {
    return { accepted: false, reason: `blocked-title-pattern:${blockedByTitle.source}` };
  }

  const acceptedByUrl = acceptedUrlPatterns.find((reg) => reg.test(url));
  if (!acceptedByUrl) {
    return { accepted: false, reason: 'not-direct-live-pattern' };
  }

  return { accepted: true, reason: `accepted-url-pattern:${acceptedByUrl.source}` };
}

function cleanMetaValue(value = '') {
  return String(value).replace(/"/g, '').trim();
}

async function main() {
  const config = readJson(remoteConfigPath, { sources: [], filter: {} });
  const accepted = [];
  const rejected = [];
  const seen = new Set();

  for (const source of config.sources || []) {
    const name = source.name || source.url;
    try {
      console.log(`[REMOTE] Fetch remote source: ${name}`);
      const text = await fetchText(source.url, source.timeoutMs || 10000);
      const items = parseM3u(text, name);
      console.log(`[REMOTE] Parsed ${items.length} items from ${name}`);

      for (const item of items) {
        const result = classifyItem(item, config.filter || {});
        const key = `${item.title}\t${item.url}`;
        if (result.accepted && !seen.has(key)) {
          seen.add(key);
          accepted.push({ ...item, reason: result.reason });
        } else if (!result.accepted) {
          rejected.push({ ...item, reason: result.reason });
        }
      }
    } catch (error) {
      console.log(`[REMOTE] Failed: ${name} - ${error.message}`);
      rejected.push({ sourceName: name, title: '', url: source.url, reason: error.message });
    }
  }

  const lines = [
    '#EXTM3U',
    '# Filtered remote IPTV candidates. CatVod/TVBox/VOD/API/HTML/proxy-like entries are removed before custom build.',
  ];

  for (const item of accepted) {
    const title = cleanMetaValue(item.title);
    const group = cleanMetaValue(item.groupTitle || '远程候选');
    const source = cleanMetaValue(item.sourceName);
    lines.push('');
    lines.push(`#EXTINF:-1 tvg-name="${title}" group-title="${group}" source-name="${source}",${title}`);
    lines.push(item.url);
  }

  await mkdir(m3uDir, { recursive: true });
  await writeFile(path.join(m3uDir, 'remote-candidates.m3u'), `${lines.join('\n')}\n`, 'utf-8');
  await writeFile(
    path.join(m3uDir, 'remote-candidates-report.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        acceptedCount: accepted.length,
        rejectedCount: rejected.length,
        accepted: accepted.map((item) => ({
          title: item.title,
          groupTitle: item.groupTitle,
          sourceName: item.sourceName,
          url: item.url,
          reason: item.reason,
        })),
        rejectedSamples: rejected.slice(0, 500).map((item) => ({
          title: item.title,
          groupTitle: item.groupTitle,
          sourceName: item.sourceName,
          url: item.url,
          reason: item.reason,
        })),
      },
      null,
      2
    ),
    'utf-8'
  );

  console.log(`[REMOTE] Write remote-candidates.m3u: ${accepted.length} accepted, ${rejected.length} rejected`);
}

main().catch((error) => {
  console.error('[REMOTE] Build filtered remote candidates failed:', error);
  process.exitCode = 1;
});
