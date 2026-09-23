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


test('normalizes Guangdong, satellite, children and city channel groups instead of inheriting bad upstream groups', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'unicom-groups-'));
  const primary = path.join(temp, 'primary.txt');
  const secondary = path.join(temp, 'secondary.m3u');
  const out = path.join(temp, 'out');

  const lines = ['央视,#genre#'];
  for (let i = 1; i <= 22; i += 1) lines.push('测试' + i + ',' + url('120.87.19.109', 3221230000 + i));
  lines.push('地方,#genre#');
  const misplaced = [
    ['广东经济科教', 3221231001],
    ['广东体育', 3221231002],
    ['广东珠江', 3221231003],
    ['广东民生', 3221231004],
    ['广东影视', 3221231005],
    ['广东新闻', 3221231006],
    ['嘉佳卡通', 3221231007],
    ['广东少儿', 3221231008],
    ['岭南戏曲', 3221231009],
    ['南方购物', 3221231010],
    ['大湾区卫视', 3221231011],
    ['广东移动', 3221231012],
    ['东南卫视', 3221231013],
    ['厦门卫视', 3221231014],
    ['三沙卫视', 3221231015],
    ['兵团卫视', 3221231016],
    ['北京KAKU少儿', 3221231017],
    ['金鹰卡通', 3221231018],
    ['金鹰纪实', 3221231019],
    ['佛山南海', 3221231020],
    ['佛山顺德', 3221231021],
  ];
  for (const [name, id] of misplaced) lines.push(name + ',' + url('120.87.19.109', id));
  fs.writeFileSync(primary, lines.join('\n') + '\n');

  fs.writeFileSync(
    secondary,
    '#EXTM3U\n' +
      '#EXTINF:-1 tvg-id="广东现代教育" tvg-name="广东现代教育" group-title="广东",广东现代教育\n' +
      url('120.87.19.109', 3221231100) + '\n'
  );

  const result = spawnSync(process.execPath, [
    'scripts/generate-unicom.mjs', '--input', primary, '--input-secondary', secondary,
    '--output', out, '--upstream-sha', 'primary-sha', '--secondary-sha', 'secondary-sha',
  ], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const simple = fs.readFileSync(path.join(out, 'gd-unicom-simple.m3u'), 'utf8');

  for (const name of [
    '广东经济科教', '广东体育', '广东珠江', '广东民生', '广东影视', '广东新闻',
    '嘉佳卡通', '广东少儿', '岭南戏曲', '南方购物', '大湾区卫视', '广东移动', '广东现代教育',
  ]) {
    assert.ok(simple.includes('group-title="广东",' + name + '\n'), name + ' should be in 广东');
  }

  for (const name of ['东南卫视', '厦门卫视', '三沙卫视', '兵团卫视']) {
    assert.ok(simple.includes('group-title="卫视",' + name + '\n'), name + ' should be in 卫视');
  }

  assert.ok(simple.includes('group-title="少儿",北京KAKU少儿\n'));
  assert.ok(simple.includes('group-title="少儿",金鹰卡通\n'));
  assert.ok(simple.includes('group-title="专业",金鹰纪实\n'));
  assert.ok(simple.includes('group-title="地方",佛山南海\n'));
  assert.ok(simple.includes('group-title="地方",佛山顺德\n'));
});
