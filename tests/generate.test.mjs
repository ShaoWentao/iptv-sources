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
  lines.push('#EXTINF:-1 tvg-name="无画面",无画面CAVS');
  lines.push('rtp://239.89.0.1:6000');
  return `${lines.join('\n')}\n`;
}

test('generator creates playlist, report and EPG from a clean workspace', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-clean-'));
  const all = path.join(temp, 'all.m3u');
  const hd = path.join(temp, 'hd.m3u');
  const fourK = path.join(temp, '4k.m3u');
  const epg = path.join(temp, 'epg.xml');
  const output = path.join(temp, 'out');
  fs.writeFileSync(all, makePlaylist(120));
  fs.writeFileSync(hd, '#EXTM3U\n');
  fs.writeFileSync(fourK, '#EXTM3U\n');
  fs.writeFileSync(epg, '<?xml version="1.0"?><tv></tv>');
  const result = spawnSync(process.execPath, [
    'scripts/generate.mjs', '--all', all, '--hd', hd, '--4k', fourK, '--epg', epg,
    '--config', 'config/udpxy.json', '--output', output, '--upstream-sha', 'fixture-sha',
  ], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const playlist = fs.readFileSync(path.join(output, 'gd-telecom.m3u'), 'utf8');
  const report = JSON.parse(fs.readFileSync(path.join(output, 'gd-telecom-report.json'), 'utf8'));
  assert.doesNotMatch(playlist, /CAVS|rtp:\/\//i);
  assert.equal(report.selectedChannels, 120);
  assert.equal(report.filtered.cavs, 1);
  assert.equal(report.upstreamSha, 'fixture-sha');
  assert.ok(fs.statSync(path.join(output, 'gd-telecom-epg.xml')).size > 0);
});
