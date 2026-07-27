import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  parseM3u,
  buildQualityEvidence,
  filterEntries,
  normalizeChannelName,
  scoreCandidate,
  selectBestChannels,
  classifyChannel,
  toUdpxyUrl,
  renderPlaylist,
} from '../scripts/lib/gd-telecom.mjs';

const allText = `#EXTM3U
#EXTINF:-1 tvg-name="广东卫视",广东卫视高清
rtp://239.77.0.4:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视4k超高清
rtp://239.77.0.66:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视4K(CAVS)
rtp://239.77.1.99:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视时移专用
rtp://239.77.0.84:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视 4K (AVS2)
rtp://239.77.1.96:5146
#EXTINF:-1 tvg-name="CCTV-5",CCTV-5高清
rtp://239.77.0.105:5146
#EXTINF:-1 tvg-name="嘉佳卡通",嘉佳卡通高清
rtp://239.77.0.179:5146
#EXTINF:-1 tvg-name="CCTV-4K",CCTV4K-25P
rtp://239.77.0.194:5146
#EXTINF:-1 tvg-name="广东4K",广东4K超高清
rtp://239.77.0.244:5146
#EXTINF:-1 tvg-name="广东IPTV广告",广东IPTV广告
rtp://239.77.0.240:5146
#EXTINF:-1 tvg-name="睛彩",睛彩青少高清
rtp://239.77.1.22:5146
#EXTINF:-1 tvg-name="睛彩",睛彩广场舞高清
rtp://239.77.1.23:5146
#EXTINF:-1 tvg-name="睛彩",睛彩竞技高清
rtp://239.77.1.20:5146
#EXTINF:-1 tvg-name="睛彩",睛彩篮球高清
rtp://239.77.1.21:5146
`;
const hdText = `#EXTM3U
#EXTINF:-1,广东卫视高清
rtp://239.77.0.4:5146
#EXTINF:-1,CCTV-5高清
rtp://239.77.0.105:5146
#EXTINF:-1,嘉佳卡通高清
rtp://239.77.0.179:5146
`;
const sdText = `#EXTM3U
#EXTINF:-1,广东卫视4k超高清
rtp://239.77.0.66:5146
`;
const fourKText = `#EXTM3U
#EXTINF:-1,广东卫视4k超高清
rtp://239.77.0.66:5146
#EXTINF:-1,广东卫视 4K (AVS2)
rtp://239.77.1.96:5146
#EXTINF:-1,CCTV4K-25P
rtp://239.77.0.194:5146
`;
const config = { protocol: 'http', host: '192.168.5.7', port: 4022 };

test('parses M3U entries and filters CAVS and time-shift sources', () => {
  const parsed = parseM3u(allText);
  assert.equal(parsed.length, 14);
  const result = filterEntries(parsed);
  assert.equal(result.stats.cavs, 1);
  assert.equal(result.stats.timeshift, 1);
  assert.equal(result.stats.nonChannel, 1);
  assert.ok(result.entries.every((entry) => !/CAVS|时移/i.test(`${entry.name} ${entry.tvgName}`)));
});

test('preserves AVS2 and normalizes channel identities', () => {
  const parsed = parseM3u(allText);
  const avs2 = parsed.find((entry) => /AVS2/.test(entry.name));
  assert.equal(normalizeChannelName(avs2), '广东卫视');
  assert.equal(normalizeChannelName(parsed.find((entry) => entry.tvgName === 'CCTV-4K')), 'CCTV-4K');
  assert.equal(normalizeChannelName(parsed.find((entry) => entry.tvgName === '广东4K')), '广东4K');
});

test('keeps distinct channels when upstream reuses a generic tvg-name', () => {
  const filtered = filterEntries(parseM3u(allText)).entries;
  const selected = selectBestChannels(filtered, new Map());
  const jingcai = selected.filter((entry) => entry.channel.startsWith('睛彩'));
  assert.deepEqual(jingcai.map((entry) => entry.channel).sort(), ['睛彩广场舞', '睛彩竞技', '睛彩篮球', '睛彩青少'].sort());
  const output = renderPlaylist(selected, config);
  assert.match(output, /tvg-name="睛彩青少"[^\n]*,睛彩青少/);
});

test('explicit 4K and 4K-list evidence outrank HD even when SD list is contradictory', () => {
  const all = filterEntries(parseM3u(allText)).entries;
  const evidence = buildQualityEvidence({ hd: parseM3u(hdText), sd: parseM3u(sdText), fourK: parseM3u(fourKText) });
  const explicit4kInSd = all.find((entry) => entry.rtpUrl === 'rtp://239.77.0.66:5146');
  const hd = all.find((entry) => entry.rtpUrl === 'rtp://239.77.0.4:5146');
  assert.ok(scoreCandidate(explicit4kInSd, evidence).score > scoreCandidate(hd, evidence).score);
  const selected = selectBestChannels(all, evidence);
  const gd = selected.filter((entry) => entry.channel === '广东卫视');
  assert.equal(gd.length, 1);
  assert.match(gd[0].name, /4K/i);
});

test('classifies by content and quality before broadcaster type', () => {
  assert.equal(classifyChannel({ channel: 'CCTV-5', name: 'CCTV-5高清' }), '体育');
  assert.equal(classifyChannel({ channel: 'CCTV-16', name: 'CCTV-16高清' }), '体育');
  assert.equal(classifyChannel({ channel: 'CCTV-6', name: 'CCTV-6高清' }), '电影电视剧');
  assert.equal(classifyChannel({ channel: 'CCTV-9', name: 'CCTV-9高清' }), '纪录科教');
  assert.equal(classifyChannel({ channel: 'CCTV-14', name: 'CCTV-14高清' }), '少儿');
  assert.equal(classifyChannel({ channel: '广东卫视', name: '广东卫视4K超高清' }), '4K超高清');
  assert.equal(classifyChannel({ channel: '嘉佳卡通', name: '嘉佳卡通高清' }), '少儿');
  assert.equal(classifyChannel({ channel: '睛彩竞技', name: '睛彩竞技高清' }), '体育');
  assert.equal(classifyChannel({ channel: '睛彩青少', name: '睛彩青少高清' }), '少儿');
});

test('renders udpxy URLs and one entry per normalized channel', () => {
  const all = filterEntries(parseM3u(allText)).entries;
  const evidence = buildQualityEvidence({ hd: parseM3u(hdText), sd: parseM3u(sdText), fourK: parseM3u(fourKText) });
  const selected = selectBestChannels(all, evidence);
  const output = renderPlaylist(selected, config);
  assert.equal(toUdpxyUrl('rtp://239.77.0.66:5146', config), 'http://192.168.5.7:4022/udp/239.77.0.66:5146/');
  assert.doesNotMatch(output, /CAVS|时移|rtp:\/\//i);
  assert.match(output, /group-title="4K超高清"/);
  const names = [...output.matchAll(/#EXTINF[^,]*,(.+)$/gm)].map((match) => match[1]);
  assert.equal(new Set(names).size, names.length);
});

test('production generator writes playlist, report and EPG atomically', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-iptv-'));
  const write = (name, text) => { const file = path.join(temp, name); fs.writeFileSync(file, text); return file; };
  const result = spawnSync(process.execPath, [
    'scripts/build-gd-telecom.mjs',
    '--all', write('all.m3u', allText),
    '--hd', write('hd.m3u', hdText),
    '--sd', write('sd.m3u', sdText),
    '--4k', write('4k.m3u', fourKText),
    '--epg', write('epg.xml', '<?xml version="1.0"?><tv></tv>'),
    '--config', 'config/udpxy.json',
    '--output-dir', temp,
    '--min-input', '1',
    '--min-output', '1',
    '--upstream-sha', 'fixture-sha',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const playlist = fs.readFileSync(path.join(temp, 'gd-telecom.m3u'), 'utf8');
  const report = JSON.parse(fs.readFileSync(path.join(temp, 'gd-telecom-report.json'), 'utf8'));
  assert.match(playlist, /#EXTM3U name="广东电信IPTV"/);
  assert.doesNotMatch(playlist, /CAVS|时移|rtp:\/\//i);
  assert.ok(report.inputs.fourK.entries > 0);
  assert.ok(report.qualityEvidence.fourKUrls > 0);
  assert.ok(report.selectedChannels > 0);
  assert.equal(report.upstreamSha, 'fixture-sha');
});
