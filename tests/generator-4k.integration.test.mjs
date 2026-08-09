import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function makePlaylist() {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 120; i += 1) {
    lines.push(`#EXTINF:-1 tvg-name="测试频道${i}",测试频道${i}高清`);
    lines.push(`rtp://239.88.${Math.floor(i / 250)}.${(i % 250) + 1}:${5000 + i}`);
  }
  lines.push('#EXTINF:-1 tvg-name="广东卫视",广东卫视高清');
  lines.push('rtp://239.90.0.4:6004');
  lines.push('#EXTINF:-1 tvg-name="广东卫视",广东卫视4K超高清');
  lines.push('rtp://239.90.0.1:6001');
  lines.push('#EXTINF:-1 tvg-name="证据频道",证据频道高清');
  lines.push('rtp://239.90.0.2:6002');
  lines.push('#EXTINF:-1 tvg-name="无画面",无画面CAVS');
  lines.push('rtp://239.90.0.3:6003');
  return `${lines.join('\n')}\n`;
}

function makeFourKPlaylist() {
  return `#EXTM3U\n#EXTINF:-1 tvg-name="证据频道",证据频道高清\nrtp://239.90.0.2:6002\n`;
}

test('generator puts 4K back in RTP primary and keeps dedicated RTP 4K playlist', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-4k-'));
  const all = path.join(temp, 'all.m3u');
  const hd = path.join(temp, 'hd.m3u');
  const fourK = path.join(temp, '4k.m3u');
  const epg = path.join(temp, 'epg.xml');
  const output = path.join(temp, 'out');
  fs.writeFileSync(all, makePlaylist());
  fs.writeFileSync(hd, '#EXTM3U\n');
  fs.writeFileSync(fourK, makeFourKPlaylist());
  fs.writeFileSync(epg, '<?xml version="1.0"?><tv></tv>');

  const result = spawnSync(process.execPath, [
    'scripts/generate.mjs', '--all', all, '--hd', hd, '--4k', fourK, '--epg', epg,
    '--config', 'config/udpxy.json', '--output', output, '--upstream-sha', 'fixture-sha',
  ], { cwd: path.resolve('.'), encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const main = fs.readFileSync(path.join(output, 'gd-telecom.m3u'), 'utf8');
  const backup = fs.readFileSync(path.join(output, 'gd-telecom-udpxy.m3u'), 'utf8');
  const ultraHd = fs.readFileSync(path.join(output, 'gd-telecom-4k.m3u'), 'utf8');
  const report = JSON.parse(fs.readFileSync(path.join(output, 'gd-telecom-report.json'), 'utf8'));

  assert.match(main, /广东卫视/);
  assert.match(main, /rtp:\/\/239\.90\.0\.1:6001/);
  assert.ok(main.indexOf('rtp://239.90.0.1:6001') < main.indexOf('rtp://239.90.0.4:6004'));
  assert.match(backup, /http:\/\/192\.168\.5\.7:4022\/udp\/239\.90\.0\.1:6001\//);
  assert.match(ultraHd, /^#EXTM3U name="广东电信IPTV 4K"/);
  assert.match(ultraHd, /rtp:\/\/239\.90\.0\.1:6001/);
  assert.match(ultraHd, /rtp:\/\/239\.90\.0\.2:6002/);
  assert.doesNotMatch(ultraHd, /CAVS|时移|回看|192\.168\.5\.7:4022/i);
  assert.equal(report.ultraHdSelectedLines, 2);
});
