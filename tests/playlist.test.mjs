import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlaylist,
  filterEntries,
  selectBestEntries,
  selectAllEntries,
  normalizeChannelName,
  classifyChannel,
  toUdpxyUrl,
  renderPlaylist,
  renderRtpPlaylist,
} from '../scripts/playlist.mjs';

const source = `#EXTM3U
#EXTINF:-1 tvg-name="广东卫视",广东卫视时移专用
rtp://239.77.0.84:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视高清
rtp://239.77.0.4:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视超清
rtp://239.77.0.5:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视高清备用
rtp://239.77.0.6:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视4K超高清
rtp://239.77.0.66:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视4K(CAVS)
rtp://239.77.0.99:5146
#EXTINF:-1 tvg-name="CCTV-5",CCTV-5高清
rtp://239.77.0.105:5146
#EXTINF:-1 tvg-name="睛彩",睛彩篮球高清
rtp://239.77.1.21:5146
#EXTINF:-1 tvg-name="睛彩",睛彩竞技高清
rtp://239.77.1.20:5146
#EXTINF:-1 tvg-name="CCTV-4K",CCTV-4K
rtp://239.77.2.1:5146
#EXTINF:-1 tvg-name="央视精品",央视精品
rtp://239.253.43.27:5146
#EXTINF:-1 tvg-name="央视文化精品",央视文化精品
rtp://239.253.43.13:5146
#EXTINF:-1 tvg-name="经济科教",经济科教高清
rtp://239.77.0.167:5146
#EXTINF:-1 tvg-name="广东4K",广东4K
rtp://239.77.0.244:5146
#EXTINF:-1 tvg-name="广东IPTV广告",广东IPTV广告
rtp://239.77.0.240:5146
`;

const config = { protocol: 'http', host: '192.168.5.7', port: 4022 };

test('filters CAVS, timeshift, non-channel and duplicate-content entries', () => {
  const result = filterEntries(parsePlaylist(source));
  assert.equal(result.stats.cavs, 1);
  assert.equal(result.stats.timeshift, 1);
  assert.equal(result.stats.nonChannel, 1);
  assert.equal(result.stats.duplicateContent, 1);
  assert.ok(result.entries.every((entry) => !/CAVS|时移|广告/i.test(`${entry.name} ${entry.tvgName}`)));
  assert.equal(result.entries.some((entry) => entry.name === '央视精品'), false);
  assert.equal(result.entries.some((entry) => entry.name === '央视文化精品'), true);
});

test('normalizes channel identity while keeping generic tvg-name channels separate', () => {
  const entries = filterEntries(parsePlaylist(source)).entries;
  assert.equal(normalizeChannelName(entries.find((entry) => /广东卫视高清/.test(entry.name))), '广东卫视');
  const selected = selectBestEntries(entries, new Map());
  assert.deepEqual(
    selected.filter((entry) => entry.channel.startsWith('睛彩')).map((entry) => entry.channel).sort(),
    ['睛彩篮球', '睛彩竞技'].sort(),
  );
});

test('selects explicit 4K over HD for the same channel', () => {
  const selected = selectBestEntries(filterEntries(parsePlaylist(source)).entries, new Map());
  const gd = selected.find((entry) => entry.channel === '广东卫视');
  assert.match(gd.name, /4K/i);
});

test('filters ultra-HD sources and falls back to HD when configured', () => {
  const filtered = filterEntries(parsePlaylist(source), { excludeUltraHd: true });
  const selected = selectBestEntries(filtered.entries, new Map());
  const gd = selected.find((entry) => entry.channel === '广东卫视');
  assert.match(gd.name, /超清|高清/);
  assert.doesNotMatch(gd.name, /8K|4K|UHD|超高清/i);
  assert.equal(selected.some((entry) => entry.channel === 'CCTV-4K'), false);
  assert.equal(filtered.stats.ultraHd, 3);
});

test('keeps CCTV and CGTN together while applying local channel overrides', () => {
  for (const channel of ['CCTV-5', 'CCTV-6', 'CCTV-8', 'CCTV-9', 'CCTV-10', 'CCTV-14', 'CCTV-16', 'CCTV-4K', 'CGTN']) {
    assert.equal(classifyChannel({ channel, name: channel }), '央视');
  }
  assert.equal(classifyChannel({ channel: '经济科教', name: '经济科教高清' }), '广东');
  assert.equal(classifyChannel({ channel: '广东卫视', name: '广东卫视4K超高清' }), '卫视');
  assert.equal(classifyChannel({ channel: '广东4K', name: '广东4K' }), '广东');
  assert.equal(classifyChannel({ channel: '睛彩篮球', name: '睛彩篮球高清' }), '体育');
});

test('keeps all RTP alternatives sorted by quality and stability', () => {
  const ranked = selectAllEntries(filterEntries(parsePlaylist(source)).entries, new Map());
  const gd = ranked.filter((entry) => entry.channel === '广东卫视');
  assert.deepEqual(gd.map((entry) => entry.selection.quality), ['4k', 'super-hd', 'hd', 'hd']);
  assert.match(gd[3].name, /备用/);
  assert.deepEqual(gd.map((entry) => entry.lineIndex), [0, 1, 2, 3]);
});

test('renders RTP alternatives with identical channel metadata', () => {
  const ranked = selectAllEntries(filterEntries(parsePlaylist(source)).entries, new Map());
  const output = renderRtpPlaylist(ranked, { name: '广东电信IPTV' });
  const lines = output.split('\n');
  const gdInfo = lines.filter((line) => line.includes(',广东卫视'));
  const gdUrls = lines.filter((line) => /^rtp:\/\/239\.77\.0\.(?:66|5|4|6):5146$/.test(line));
  assert.equal(gdInfo.length, 4);
  assert.equal(new Set(gdInfo.map((line) => line.match(/tvg-name="([^"]+)"/)?.[1])).size, 1);
  assert.ok(gdInfo.every((line) => line.includes('group-title="卫视"')));
  assert.deepEqual(gdUrls, [
    'rtp://239.77.0.66:5146',
    'rtp://239.77.0.5:5146',
    'rtp://239.77.0.4:5146',
    'rtp://239.77.0.6:5146',
  ]);
  assert.doesNotMatch(output, /192\.168\.5\.7:4022/);
});

test('renders only configured udpxy URLs and repository EPG URL', () => {
  const selected = selectBestEntries(filterEntries(parsePlaylist(source)).entries, new Map());
  const output = renderPlaylist(selected, config);
  assert.equal(toUdpxyUrl('rtp://239.77.0.66:5146', config), 'http://192.168.5.7:4022/udp/239.77.0.66:5146/');
  assert.doesNotMatch(output, /CAVS|时移|rtp:\/\//i);
  assert.doesNotMatch(output, /,央视精品\n/);
  assert.match(output, /,央视文化精品\n/);
  assert.match(output, /tvg-name="CCTV-5" group-title="央视",CCTV-5/);
  assert.match(output, /tvg-name="经济科教" group-title="广东",经济科教/);
  assert.match(output, /raw\.githubusercontent\.com\/ShaoWentao\/iptv-sources\/main\/m3u\/gd-telecom-epg\.xml/);
  const urls = output.split('\n').filter((line) => /^https?:\/\//.test(line));
  assert.ok(urls.every((url) => url.startsWith('http://192.168.5.7:4022/udp/')));
});

test('empty optional quality evidence is accepted', () => {
  const selected = selectBestEntries(filterEntries(parsePlaylist(source)).entries, new Map());
  assert.ok(selected.length >= 3);
});
