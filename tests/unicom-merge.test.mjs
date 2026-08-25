import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function url(host, id, token = 'A', fmt = '244') {
  return `http://${host}:80/PLTV/88888973/224/${id}/asset_${id}.smil/01.m3u8?fmt=ts2hls,${fmt},01.m3u8&accountinfo=${token}&tenantId=8601`;
}

function makePrimary() {
  const lines = ['央视,#genre#'];
  for (let i = 1; i <= 22; i += 1) lines.push(`测试${i},${url('120.87.19.109', 3221227000 + i)}`);
  lines.push('卫视,#genre#');
  lines.push(`广东卫视,${url('120.87.19.109', 3221228001, 'PRIMARY-HD')}`);
  lines.push(`广东卫视,${url('120.87.19.109', 3221228002, 'PRIMARY-SD', '744')}`);
  return `${lines.join('\n')}\n`;
}

function makeSecondary() {
  const hdSamePath = url('120.87.19.109', 3221228001, 'SECONDARY-HD');
  const fourK = url('120.87.19.109', 3221229001, '4K', '1');
  return `#EXTM3U\n` +
    `#EXTINF:-1 tvg-id="广东卫视" tvg-name="广东卫视" group-title="4K超高清",广东卫视4K\n${fourK}\n` +
    `#EXTINF:-1 tvg-id = "广东卫视" tvg-name = "广东卫视" group-title="卫视高清",广东卫视高清\n${hdSamePath}\n` +
    `#EXTINF:-1 tvg-id="汕头新闻综合" tvg-name="汕头新闻综合" group-title="地方",汕头新闻综合\nhttps://sttv-hls.strtv.cn/live/test.m3u8\n` +
    `#EXTINF:-1 tvg-id="跑男" tvg-name="跑男" group-title="综艺轮播",跑男\nhttp://192.168.5.6:35455/huya/123\n` +
    `#EXTINF:-1 tvg-id="假联通" tvg-name="假联通" group-title="其他",假联通\nhttp://120.87.19.109/not-iptv/test.m3u8\n`;
}

test('merges two Unicom upstreams, filters non-IPTV URLs, ranks 4K first and adds a 4K group', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'unicom-merge-'));
  const primary = path.join(temp, 'primary.txt');
  const secondary = path.join(temp, 'secondary.m3u');
  const out = path.join(temp, 'out');
  fs.writeFileSync(primary, makePrimary());
  fs.writeFileSync(secondary, makeSecondary());

  const result = spawnSync(process.execPath, [
    'scripts/generate-unicom.mjs', '--input', primary, '--input-secondary', secondary,
    '--output', out, '--upstream-sha', 'primary-sha', '--secondary-sha', 'secondary-sha',
  ], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const main = fs.readFileSync(path.join(out, 'gd-unicom.m3u'), 'utf8');
  const simple = fs.readFileSync(path.join(out, 'gd-unicom-simple.m3u'), 'utf8');
  const report = JSON.parse(fs.readFileSync(path.join(out, 'gd-unicom-report.json'), 'utf8'));

  assert.doesNotMatch(main, /sttv-hls|192\.168\.5\.6|\/not-iptv\//);
  assert.match(main, /group-title="4K超高清",广东卫视4K/);
  assert.match(simple, /group-title="4K超高清",广东卫视4K/);

  const fourK = url('120.87.19.109', 3221229001, '4K', '1');
  const hd = url('120.87.19.109', 3221228001, 'PRIMARY-HD');
  const sd = url('120.87.19.109', 3221228002, 'PRIMARY-SD', '744');
  const regularBlockStart = main.indexOf('group-title="卫视",广东卫视');
  assert.ok(regularBlockStart >= 0);
  const regularBlock = main.slice(regularBlockStart);
  assert.ok(regularBlock.indexOf(fourK) < regularBlock.indexOf(hd));
  assert.ok(regularBlock.indexOf(hd) < regularBlock.indexOf(sd));

  assert.equal((main.match(/asset_3221228001\.smil/g) || []).length, 1, 'auth-only duplicate should be removed');
  assert.equal((main.match(/asset_3221229001\.smil/g) || []).length, 2, '4K URL should appear in regular and 4K groups');
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.upstreams.length, 2);
  assert.equal(report.fourKChannels, 1);
  assert.equal(report.filteredNonUnicom, 3);
  assert.ok(report.deduplicatedEntries >= 1);
});
