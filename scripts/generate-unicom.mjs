import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const input = args.input;
const secondaryInput = args['input-secondary'];
const outputDir = args.output || 'm3u';
const upstreamSha = String(args['upstream-sha'] || 'unknown');
const secondarySha = String(args['secondary-sha'] || 'unknown');

if (!input) throw new Error('Missing --input');
if (!secondaryInput) throw new Error('Missing --input-secondary');

function readText(filename) {
  return fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
}

function esc(value) {
  return String(value).replace(/"/g, "'");
}

function isUnicomIptvUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return false;
    const hostOk = /^120\.87\.\d{1,3}\.\d{1,3}$/.test(url.hostname) || url.hostname === '112.89.121.23';
    if (!hostOk) return false;
    return url.pathname.includes('/PLTV/88888973/224/') && /\.m3u8$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function qualityFromText(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (/4K|UHD|超高清/i.test(text)) return '4k';
  if (/高清|\bHD\b/i.test(text)) return 'hd';
  return 'normal';
}

const QUALITY_SCORE = { normal: 1, hd: 2, '4k': 3 };

function betterQuality(a, b) {
  return QUALITY_SCORE[a] >= QUALITY_SCORE[b] ? a : b;
}

function stripQualitySuffix(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .replace(/(?:4K\s*超高清|4K|UHD|超高清|高清)\s*$/i, '')
    .trim();
}

function canonicalSecondaryName({ tvgName, tvgId, displayName }) {
  const display = String(displayName || '').trim();
  if (/^广东4K(?:超高清)?$/i.test(display)) return '广东4K';
  return String(tvgName || tvgId || stripQualitySuffix(display)).trim();
}

function mapRegularGroup(group) {
  const value = String(group || '').trim();
  if (!value || /4K|超高清/i.test(value)) return null;
  if (/央视/.test(value)) return '央视';
  if (/卫视/.test(value)) return '卫视';
  if (/广东/.test(value)) return '广东';
  if (/地方/.test(value)) return '地方';
  if (/IPTV特色/.test(value)) return 'IPTV特色';
  if (/专业/.test(value)) return '专业';
  return value;
}

function inferGroup(name) {
  const value = String(name || '');
  if (/^(?:CCTV|CGTN)|央视/.test(value)) return '央视';
  if (/卫视$/.test(value)) return '卫视';
  if (/^(?:广东|大湾区|岭南|嘉佳|南方购物)/.test(value)) return '广东';
  return '其他';
}

function parsePrimary(text) {
  const accepted = [];
  let group = '其他';
  let parsedEntries = 0;
  let rejectedNonUnicom = 0;
  let index = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const comma = line.indexOf(',');
    if (comma < 1) continue;
    const name = line.slice(0, comma).trim();
    const value = line.slice(comma + 1).trim();
    if (value === '#genre#') {
      group = name || '其他';
      continue;
    }
    if (!/^https?:\/\//i.test(value)) continue;
    parsedEntries += 1;
    if (!isUnicomIptvUrl(value)) {
      rejectedNonUnicom += 1;
      continue;
    }
    accepted.push({
      name,
      url: value,
      source: 'xisohi',
      sourcePriority: 0,
      index: index++,
      groupCandidate: mapRegularGroup(group) || group || '其他',
      quality: qualityFromText(name, group),
    });
  }

  return { accepted, parsedEntries, rejectedNonUnicom };
}

function parseAttrs(line) {
  const attrs = {};
  for (const match of line.matchAll(/([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1].toLowerCase()] = match[2];
  }
  return attrs;
}

function parseSecondary(text) {
  const accepted = [];
  let pending = null;
  let parsedEntries = 0;
  let rejectedNonUnicom = 0;
  let index = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF:/i.test(line)) {
      const comma = line.indexOf(',');
      const attrsPart = comma >= 0 ? line.slice(0, comma) : line;
      pending = {
        attrs: parseAttrs(attrsPart),
        displayName: comma >= 0 ? line.slice(comma + 1).trim() : '',
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!pending || !/^https?:\/\//i.test(line)) {
      pending = null;
      continue;
    }

    parsedEntries += 1;
    const attrs = pending.attrs;
    const displayName = pending.displayName;
    pending = null;

    if (!isUnicomIptvUrl(line)) {
      rejectedNonUnicom += 1;
      continue;
    }

    const name = canonicalSecondaryName({
      tvgName: attrs['tvg-name'],
      tvgId: attrs['tvg-id'],
      displayName,
    });
    if (!name) continue;
    const sourceGroup = attrs['group-title'] || '其他';
    accepted.push({
      name,
      url: line,
      source: 'lu791758-hub',
      sourcePriority: 1,
      index: index++,
      groupCandidate: mapRegularGroup(sourceGroup),
      quality: qualityFromText(displayName, sourceGroup),
    });
  }

  return { accepted, parsedEntries, rejectedNonUnicom };
}

const AUTH_QUERY_PARAMS = new Set([
  'accountinfo', 'tenantid', 'guardenctype', 'rrsip', 'zoneoffset', 'servicetype',
  'icpid', 'limitflux', 'limitdur', 'sign', 't',
]);

function resourceKey(value) {
  try {
    const url = new URL(value);
    const kept = [];
    for (const [key, val] of url.searchParams.entries()) {
      if (AUTH_QUERY_PARAMS.has(key.toLowerCase())) continue;
      kept.push([key.toLowerCase(), val]);
    }
    kept.sort(([aKey, aVal], [bKey, bVal]) => aKey.localeCompare(bKey) || aVal.localeCompare(bVal));
    const query = kept.map(([key, val]) => `${key}=${val}`).join('&');
    return `${url.hostname.toLowerCase()}:${url.port || '80'}${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return value;
  }
}

const primary = parsePrimary(readText(input));
const secondary = parseSecondary(readText(secondaryInput));
const combined = [...primary.accepted, ...secondary.accepted].map((entry, index) => ({ ...entry, globalIndex: index }));

if (combined.length < 20) {
  throw new Error(`Merged Guangdong Unicom list looks incomplete: ${combined.length} accepted IPTV entries`);
}

const groupByChannel = new Map();
for (const entry of primary.accepted) {
  if (entry.groupCandidate && !groupByChannel.has(entry.name)) groupByChannel.set(entry.name, entry.groupCandidate);
}
for (const entry of secondary.accepted) {
  if (entry.groupCandidate && !groupByChannel.has(entry.name)) groupByChannel.set(entry.name, entry.groupCandidate);
}

const qualityEvidence = new Map();
for (const entry of combined) {
  const key = resourceKey(entry.url);
  qualityEvidence.set(key, betterQuality(qualityEvidence.get(key) || 'normal', entry.quality));
}
for (const entry of combined) {
  entry.quality = betterQuality(entry.quality, qualityEvidence.get(resourceKey(entry.url)) || 'normal');
  entry.group = groupByChannel.get(entry.name) || entry.groupCandidate || inferGroup(entry.name);
}

const deduped = [];
const dedupeMap = new Map();
for (const entry of combined) {
  const key = `${entry.name}\u0000${resourceKey(entry.url)}`;
  const existingIndex = dedupeMap.get(key);
  if (existingIndex === undefined) {
    dedupeMap.set(key, deduped.length);
    deduped.push(entry);
    continue;
  }
  const existing = deduped[existingIndex];
  existing.quality = betterQuality(existing.quality, entry.quality);
  if (entry.sourcePriority < existing.sourcePriority) deduped[existingIndex] = { ...entry, quality: existing.quality };
}

const channelOrder = new Map();
for (const entry of deduped) {
  if (!channelOrder.has(entry.name)) channelOrder.set(entry.name, channelOrder.size);
}

const buckets = new Map();
for (const entry of deduped) {
  if (!buckets.has(entry.name)) buckets.set(entry.name, []);
  buckets.get(entry.name).push(entry);
}
for (const items of buckets.values()) {
  items.sort((a, b) =>
    QUALITY_SCORE[b.quality] - QUALITY_SCORE[a.quality]
    || a.sourcePriority - b.sourcePriority
    || a.globalIndex - b.globalIndex
    || a.url.localeCompare(b.url)
  );
}

const defaultGroupOrder = ['央视', '卫视', '广东', '地方', 'IPTV特色', '专业', '其他'];
const discoveredGroups = [];
for (const [name, items] of buckets) {
  const group = items[0]?.group || inferGroup(name);
  if (!defaultGroupOrder.includes(group) && !discoveredGroups.includes(group)) discoveredGroups.push(group);
}
const regularGroupOrder = [...defaultGroupOrder, ...discoveredGroups];
const groupRank = new Map(regularGroupOrder.map((group, index) => [group, index]));

const channelNames = [...buckets.keys()].sort((a, b) => {
  const aGroup = buckets.get(a)[0]?.group || inferGroup(a);
  const bGroup = buckets.get(b)[0]?.group || inferGroup(b);
  return (groupRank.get(aGroup) ?? 999) - (groupRank.get(bGroup) ?? 999)
    || channelOrder.get(a) - channelOrder.get(b);
});

const regularEntries = [];
const simpleRegular = [];
const fourKEntries = [];
const simpleFourK = [];
for (const name of channelNames) {
  const items = buckets.get(name);
  regularEntries.push(...items);
  simpleRegular.push(items[0]);
  const ultra = items.filter((item) => item.quality === '4k');
  if (!ultra.length) continue;
  const displayName = /4K$/i.test(name) ? name : `${name}4K`;
  const tvgId = /4K$/i.test(name) ? `${name}-4K分组` : displayName;
  const clones = ultra.map((item) => ({
    ...item,
    name: displayName,
    group: '4K超高清',
    tvgId,
    tvgName: name,
  }));
  fourKEntries.push(...clones);
  simpleFourK.push(clones[0]);
}

function render(items) {
  const out = [
    '#EXTM3U',
    '# Generated from merged Guangdong Unicom IPTV unicast sources',
    `# Primary upstream commit: ${upstreamSha}`,
    `# Secondary upstream commit: ${secondarySha}`,
  ];
  for (const item of items) {
    const tvgId = item.tvgId ? ` tvg-id="${esc(item.tvgId)}"` : '';
    const tvgName = item.tvgName || item.name;
    out.push(`#EXTINF:-1${tvgId} tvg-name="${esc(tvgName)}" group-title="${esc(item.group)}",${item.name}`);
    out.push(item.url);
  }
  return `${out.join('\n')}\n`;
}

fs.mkdirSync(outputDir, { recursive: true });
const primaryItems = [...fourKEntries, ...regularEntries];
const simpleItems = [...simpleFourK, ...simpleRegular];
fs.writeFileSync(path.join(outputDir, 'gd-unicom.m3u'), render(primaryItems));
fs.writeFileSync(path.join(outputDir, 'gd-unicom-simple.m3u'), render(simpleItems));

const groups = { '4K超高清': simpleFourK.length };
for (const item of simpleRegular) groups[item.group] = (groups[item.group] || 0) + 1;

const report = {
  schemaVersion: 3,
  upstreams: [
    {
      repository: 'xisohi/CHINA-IPTV',
      file: 'Unicast/guangdong/unicom.txt',
      sha: upstreamSha,
      parsedEntries: primary.parsedEntries,
      acceptedEntries: primary.accepted.length,
      rejectedNonUnicom: primary.rejectedNonUnicom,
    },
    {
      repository: 'lu791758-hub/GDIPTV',
      file: 'tv.m3u',
      sha: secondarySha,
      parsedEntries: secondary.parsedEntries,
      acceptedEntries: secondary.accepted.length,
      rejectedNonUnicom: secondary.rejectedNonUnicom,
    },
  ],
  upstreamEntries: combined.length,
  filteredNonUnicom: primary.rejectedNonUnicom + secondary.rejectedNonUnicom,
  deduplicatedEntries: combined.length - deduped.length,
  selectedChannels: buckets.size,
  selectedLines: regularEntries.length,
  alternateEntries: regularEntries.length - buckets.size,
  fourKChannels: simpleFourK.length,
  fourKLines: fourKEntries.length,
  renderedPrimaryEntries: primaryItems.length,
  groups,
  primaryPlaylistMode: 'merged-all-lines-plus-4k-group',
  simplePlaylistMode: 'best-line-per-channel-plus-4k-group',
  qualityOrder: ['4k', 'hd', 'normal'],
  allowedIptvHosts: ['120.87.0.0/16', '112.89.121.23'],
  note: 'Only Guangdong Unicom PLTV unicast URLs are retained. Stream reachability is network-dependent and is not tested by GitHub Actions.',
};
fs.writeFileSync(path.join(outputDir, 'gd-unicom-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
