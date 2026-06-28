import fs from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const officialPath = path.join(root, 'config', 'official-overrides.json');
const verifiedPath = path.join(root, 'config', 'verified-sources.json');

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function tierLabel(tier = '') {
  switch (tier) {
    case 'official':
      return '官方公开源';
    case 'telecom-distribution':
      return '广东电信 IPTV 分发源';
    case 'mobile-distribution':
      return '广东移动 IPTV 分发源';
    case 'unicom-distribution':
      return '广东联通 IPTV 分发源';
    default:
      return '已确认源';
  }
}

function normalizeStream(stream = {}) {
  const tier = stream.tier || stream.sourceTier || 'verified';
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

async function main() {
  const official = readJson(officialPath, { directStreams: [] });
  const verified = readJson(verifiedPath, { streams: [] });
  const merged = [];
  const seen = new Set();

  for (const stream of official.directStreams || []) {
    if (!stream?.channel || !/^https?:\/\//i.test(stream.url || '')) continue;
    const key = `${stream.channel}\t${stream.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(stream);
  }

  let added = 0;
  for (const stream of verified.streams || []) {
    if (!stream?.channel || !/^https?:\/\//i.test(stream.url || '')) continue;
    const normalized = normalizeStream(stream);
    const key = `${normalized.channel}\t${normalized.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
    added += 1;
  }

  const next = {
    ...official,
    directStreams: merged,
    generatedMerge: {
      generatedAt: new Date().toISOString(),
      verifiedSourceCount: (verified.streams || []).length,
      mergedVerifiedCount: added,
      notes: 'Build-time merge only. verified-sources.json is the manual registry for official and IPTV distribution sources.',
    },
  };

  await writeFile(officialPath, JSON.stringify(next, null, 2), 'utf-8');
  console.log(`[VERIFIED] Merged ${added} verified sources into official directStreams`);
}

main().catch((error) => {
  console.error('[VERIFIED] Merge verified sources failed:', error);
  process.exitCode = 1;
});
