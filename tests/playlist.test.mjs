import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlaylist,
  filterEntries,
  selectBestEntries,
  normalizeChannelName,
  classifyChannel,
  toUdpxyUrl,
  renderPlaylist,
} from '../scripts/playlist.mjs';

const source = `#EXTM3U
#EXTINF:-1 tvg-name="广东卫视",广东卫视时移专用
rtp://239.77.0.84:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视高清
rtp://239.77.0.4:5146
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
#EXTINF:-1 tvg-name="广东IPTV广告",广东IPTV广告
rtp://239.77.0.240:5146
`;

const config = { protocol: 'http', host: '192.168.5.7', port: 4022 };

test('filters CAVS, timeshift and non-channel entries', () => {
  const result = filterEntries(parsePlaylist(source));
  assert.equal(result.stats.cavs, 1);
  assert.equal(result.stats.timeshift, 1);
  assert.equal(result.stats.nonChannel, 1);
  assert.ok(result.entries.every((entry) => !/CAVS|时移|广告/i.test(`${entry.name} ${entry.tvgName}`)));
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
  assert.match(gd.name, /高清/);
  assert.doesNotMatch(gd.name, /8K|4K|UHD|超高清/i);
  assert.equal(selected.some((entry) => entry.channel === 'CCTV-4K'), false);
  assert.equal(filtered.stats.ultraHd, 2);
});

test('classifies content groups before broadcaster groups', () => {
  assert.equal(classifyChannel({ channel: 'CCTV-5', name: 'CCTV-5高清' }), '体育');
  assert.equal(classifyChannel({ channel: '广东卫视', name: '广东卫视4K超高清' }), '4K超高清');
  assert.equal(classifyChannel({ channel: '睛彩篮球', name: '睛彩篮球高清' }), '体育');
});

test('renders only configured udpxy URLs and repository EPG URL', () => {
  const selected = selectBestEntries(filterEntries(parsePlaylist(source)).entries, new Map());
  const output = renderPlaylist(selected, config);
  assert.equal(toUdpxyUrl('rtp://239.77.0.66:5146', config), 'http://192.168.5.7:4022/udp/239.77.0.66:5146/');
  assert.doesNotMatch(output, /CAVS|时移|rtp:\/\//i);
  assert.match(output, /raw\.githubusercontent\.com\/ShaoWentao\/iptv-sources\/main\/m3u\/gd-telecom-epg\.xml/);
  const urls = output.split('\n').filter((line) => /^https?:\/\//.test(line));
  assert.ok(urls.every((url) => url.startsWith('http://192.168.5.7:4022/udp/')));
});

test('empty optional quality evidence is accepted', () => {
  const selected = selectBestEntries(filterEntries(parsePlaylist(source)).entries, new Map());
  assert.ok(selected.length >= 3);
});
