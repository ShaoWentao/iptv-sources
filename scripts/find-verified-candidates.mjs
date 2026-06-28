import fs from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const targetPath = path.join(root, 'config', 'target-channels.json');
const aliasPath = path.join(root, 'config', 'channel-aliases.json');
const officialPath = path.join(root, 'config', 'official-overrides.json');

const reportPath = path.join(m3uDir, 'verified-candidates-report.json');
const playlistPath = path.join(m3uDir, 'verified-candidates.m3u');

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function attr(line, name) {
  const reg = new RegExp(`${name}="([^"]*)"`);
  return reg.exec(line)?.[1] || '';
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

function getHost(url = '') {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function trustedOfficial(url, officialConfig = {}) {
  const host = getHost(url);
  if (!host) return false;
  return (officialConfig.trustedDomains || []).some((domain) => {
    const normalized = String(domain).toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function isDirectPlayable(url = '') {
  return /^https?:\/\//i.test(url) && /(\.m3u8(\?|$)|\.m3u(\?|$)|\/PLTV\/|\/hls\/|\/live\/|m3u8)/i.test(url);
}

function classify(url = '', title = '', sourceName = '', officialConfig = {}) {
  const text = [url, title, sourceName, getHost(url)].join(' ');
  const official = trustedOfficial(url, officialConfig);
  if (official) {
    return {
      tier: 'official',
      score: 100,
      reason: 'trusted-official-domain',
    };
  }

  const telecomPatterns = [
    /chinatelecom/i,
    /telecom/i,
    /ctcc/i,
    /gdtelecom/i,
    /gdct/i,
    /ctcdn/i,
    /ctyun/i,
    /21cn/i,
    /189\.cn/i,
    /\/PLTV\//i,
    /^https?:\/\/(14\.2[0-9]\.|59\.3[2-9]\.|61\.14[0-9]\.|113\.9[6-9]\.|119\.12[0-9]\.|121\.1[0-9]\.|125\.8[8-9]\.|183\.5[6-9]\.|219\.13[0-9]\.)/i,
  ];
  if (telecomPatterns.some((reg) => reg.test(text))) {
    return {
      tier: 'telecom-distribution-candidate',
      score: 80,
      reason: 'possible-guangdong-telecom-or-pltv-distribution',
    };
  }

  const mobilePatterns = [/cmcc/i, /gmcc/i, /gdcm/i, /rrs[0-9]*\.hw\.gmcc\.net/i, /chinamobile/i];
  if (mobilePatterns.some((reg) => reg.test(text))) {
    return {
      tier: 'mobile-distribution-candidate',
      score: 60,
      reason: 'possible-guangdong-mobile-distribution',
    };
  }

  const unicomPatterns = [/cucc/i, /chinaunicom/i, /unicom/i];
  if (unicomPatterns.some((reg) => reg.test(text))) {
    return {
      tier: 'unicom-distribution-candidate',
      score: 55,
      reason: 'possible-unicom-distribution',
    };
  }

  return {
    tier: 'public-candidate',
    score: 20,
    reason: 'public-playable-candidate',
  };
}

function buildTargets(targetConfig, aliasesConfig) {
  const targets = [];
  for (const group of targetConfig.groups || []) {
    for (const channel of group.channels || []) {
      const aliases = [channel, ...(aliasesConfig[channel] || [])].map(normalizeName).filter(Boolean);
      targets.push({ name: channel, group: group.name, aliases });
    }
  }
  return targets;
}

function matchChannel(title = '', targets = []) {
  const normalized = normalizeName(title);
  if (!normalized) return null;

  let best = null;
  for (const target of targets) {
    for (const alias of target.aliases) {
      if (!alias) continue;
      let score = 0;
      if (normalized === alias) score = 1000;
      else if (normalized.includes(alias)) score = 700;
      else if (alias.includes(normalized) && normalized.length >= 3) score = 550;
      if (score > 0 && (!best || score > best.score)) {
        best = { target, score };
      }
    }
  }
  return best;
}

function parseM3u(text, sourceName, targets, officialConfig) {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const items = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('#EXTINF')) continue;
    const url = lines[i + 1] || '';
    if (!isDirectPlayable(url)) continue;

    const commaIndex = line.lastIndexOf(',');
    const displayName = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : '';
    const tvgName = attr(line, 'tvg-name');
    const groupTitle = attr(line, 'group-title');
    const title = tvgName || displayName;
    if (!title) continue;

    const matched = matchChannel(title, targets);
    if (!matched) continue;

    const classified = classify(url, title, sourceName, officialConfig);
    items.push({
      channel: matched.target.name,
      group: matched.target.group,
      title,
      displayName,
      tvgName,
      sourceName,
      sourceGroup: groupTitle,
      url,
      tier: classified.tier,
      confidenceScore: classified.score + matched.score / 100,
      reason: classified.reason,
    });
  }

  return items;
}

async function main() {
  const targetConfig = readJson(targetPath, {});
  const aliasesConfig = readJson(aliasPath, {});
  const officialConfig = readJson(officialPath, {});
  const targets = buildTargets(targetConfig, aliasesConfig);

  if (!fs.existsSync(m3uDir)) {
    console.log('[FIND] m3u directory not found, skip.');
    return;
  }

  const files = (await readdir(m3uDir)).filter((file) => file.endsWith('.m3u'));
  const all = [];
  for (const file of files) {
    if (/^(custom|custom-gd-mobile|custom-distribution-candidates|verified-candidates|catvod-direct-candidates)\.m3u$/i.test(file)) {
      continue;
    }
    try {
      const text = await readFile(path.join(m3uDir, file), 'utf-8');
      all.push(...parseM3u(text, file, targets, officialConfig));
    } catch (error) {
      console.log(`[FIND] Skip ${file}: ${error.message}`);
    }
  }

  const seen = new Set();
  const unique = [];
  for (const item of all) {
    const key = `${item.channel}\t${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  unique.sort((a, b) => b.confidenceScore - a.confidenceScore || a.channel.localeCompare(b.channel, 'zh-CN'));

  const byChannel = {};
  for (const item of unique) {
    byChannel[item.channel] ||= [];
    if (byChannel[item.channel].length < 20) byChannel[item.channel].push(item);
  }

  const lines = ['#EXTM3U'];
  for (const item of unique.slice(0, 500)) {
    lines.push('');
    lines.push(`#EXTINF:-1 tvg-name="${item.channel}" group-title="${item.group}" source-title="${String(item.title).replace(/"/g, '')}" candidate-tier="${item.tier}",${item.channel} - ${item.tier}`);
    lines.push(item.url);
  }

  await mkdir(m3uDir, { recursive: true });
  await writeFile(playlistPath, `${lines.join('\n')}\n`, 'utf-8');
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalCandidates: unique.length,
        officialCandidates: unique.filter((item) => item.tier === 'official').length,
        telecomDistributionCandidates: unique.filter((item) => item.tier === 'telecom-distribution-candidate').length,
        mobileDistributionCandidates: unique.filter((item) => item.tier === 'mobile-distribution-candidate').length,
        unicomDistributionCandidates: unique.filter((item) => item.tier === 'unicom-distribution-candidate').length,
        notes: 'This is a scouting report. Candidates are not automatically promoted into verified-sources.json.',
        byChannel,
      },
      null,
      2
    ),
    'utf-8'
  );

  console.log(`[FIND] Found ${unique.length} official/IPTV distribution candidates`);
}

main().catch((error) => {
  console.error('[FIND] Failed:', error);
  process.exitCode = 1;
});
