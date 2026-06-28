import fs from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const officialPath = path.join(root, 'config', 'official-overrides.json');
const verifiedPath = path.join(root, 'config', 'verified-sources.json');
const foundReportPath = path.join(m3uDir, 'verified-candidates-report.json');

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function tierLabel(tier = '') {
  switch (tier) {
    case 'official':
      return '官方公开源';
    case 'telecom-distribution':
    case 'telecom-distribution-candidate':
      return '广东电信 IPTV 分发源';
    case 'mobile-distribution':
    case 'mobile-distribution-candidate':
      return '广东移动 IPTV 分发源';
    case 'unicom-distribution':
    case 'unicom-distribution-candidate':
      return '广东联通 IPTV 分发源';
    default:
      return '已确认源';
  }
}

function normalizedTier(tier = '') {
  if (tier === 'official') return 'official';
  if (tier === 'telecom-distribution-candidate') return 'telecom-distribution';
  if (tier === 'mobile-distribution-candidate') return 'mobile-distribution';
  if (tier === 'unicom-distribution-candidate') return 'unicom-distribution';
  return tier || 'verified';
}

function canPromoteTier(tier = '') {
  return ['official', 'telecom-distribution-candidate', 'mobile-distribution-candidate', 'unicom-distribution-candidate'].includes(tier);
}

function normalizeStream(stream = {}) {
  const tier = normalizedTier(stream.tier || stream.sourceTier || 'verified');
  return {
    channel: stream.channel,
    title: stream.title || `${stream.channel} ${tierLabel(tier)}`,
    provider: stream.provider || tierLabel(tier),
    page: stream.page || stream.sourcePage || '',
    url: stream.url,
    resolution: stream.resolution || '',
    quality: stream.quality || stream.qualityLabel || tierLabel(tier),
    sourceTier: tier,
    network: stream.network || '',
    notes: stream.notes || '',
  };
}

function flattenFoundCandidates(report = {}) {
  const items = [];
  for (const [channel, list] of Object.entries(report.byChannel || {})) {
    for (const item of list || []) {
      if (!canPromoteTier(item.tier)) continue;
      items.push({
        channel: item.channel || channel,
        title: item.title || `${channel} ${tierLabel(item.tier)}`,
        provider: item.sourceName || tierLabel(item.tier),
        tier: normalizedTier(item.tier),
        page: '',
        url: item.url,
        resolution: item.resolution || '',
        quality: item.qualityLabel || tierLabel(item.tier),
        network: item.tier?.includes('telecom') ? 'guangdong-telecom' : '',
        notes: `auto-promoted-from:${item.sourceName || 'verified-candidates'}; ${item.reason || ''}`,
      });
    }
  }
  return items;
}

async function main() {
  const official = readJson(officialPath, { directStreams: [] });
  const verified = readJson(verifiedPath, { streams: [] });
  const foundReport = readJson(foundReportPath, { byChannel: {} });
  const autoPromoted = flattenFoundCandidates(foundReport);
  const merged = [];
  const seen = new Set();

  for (const stream of official.directStreams || []) {
    if (!stream?.channel || !/^https?:\/\//i.test(stream.url || '')) continue;
    const key = `${stream.channel}\t${stream.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(stream);
  }

  let addedManual = 0;
  for (const stream of verified.streams || []) {
    if (!stream?.channel || !/^https?:\/\//i.test(stream.url || '')) continue;
    const normalized = normalizeStream(stream);
    const key = `${normalized.channel}\t${normalized.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
    addedManual += 1;
  }

  let addedAuto = 0;
  for (const stream of autoPromoted) {
    if (!stream?.channel || !/^https?:\/\//i.test(stream.url || '')) continue;
    const normalized = normalizeStream(stream);
    const key = `${normalized.channel}\t${normalized.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
    addedAuto += 1;
  }

  const next = {
    ...official,
    directStreams: merged,
    generatedMerge: {
      generatedAt: new Date().toISOString(),
      manualVerifiedSourceCount: (verified.streams || []).length,
      mergedManualVerifiedCount: addedManual,
      foundCandidateCount: autoPromoted.length,
      mergedFoundCandidateCount: addedAuto,
      notes: 'Build-time merge. Manual verified sources and auto-found official/IPTV distribution candidates are promoted into custom build.',
    },
  };

  await writeFile(officialPath, JSON.stringify(next, null, 2), 'utf-8');
  console.log(`[VERIFIED] Merged ${addedManual} manual verified sources and ${addedAuto} found official/IPTV candidates into official directStreams`);
}

main().catch((error) => {
  console.error('[VERIFIED] Merge verified sources failed:', error);
  process.exitCode = 1;
});
