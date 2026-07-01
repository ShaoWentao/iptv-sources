import fs from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const officialPath = path.join(root, 'config', 'official-overrides.json');
const verifiedPath = path.join(root, 'config', 'verified-sources.json');
const yangshipinPath = path.join(root, 'config', 'yangshipin-webview-candidates.json');
const foundReportPath = path.join(m3uDir, 'verified-candidates-report.json');

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function isPlayableUrl(url = '') {
  return /^(webview:\/\/)?https?:\/\//i.test(String(url || ''));
}

function tierLabel(tier = '') {
  switch (tier) {
    case 'official':
    case 'official-webview':
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
  if (tier === 'official-webview') return 'official-webview';
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

function shouldPromoteDiscoveredCandidates(verified = {}) {
  return verified?.mergePolicy?.autoPromoteDiscoveredCandidates === true;
}

function flattenFoundCandidates(report = {}, enabled = false) {
  if (!enabled) return [];

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

function flattenYangshipinMappings(config = {}) {
  const enabled = config?.status === 'channel-pid-mappings-confirmed' || config?.mergePolicy?.includeConfirmedMappings === true;
  if (!enabled) return [];

  const items = [];
  for (const item of config.confirmedChannelMappings || []) {
    if (!item?.channel || !item?.pid) continue;
    const page = item.page || `https://www.yangshipin.cn/tv/home?pid=${item.pid}`;
    items.push({
      channel: item.channel,
      title: item.title || `${item.name || item.channel} 央视频官方 WebView`,
      provider: item.provider || 'Yangshipin/CMG',
      tier: 'official-webview',
      page,
      url: item.url || `webview://${page}`,
      quality: 'WebView',
      notes: item.notes || `央视频官方频道页 pid=${item.pid}。`,
    });
  }
  return items;
}

function isGeneratedCandidate(stream = {}) {
  const notes = String(stream.notes || '');
  const provider = String(stream.provider || '');
  return /auto-promoted-from:/i.test(notes) || /verified-candidates/i.test(provider);
}

async function main() {
  const official = readJson(officialPath, { directStreams: [] });
  const verified = readJson(verifiedPath, { streams: [] });
  const yangshipin = readJson(yangshipinPath, { confirmedChannelMappings: [] });
  const foundReport = readJson(foundReportPath, { byChannel: {} });
  const autoPromoteEnabled = shouldPromoteDiscoveredCandidates(verified);
  const yangshipinStreams = flattenYangshipinMappings(yangshipin);
  const autoPromoted = flattenFoundCandidates(foundReport, autoPromoteEnabled);
  const merged = [];
  const seen = new Set();

  for (const stream of official.directStreams || []) {
    if (!stream?.channel || !isPlayableUrl(stream.url) || isGeneratedCandidate(stream)) continue;
    const key = `${stream.channel}\t${stream.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(stream);
  }

  let addedManual = 0;
  for (const stream of verified.streams || []) {
    if (!stream?.channel || !isPlayableUrl(stream.url)) continue;
    const normalized = normalizeStream(stream);
    const key = `${normalized.channel}\t${normalized.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
    addedManual += 1;
  }

  let addedYangshipin = 0;
  for (const stream of yangshipinStreams) {
    if (!stream?.channel || !isPlayableUrl(stream.url)) continue;
    const normalized = normalizeStream(stream);
    const key = `${normalized.channel}\t${normalized.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
    addedYangshipin += 1;
  }

  let addedAuto = 0;
  for (const stream of autoPromoted) {
    if (!stream?.channel || !isPlayableUrl(stream.url)) continue;
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
      yangshipinConfirmedMappingCount: yangshipinStreams.length,
      mergedYangshipinMappingCount: addedYangshipin,
      autoPromoteDiscoveredCandidates: autoPromoteEnabled,
      foundCandidateCount: autoPromoted.length,
      mergedFoundCandidateCount: addedAuto,
      notes: 'Build-time merge. Manual official sources and confirmed Yangshipin WebView pid mappings are promoted. Auto-found IPTV/distribution candidates stay in reports unless verified-sources.mergePolicy.autoPromoteDiscoveredCandidates is true. WebView sources use webview://https://... scheme.',
    },
  };

  await writeFile(officialPath, JSON.stringify(next, null, 2), 'utf-8');
  console.log(`[VERIFIED] Merged ${addedManual} manual verified sources, ${addedYangshipin} Yangshipin WebView mappings and ${addedAuto} auto-found candidates into official directStreams`);
}

main().catch((error) => {
  console.error('[VERIFIED] Merge verified sources failed:', error);
  process.exitCode = 1;
});
