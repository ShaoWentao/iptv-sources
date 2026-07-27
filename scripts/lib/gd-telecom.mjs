import crypto from 'node:crypto';

export const GROUP_ORDER = [
  '央视',
  '卫视',
  '广东',
  '地方',
  '体育',
  '少儿',
  '电影电视剧',
  '纪录科教',
  '4K超高清',
  '其他',
];

const MULTICAST_RE = /^(?:rtp|udp):\/\/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\/?$/i;
const UDPXY_RE = /^https?:\/\/[^/]+\/udp\/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\/?$/i;

function parseAttributes(line) {
  const attrs = {};
  const prefix = line.includes(',') ? line.slice(0, line.indexOf(',')) : line;
  const re = /([\w-]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(prefix))) attrs[match[1]] = match[2];
  return attrs;
}

function isMulticast(ip) {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && parts[0] >= 224 && parts[0] <= 239;
}

export function canonicalRtpUrl(url) {
  const value = String(url || '').trim();
  const match = value.match(MULTICAST_RE) || value.match(UDPXY_RE);
  if (!match) return null;
  const [, ip, portText] = match;
  const port = Number(portText);
  if (!isMulticast(ip) || port < 1 || port > 65535) return null;
  return `rtp://${ip}:${port}`;
}

export function parseM3u(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries = [];
  let pending = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const attrs = parseAttributes(line);
      const comma = line.indexOf(',');
      pending = {
        name: comma >= 0 ? line.slice(comma + 1).trim() : '',
        tvgName: (attrs['tvg-name'] || '').trim(),
        tvgId: (attrs['tvg-id'] || '').trim(),
        tvgLogo: (attrs['tvg-logo'] || '').trim(),
        groupTitle: (attrs['group-title'] || '').trim(),
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
  add(playlists.sd, 'sd');
  add(playlists.fourK, '4k');
  return evidence;
}

export function filterEntries(entries) {
  const seenUrls = new Set();
  const kept = [];
  const stats = { cavs: 0, timeshift: 0, nonChannel: 0, invalid: 0, emptyName: 0, duplicateUrl: 0 };
  for (const entry of entries) {
    const label = `${entry.name || ''} ${entry.tvgName || ''}`;
    if (!String(entry.name || entry.tvgName || '').trim()) {
      stats.emptyName += 1;
      continue;
    }
    if (/CAVS/i.test(label)) {
      stats.cavs += 1;
      continue;
    }
    if (/时移专用|时移/i.test(label)) {
      stats.timeshift += 1;
      continue;
    }
    if (/^\s*Unknown@/i.test(label) || /IPTV广告/i.test(label)) {
      stats.nonChannel += 1;
      continue;
    }
    const rtpUrl = entry.rtpUrl || canonicalRtpUrl(entry.url);
    if (!rtpUrl) {
      stats.invalid += 1;
      continue;
    }
    if (seenUrls.has(rtpUrl)) {
      stats.duplicateUrl += 1;
      continue;
    }
    seenUrls.add(rtpUrl);
    kept.push({ ...entry, rtpUrl });
  }
  return { entries: kept, stats };
}

function normalizePunctuation(value) {
  return value
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[—–－_]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function preserveDedicatedQualityChannel(value) {
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (/^CCTV-?4K$/.test(compact)) return 'CCTV-4K';
  if (/^CCTV-?8K$/.test(compact)) return 'CCTV-8K';
  if (/^广东4K$/.test(compact)) return '广东4K';
  return null;
}

export function normalizeChannelName(entry) {
  const rawTvg = normalizePunctuation(entry.tvgName || '');
  const rawName = normalizePunctuation(entry.name || '');
  const source = rawTvg || rawName;
  const dedicated = preserveDedicatedQualityChannel(source) || preserveDedicatedQualityChannel(rawName);
  if (dedicated) return dedicated;

  let value = source || rawName;
  value = value.replace(/\([^)]*\)/g, ' ');
  value = value.replace(/(?:8K|4K)(?:超)?|UHD|超高清|超清|高清|\bHD\b|标清|\bSD\b/gi, ' ');
  value = value.replace(/\b(?:AVS2|AVS\+?|HEVC|H\.265|H\.264|MPEG-?2|MPEG-?4)\b/gi, ' ');
  value = value.replace(/\b(?:25|30|50|60)P\b/gi, ' ');
  value = value.replace(/(?:宽色域|窄色域|开机|测试|备用|主用|信号)/gi, ' ');
  value = value.replace(/(?<=卫视)超$/g, '');
  value = value.replace(/(?:频道)+$/g, '频道');
  value = value.replace(/[\s-]+$/g, '').replace(/^[-\s]+/g, '').replace(/\s+/g, ' ').trim();

  value = value.replace(/^CCTV\s*-?\s*(\d{1,2})(\+)?(?:\s*频道)?$/i, (_, n, plus = '') => `CCTV-${Number(n)}${plus}`);
  value = value.replace(/^CCTV\s*-?\s*(\d{1,2})(\+)?(.+)$/i, (_, n, plus = '', suffix) => {
    const cleanSuffix = String(suffix).replace(/^[\s-]+/, '').trim();
    if (!cleanSuffix || /^(综合|财经|综艺|中文国际|体育|电影|国防军事|电视剧|纪录|科教|戏曲|社会与法|新闻|少儿|音乐|奥林匹克|农业农村)$/.test(cleanSuffix)) {
      return `CCTV-${Number(n)}${plus}`;
    }
    return `CCTV-${Number(n)}${plus}${cleanSuffix}`;
  });
  value = value.replace(/^CCTV(\d{1,2})(\+)?$/i, (_, n, plus = '') => `CCTV-${Number(n)}${plus}`);
  value = value.replace(/^CETV\s*-?\s*(\d+)$/i, (_, n) => `CETV-${Number(n)}`);
  value = value.replace(/英文记录/g, '英文纪录');
  value = value.replace(/\s+/g, '');

  return value || rawName || rawTvg;
}

export function detectExplicitQuality(entry) {
  const text = `${entry.name || ''} ${entry.tvgName || ''}`;
  if (/8K/i.test(text)) return { label: '8k', score: 800 };
  if (/4K|UHD/i.test(text)) return { label: '4k', score: 700 };
  if (/超高清/i.test(text)) return { label: 'uhd', score: 650 };
  if (/超清/i.test(text)) return { label: 'super-hd', score: 500 };
  if (/高清|\bHD\b/i.test(text)) return { label: 'hd', score: 400 };
  if (/标清|\bSD\b/i.test(text)) return { label: 'sd', score: 100 };
  return { label: 'unmarked', score: 250 };
}

function annotationPenalty(entry) {
  const text = `${entry.name || ''} ${entry.tvgName || ''}`;
  let penalty = 0;
  if (/\b(?:25|30|50|60)P\b/i.test(text)) penalty += 12;
  if (/窄色域|宽色域/i.test(text)) penalty += 8;
  if (/AVS2/i.test(text)) penalty += 4;
  if (/备用|测试|开机/i.test(text)) penalty += 20;
  return penalty;
}

export function scoreCandidate(entry, evidence = new Map()) {
  const explicit = detectExplicitQuality(entry);
  const tags = evidence.get(entry.rtpUrl || canonicalRtpUrl(entry.url)) || new Set();
  let score = explicit.score;
  let evidenceLabel = 'name';
  if (tags.has('4k') && score < 620) {
    score = 620;
    evidenceLabel = '4k-list';
  }
  if (tags.has('hd') && score < 380) {
    score = 380;
    evidenceLabel = 'hd-list';
  }
  if (tags.has('sd') && explicit.label === 'unmarked' && !tags.has('hd') && !tags.has('4k')) {
    score = 150;
    evidenceLabel = 'sd-list';
  }
  return {
    score,
    quality: explicit.label,
    evidence: [...tags].sort(),
    evidenceLabel,
    annotationPenalty: annotationPenalty(entry),
  };
}

export function selectBestChannels(entries, evidence = new Map()) {
  const groups = new Map();
  for (const entry of entries) {
    const channel = normalizeChannelName(entry);
    if (!channel) continue;
    const candidate = { ...entry, channel, selection: scoreCandidate(entry, evidence) };
    if (!groups.has(channel)) groups.set(channel, []);
    groups.get(channel).push(candidate);
  }

  const selected = [];
  for (const [channel, candidates] of groups) {
    candidates.sort((a, b) =>
      b.selection.score - a.selection.score ||
      a.selection.annotationPenalty - b.selection.annotationPenalty ||
      a.index - b.index ||
      a.rtpUrl.localeCompare(b.rtpUrl),
    );
    const best = candidates[0];
    selected.push({
      ...best,
      channel,
      candidateCount: candidates.length,
      removedCandidates: candidates.slice(1).map((item) => ({
        name: item.name,
        tvgName: item.tvgName,
        rtpUrl: item.rtpUrl,
        score: item.selection.score,
        quality: item.selection.quality,
        evidence: item.selection.evidence,
      })),
    });
  }
  return selected;
}

export function classifyChannel(entry) {
  const text = `${entry.channel || ''} ${entry.name || ''} ${entry.tvgName || ''}`;
  if (/8K|4K|UHD|超高清/i.test(text)) return '4K超高清';
  if (/^CCTV-5(?:\+)?$/i.test(entry.channel || '') || /体育|赛事|足球|篮球|高尔夫|台球|搏击|网球|棋牌/i.test(text)) return '体育';
  if (/^CCTV-14$/i.test(entry.channel || '') || /少儿|卡通|动画|动漫|金鹰卡通|嘉佳卡通|优漫/i.test(text)) return '少儿';
  if (/^CCTV-(?:6|8)$/i.test(entry.channel || '') || /电影|电视剧|剧场|影视|影迷|动作电影|家庭影院/i.test(text)) return '电影电视剧';
  if (/^CCTV-(?:9|10)$/i.test(entry.channel || '') || /^CETV-/i.test(entry.channel || '') || /纪录|科教|探索|地理|兵器科技|世界地理|教育|读书/i.test(text)) return '纪录科教';
  if (/^(?:CCTV|CGTN)/i.test(entry.channel || '') || /中央广播电视总台|央视/.test(text)) return '央视';
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
  return `${protocol}://${host}:${port}/udp/${canonical.slice('rtp://'.length)}/`;
}

function escapeAttr(value) {
  return String(value || '').replace(/"/g, "'");
}

export function renderPlaylist(channels, config, options = {}) {
  const urlTvg = options.urlTvg || 'https://tv.shaowt.com/gd-telecom-epg.xml';
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const ordered = [...channels]
    .map((item) => ({ ...item, outputGroup: classifyChannel(item) }))
    .sort((a, b) => GROUP_ORDER.indexOf(a.outputGroup) - GROUP_ORDER.indexOf(b.outputGroup) || collator.compare(a.channel, b.channel));
  const lines = [`#EXTM3U name="广东电信IPTV" url-tvg="${urlTvg}"`];
  for (const item of ordered) {
    const tvgName = item.tvgName || item.channel;
    const logo = item.tvgLogo ? ` tvg-logo="${escapeAttr(item.tvgLogo)}"` : '';
    lines.push(`#EXTINF:-1 tvg-name="${escapeAttr(tvgName)}"${logo} group-title="${item.outputGroup}",${item.channel}`);
    lines.push(toUdpxyUrl(item.rtpUrl, config));
  }
  return `${lines.join('\n')}\n`;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
