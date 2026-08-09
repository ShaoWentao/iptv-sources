import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function makePlaylist(count) {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= count; i += 1) {
    lines.push(`#EXTINF:-1 tvg-name="测试频道${i}",测试频道${i}高清`);
    lines.push(`rtp://239.88.${Math.floor(i / 250)}.${(i % 250) + 1}:${5000 + i}`);
  }
  lines.push('#EXTINF:-1 tvg-name="测试频道1",测试频道1高清备用');
  lines.push('rtp://239.91.0.2:7002');
  return `${lines.join('\n')}\n`;
}

test('generator removes probe-detected CAVS lines even when channel names do not mention CAVS', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-probe-'));
  const all = path.join(temp, 'all.m3u');
  const hd = path.join(temp, 'hd.m3u');
  const fourK = path.join(temp, '4k.m3u');
  const probe = path.join(temp, 'probe.txt');
  const epg = path.join(temp, 'epg.xml');
  const output = path.join(temp, 'out');

  fs.writeFileSync(all, makePlaylist(120));
  fs.writeFileSync(hd, '#EXTM3U\n');
  fs.writeFileSync(fourK, '#EXTM3U\n');
  fs.writeFileSync(probe, [
    '239.88.0.2:5001\tHD (V: h264; A: mp2@2ch)',
    '239.91.0.2:7002\tHD (V: cavs; A: ac3@6ch)',
  ].join('\n'));
  fs.writeFileSync(epg, '<?xml version="1.0"?><tv></tv>');

  const result = spawnSync(process.execPath, [
    'scripts/generate.mjs', '--all', all, '--hd', hd, '--4k', fourK, '--probe', probe, '--epg', epg,
    '--config', 'config/udpxy.json', '--output', output, '--upstream-sha', 'fixture-sha',
  ], { cwd: path.resolve('.'), encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const main = fs.readFileSync(path.join(output, 'gd-telecom.m3u'), 'utf8');
  const backup = fs.readFileSync(path.join(output, 'gd-telecom-udpxy.m3u'), 'utf8');
  const report = JSON.parse(fs.readFileSync(path.join(output, 'gd-telecom-report.json'), 'utf8'));

  assert.doesNotMatch(main, /239\.91\.0\.2:7002/);
  assert.doesNotMatch(backup, /239\.91\.0\.2:7002/);
  assert.match(main, /239\.88\.0\.2:5001/);
  assert.equal(report.filtered.cavsProbe, 1);
  assert.equal(report.inputs.probe.cavsUrls, 1);
});
