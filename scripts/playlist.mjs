import crypto from 'node:crypto';

export const GROUP_ORDER = [
  '央视', '卫视', '广东', '地方', '体育', '少儿', '电影电视剧', '纪录科教', '4K超高清', '其他',
];

const MULTICAST_RE = /^(?:rtp|udp):\/\/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\/?$/i;
const UDPXY_RE = /^https?:\/\/[^/]+\/udp\/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\/?$/i;
const GENERIC_TVG_NAMES = new Set(['睛彩']);

function parseAttributes(line) {
  const attrs = {};
  const prefix = line.includes(',') ? line.slice(0, line.indexOf(',')) : line;
  for (const match of prefix.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
}

function isMulticast(ip) {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] >= 224 && parts[0] <= 239;
}

export function canonicalRtpUrl(value) {
  const match = String(value || '').trim().match(MULTICAST_RE) || String(value || '').trim().match(UDPXY_RE);
  if (!match) return null;
  const [, ip, rawPort] = match;
  const port = Number(rawPort);
  if (!isMulticast(ip) || port < 1 || port > 65535) return null;
  return `rtp://${ip}:${port}`;
}

export function parsePlaylist(text) {
  const entries = [];
  let pending = null;
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const attrs = parseAttributes(line);
      const comma = line.indexOf(',');
      pending = {
        name: comma >= 0 ? line.slice(comma + 1).trim() : '',
        tvgName: String(attrs['tvg-name'] || '').trim(),
        tvgId: String(attrs['tvg-id'] || '').trim(),
        tvgLogo: String(attrs['tvg-logo'] || '').trim(),
        sourceGroup: String(attrs['group-title'] || '').trim(),
      };
      continue;
    }
    if (!line.startsWith('#') && pending) {
      entries.push({ ...pending, url: line, rtpUrl: canonicalRtpUrl(line), index: entries.length });
      pending = null;
    }
  }
  return entries;
}

export function filterEntries(entries) {
  const stats = { cavs: 0, timeshift: 0, nonChannel: 0, invalid: 0, duplicateUrl: 0 };
  const kept = [];
  const seen = new Set();
  for (const entry of entries) {
    const label = `${entry.name || ''} ${entry.tvgName || ''}`;
    if (/CAVS/i.test(label)) { stats.cavs += 1; continue; }
    if (/时移|回看/i.test(label)) { stats.timeshift += 1; continue; }
    if (/^\s*Unknown@/i.test(label) || /IPTV广告|测试卡|无节目/i.test(label)) { stats.nonChannel += 1; continue; }
    const rtpUrl = entry.rtpUrl || canonicalRtpUrl(entry.url);
    if (!rtpUrl) { stats.invalid += 1; continue; }
    if (seen.has(rtpUrl)) { stats.duplicateUrl += 1; continue; }
    seen.add(rtpUrl);
    kept.push({ ...entry, rtpUrl });
  }
  return { entries: kept, stats };
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').replace(/[—–－_]+/g, '-').replace(/\s+/g, ' ').trim();
}

function preserveDedicatedQualityChannel(value) {
  const compact = String(value || '').replace(/\s+/g, '').toUpperCase();
  if (/^CCTV-?4K$/.test(compact)) return 'CCTV-4K';
  if (/^CCTV-?8K$/.test(compact)) return 'CCTV-8K';
  if (/^广东4K$/.test(compact)) return '广东4K';
  return null;
}

function cleanIdentity(value) {
  let text = normalizeText(value);
  const dedicated = preserveDedicatedQualityChannel(text);
  if (dedicated) return dedicated;
  text = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/(?:8K|4K)(?:超高清|超清|高清|超)?|UHD|超高清|超清|高清|\bHD\b|标清|\bSD\b/gi, ' ')
    .replace(/\b(?:CAVS|AVS2|AVS\+?|HEVC|H\.265|H\.264|MPEG-?2|MPEG-?4)\b/gi, ' ')
    .replace(/(?:25|30|50|60)P/gi, ' ')
    .replace(/宽色域|窄色域|备用|主用|测试|开机|信号/gi, ' ')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/^CCTV\s*-?\s*(\d{1,2})(\+)?(?:\s*频道)?$/i, (_, n, plus = '') => `CCTV-${Number(n)}${plus}`);
  text = text.replace(/^CCTV(\d{1,2})(\+)?$/i, (_, n, plus = '') => `CCTV-${Number(n)}${plus}`);
  text = text.replace(/^CETV\s*-?\s*(\d+)$/i, (_, n) => `CETV-${Number(n)}`);
  return text.replace(/\s+/g, '') || normalizeText(value);
}

export function normalizeChannelName(entry) {
  const tvg = normalizeText(entry?.tvgName);
  const name = normalizeText(entry?.name);
  const dedicated = preserveDedicatedQualityChannel(tvg) || preserveDedicatedQualityChannel(name);
  if (dedicated) return dedicated;
  if (GENERIC_TVG_NAMES.has(tvg)) {
    const display = cleanIdentity(name);
    if (display.startsWith(tvg) && display.length > tvg.length) return display;
  }
  return cleanIdentity(tvg || name);
}

export function buildQualityEvidence(playlists = {}) {
  const evidence = new Map();
  const add = (entries, tag) => {
    for (const entry of entries || []) {
      const url = entry.rtpUrl || canonicalRtpUrl(entry.url);
      if (!url) continue;
      if (!evidence.has(url)) evidence.set(url, new Set());
      evidence.get(url).add(tag);
    }
  };
  add(playlists.hd, 'hd');
  add(playlists.fourK, '4k');
  return evidence;
}

function qualityScore(entry, evidence) {
  const text = `${entry.name || ''} ${entry.tvgName || ''}`;
  let score = 200;
  let quality = 'unmarked';
  if (/8K/i.test(text)) { score = 800; quality = '8k'; }
  else if (/4K|UHD/i.test(text)) { score = 700; quality = '4k'; }
  else if (/超高清/i.test(text)) { score = 650; quality = 'uhd'; }
  else if (/超清/i.test(text)) { score = 500; quality = 'super-hd'; }
  else if (/高清|\bHD\b/i.test(text)) { score = 400; quality = 'hd'; }
  else if (/标清|\bSD\b/i.test(text)) { score = 100; quality = 'sd'; }
  const tags = evidence.get(entry.rtpUrl) || new Set();
  if (tags.has('4k')) score = Math.max(score, 620);
  else if (tags.has('hd')) score = Math.max(score, 380);
  let penalty = 0;
  if (/(?:25|30|50|60)P/i.test(text)) penalty += 12;
  if (/窄色域/i.test(text)) penalty += 8;
  if (/备用|测试|开机/i.test(text)) penalty += 20;
  return { score, quality, evidence: [...tags].sort(), penalty };
}

export function selectBestEntries(entries, evidence = new Map()) {
  const grouped = new Map();
  for (const entry of entries) {
    const channel = normalizeChannelName(entry);
    if (!channel) continue;
    const candidate = { ...entry, channel, selection: qualityScore(entry, evidence) };
    if (!grouped.has(channel)) grouped.set(channel, []);
    grouped.get(channel).push(candidate);
  }
  const selected = [];
  for (const [channel, candidates] of grouped) {
    candidates.sort((a, b) => b.selection.score - a.selection.score
      || a.selection.penalty - b.selection.penalty
      || a.index - b.index
      || a.rtpUrl.localeCompare(b.rtpUrl));
    selected.push({ ...candidates[0], channel, candidateCount: candidates.length });
  }
  return selected;
}

export function classifyChannel(entry) {
  const text = `${entry.channel || ''} ${entry.name || ''} ${entry.tvgName || ''}`;
  if (/8K|4K|UHD|超高清/i.test(text)) return '4K超高清';
  if (/^CCTV-(?:5(?:\+)?|16)$/i.test(entry.channel || '') || /体育|赛事|足球|篮球|高尔夫|台球|搏击|网球|棋牌|竞技/i.test(text)) return '体育';
  if (/^CCTV-14$/i.test(entry.channel || '') || /少儿|青少|卡通|动画|动漫|金鹰卡通|嘉佳卡通|优漫/i.test(text)) return '少儿';
  if (/^CCTV-(?:6|8)$/i.test(entry.channel || '') || /电影|电视剧|剧场|影视|影迷|家庭影院/i.test(text)) return '电影电视剧';
  if (/^CCTV-(?:9|10)$/i.test(entry.channel || '') || /^CETV-/i.test(entry.channel || '') || /纪录|科教|探索|地理|教育|读书/i.test(text)) return '纪录科教';
  if (/^(?:CCTV|CGTN)/i.test(entry.channel || '') || /央视|中央广播电视总台/.test(text)) return '央视';
  if (/卫视/.test(text)) return '卫视';
  if (/广东|珠江|大湾区|南方|岭南|嘉佳/.test(text)) return '广东';
  if (/广州|深圳|佛山|东莞|惠州|中山|珠海|韶关|湛江|揭阳|汕头|汕尾|潮州|梅州|茂名|肇庆|清远|河源|阳江|云浮|江门/.test(text)) return '地方';
  return '其他';
}

export function toUdpxyUrl(rtpUrl, config) {
  const canonical = canonicalRtpUrl(rtpUrl);
  if (!canonical) throw new Error(`Invalid RTP URL: ${rtpUrl}`);
  const protocol = config?.protocol === 'https' ? 'https' : 'http';
  const host = String(config?.host || '').trim();
  const port = Number(config?.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid udpxy configuration');
  return `${protocol}://${host}:${port}/udp/${canonical.slice(6)}/`;
}

function escapeAttr(value) { return String(value || '').replace(/"/g, "'"); }

export function renderPlaylist(entries, config) {
  const epg = 'https://raw.githubusercontent.com/ShaoWentao/iptv-sources/main/m3u/gd-telecom-epg.xml';
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const ordered = entries.map((entry) => ({ ...entry, group: classifyChannel(entry) }))
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || collator.compare(a.channel, b.channel));
  const lines = [`#EXTM3U name="广东电信IPTV" url-tvg="${epg}"`];
  for (const entry of ordered) {
    const tvgName = GENERIC_TVG_NAMES.has(entry.tvgName) ? entry.channel : (entry.tvgName || entry.channel);
    const logo = entry.tvgLogo ? ` tvg-logo="${escapeAttr(entry.tvgLogo)}"` : '';
    lines.push(`#EXTINF:-1 tvg-name="${escapeAttr(tvgName)}"${logo} group-title="${entry.group}",${entry.channel}`);
    lines.push(toUdpxyUrl(entry.rtpUrl, config));
  }
  return `${lines.join('\n')}\n`;
}

export function sha256(text) { return crypto.createHash('sha256').update(String(text || '')).digest('hex'); }
