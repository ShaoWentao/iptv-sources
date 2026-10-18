import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const url = (id, fmt) => `http://120.87.19.109/PLTV/88888973/224/${id}/index.m3u8?fmt=ts2hls,${fmt},01.m3u8`;

test('verified supplement obeys Unicom whitelist and existing quality selection without mixing multicast', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'unicom-supplement-'));
  try {
    fs.writeFileSync(path.join(temp, 'primary.txt'), Array.from({ length: 22 }, (_, i) => `频道${i},${url(i, '244')}`).join('\n'));
    fs.writeFileSync(path.join(temp, 'secondary.m3u'), '#EXTM3U\n');
    fs.writeFileSync(path.join(temp, 'supplement.json'), JSON.stringify({ schemaVersion: 1, provenance: [], unicast: [
      { name: '新增高清', url: url(100, '744') },
      { name: '新增高清', url: url(101, '244') },
      { name: '低清兜底', url: url(102, '744') },
      { name: '低清兜底', url: url(103, '504') },
      { name: '频道0', url: url(104, '504') },
      { name: '非联通', url: 'http://chinamobile.com/index.m3u8' },
      { name: '混入组播', url: 'igmp://239.0.1.1:5001' },
    ].map(e => ({ ...e, playbackStatus: 'verified' })), multicast: [
      { name: '组播高清', url: 'igmp://239.0.1.1:5001', quality: 'hd' },
      { name: '组播高清', url: 'igmp://239.0.1.2:5002', quality: 'sd' },
      { name: '组播低清', url: 'igmp://239.0.1.3:5003', quality: 'sd' },
      { name: '组播低清', url: 'igmp://239.0.1.4:5004', quality: 'sd' },
      { name: '冲突A', url: 'igmp://239.0.1.5:5005', quality: '4k' },
      { name: '冲突B', url: 'igmp://239.0.1.5:5005', quality: '4k' },
      { name: '公网假组播', url: 'igmp://8.8.8.8:2000', quality: 'hd' },
      { name: '越界端口', url: 'igmp://239.0.1.6:65536', quality: 'hd' },
    ] }));
    const result = spawnSync(process.execPath, ['scripts/generate-unicom.mjs', '--input', path.join(temp, 'primary.txt'), '--input-secondary', path.join(temp, 'secondary.m3u'), '--supplement', path.join(temp, 'supplement.json'), '--output', temp], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const main = fs.readFileSync(path.join(temp, 'gd-unicom.m3u'), 'utf8');
    assert.ok(main.includes(url(101, '244')));
    assert.ok(!main.includes(url(100, '744')));
    assert.ok(main.includes(url(102, '744')));
    assert.ok(!main.includes(url(103, '504')));
    assert.ok(!main.includes(url(104, '504')));
    assert.doesNotMatch(main, /chinamobile|igmp:\/\/|udp:\/\/|rtp:\/\//);
    const report = JSON.parse(fs.readFileSync(path.join(temp, 'gd-unicom-report.json')));
    assert.deepEqual(report.supplement.addedChannels, ['新增高清', '低清兜底']);
    assert.equal(report.supplement.rejectedEntries, 2);
    const multi = fs.readFileSync(path.join(temp, 'gd-unicom-multicast.m3u'), 'utf8');
    const rtp = fs.readFileSync(path.join(temp, 'gd-unicom-multicast-rtp.m3u'), 'utf8');
    assert.match(multi, /udp:\/\/@239\.0\.1\.1:5001/);
    assert.match(rtp, /rtp:\/\/239\.0\.1\.1:5001/);
    assert.doesNotMatch(multi, /239\.0\.1\.(?:2|4|5|6):|8\.8\.8\.8|https?:|igmp:\/\//);
    const mr = JSON.parse(fs.readFileSync(path.join(temp, 'gd-unicom-multicast-report.json')));
    assert.equal(mr.reachability, 'not-verified');
    assert.equal(mr.transport, 'unknown');
    assert.equal(mr.conflicts.length, 1);
    assert.equal(mr.rejectedEntries, 2);
    assert.equal(mr.selectedChannels, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('keeps unknown-resolution playback-tested alternatives behind 1080 while excluding SD and timed-out hosts', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'unicom-tested-alternates-'));
  try {
    fs.writeFileSync(path.join(temp, 'primary.txt'),
      Array.from({ length: 22 }, (_, i) => `频道${i},${url(i, '244')}`)
        .concat([`低清原线,${url(555, '744')}`]).join('\n'));
    fs.writeFileSync(path.join(temp, 'secondary.m3u'), '#EXTM3U\n');
    const alternative = `http://112.89.33.7:80/PLTV/88888973/224/99999/asset.smil/01.m3u8?fmt=ts2hls,1706,01.m3u8`;
    const alternativeSd = `http://112.89.33.4:80/PLTV/88888973/224/99998/asset.smil/01.m3u8?fmt=ts2hls,744,01.m3u8`;
    const blockedHost = `http://112.89.45.23:80/PLTV/88888973/224/99997/asset.smil/01.m3u8?fmt=ts2hls,1707,01.m3u8`;
    const newChannel = `http://120.87.4.29:80/PLTV/88888973/224/99996/asset.smil/01.m3u8?fmt=ts2hls,1666,01.m3u8`;
    const sdOnlyBackup = `http://112.89.33.4:80/PLTV/88888973/224/99995/asset.smil/01.m3u8?fmt=ts2hls,1705,01.m3u8`;
    const supplements = [
      { name: '频道0', url: alternative, playbackStatus: 'verified', verifiedAlternate: true },
      { name: '频道0', url: alternativeSd, playbackStatus: 'verified', verifiedAlternate: true },
      { name: '频道0', url: blockedHost, playbackStatus: 'verified', verifiedAlternate: true },
      { name: '阳江综合', url: newChannel, playbackStatus: 'verified' },
      { name: '低清原线', url: sdOnlyBackup, playbackStatus: 'verified', verifiedAlternate: true },
    ];
    fs.writeFileSync(path.join(temp, 'supplement.json'),
      JSON.stringify({ schemaVersion: 1, provenance: [], unicast: supplements, multicast: [] }));
    const result = spawnSync(process.execPath,
      ['scripts/generate-unicom.mjs', '--input', path.join(temp, 'primary.txt'),
        '--input-secondary', path.join(temp, 'secondary.m3u'),
        '--supplement', path.join(temp, 'supplement.json'), '--output', temp], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const main = fs.readFileSync(path.join(temp, 'gd-unicom.m3u'), 'utf8');
    const simple = fs.readFileSync(path.join(temp, 'gd-unicom-simple.m3u'), 'utf8');
    assert.ok(main.includes(alternative), 'Verified unknown-resolution backup should be present');
    assert.ok(!main.includes(alternativeSd), 'Verified SD must be excluded when HD exists');
    assert.ok(!main.includes(blockedHost), 'Timed-out host cannot be accepted');
    assert.ok(main.includes(newChannel), 'Verified new channel should enter main');
    assert.ok(simple.includes(newChannel));
    assert.ok(main.includes(sdOnlyBackup), 'Unknown-resolution backup must survive beside an existing SD-only feed');
    assert.ok(!simple.includes(sdOnlyBackup), 'Simple playlist should retain the single existing low-quality fallback');
    assert.ok(!simple.includes(alternative), 'Simple list should prefer existing 1080 source');
    const report = JSON.parse(fs.readFileSync(path.join(temp, 'gd-unicom-report.json'), 'utf8'));
    assert.deepEqual(report.supplement.addedChannels, ['阳江综合']);
    assert.ok(report.supplement.addedAlternateLines.includes('频道0'));
    assert.equal(report.supplement.rejectedEntries, 1);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('unverified attachment URLs stay out of main playlists and remain in an explicit candidate file', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'unicom-unverified-'));
  try {
    fs.writeFileSync(path.join(temp, 'primary.txt'), Array.from({ length: 22 }, (_, i) => `频道${i},${url(i, '244')}`).join('\n'));
    fs.writeFileSync(path.join(temp, 'secondary.m3u'), '#EXTM3U\n');
    fs.writeFileSync(path.join(temp, 'supplement.json'), JSON.stringify({ schemaVersion: 1, provenance: [],
      unicast: [{ name: '旧鉴权频道', url: url(200, '143'), playbackStatus: 'unverified' }], multicast: [] }));
    const result = spawnSync(process.execPath, ['scripts/generate-unicom.mjs', '--input', path.join(temp, 'primary.txt'), '--input-secondary', path.join(temp, 'secondary.m3u'), '--supplement', path.join(temp, 'supplement.json'), '--output', temp], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const file of ['gd-unicom.m3u', 'gd-unicom-simple.m3u']) {
      assert.doesNotMatch(fs.readFileSync(path.join(temp, file), 'utf8'), /旧鉴权频道|\/200\//);
    }
    const candidates = fs.readFileSync(path.join(temp, 'gd-unicom-unverified.m3u'), 'utf8');
    assert.match(candidates, /UNVERIFIED/);
    assert.ok(candidates.includes(url(200, '143')));
    const report = JSON.parse(fs.readFileSync(path.join(temp, 'gd-unicom-report.json')));
    assert.deepEqual(report.supplement.addedChannels, []);
    assert.deepEqual(report.supplement.quarantinedChannels, ['旧鉴权频道']);
    assert.equal(report.selectedChannels, 22);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('2026-10-18 batch excludes all 55 timed-out URLs, retains 160 verified candidates and quarantines eight name collisions', () => {
  const audit = JSON.parse(fs.readFileSync('docs/gd-unicom-batch-verification-20261018.json', 'utf8'));
  const source = fs.readFileSync('m3u/gd-unicom-test-untested-batch-20261018.m3u', 'utf8');
  const supplement = JSON.parse(fs.readFileSync('config/gd-unicom-supplement.json', 'utf8'));
  assert.equal(audit.initialCount, 223);
  assert.equal(audit.normalPlaybackCount, 168);
  assert.equal(audit.timeoutCount, 55);
  assert.equal(audit.importedAsVerifiedAlternate, 160);
  assert.equal(audit.heldForNameCheck, 8);
  const batchItems = new Map();
  let current = '';
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('#EXTINF:')) {
      current = line.slice(line.indexOf(',') + 1).match(/^(\d{3}) /)?.[1] || '';
    } else if (current && /^http:\/\//.test(line)) {
      batchItems.set(current, line); current = '';
    }
  }
  assert.equal(batchItems.size, 223);
  const allowed = new Set(supplement.unicast.filter(e => e.playbackStatus === 'verified').map(e => e.url));
  for (const e of audit.entries) {
    const url = batchItems.get(e.number);
    assert.ok(url, 'Missing original playback URL for ' + e.number);
    if (e.decision === 'verified-import') {
      assert.ok(allowed.has(url), 'A playback-confirmed line is missing from supplement: ' + e.number);
    } else {
      assert.ok(!allowed.has(url), 'Timed-out or misnamed line entered supplement: ' + e.number);
    }
  }
  for (const blocked of ['112.89.45.21', '112.89.45.22', '112.89.77.25', '112.89.77.26']) {
    assert.ok(!supplement.unicast.some(e => e.playbackStatus === 'verified' && new URL(e.url).hostname === blocked));
  }
});

test('reviewed attachment data preserves seven unverified legacy channels, and verified Yanbian TV, excluding Zhejiang and codec labels', () => {
  const data = JSON.parse(fs.readFileSync('config/gd-unicom-supplement.json', 'utf8'));
  assert.deepEqual(data.unicast.filter(e => e.playbackStatus !== 'verified').map(e => e.name),
    ['广东房产', '梨园频道', '靓装', 'CETV早期教育', '武术世界', '文物宝库', '环球奇观']);
  const yanbian = data.unicast.find(e => e.name === '延边卫视');
  assert.equal(yanbian?.playbackStatus, 'verified');
  assert.equal(yanbian?.sourceRepository, 'qist/tvbox');
  assert.match(yanbian.url, /^http:\/\/120\.87\.4\.17:80\/PLTV\/88888973\/224\/3221225725\//);
  assert.ok(!data.unicast.some(e => e.name === '精选4K频道' || e.name === '广东综艺'));
  assert.equal(data.importSummary.forumMulticastEntries, 190);
  assert.equal(data.importSummary.forumProxyEntries, 44);
  assert.equal(data.provenance[2].postId, '22003010');
  for (const entry of data.unicast) {
    const parsed = new URL(entry.url);
    assert.ok(/^120\.87\./.test(parsed.hostname)
      || /^112\.89\.33\.(?:4|5|6|7|8|9)$/.test(parsed.hostname)
      || parsed.hostname === '112.89.35.70'
      || /^112\.89\.121\.(?:21|22|23|24)$/.test(parsed.hostname)
      || /^112\.89\.77\.(?:21|22|23|24)$/.test(parsed.hostname),
      'Only user-tested Guangdong Unicom IPTV hosts may appear in the supplement');
    assert.match(parsed.pathname, /^\/PLTV\/88888973\/224\/\d+\//);
  }
  assert.ok(data.exclusions.some(e => e.reason === 'user-excluded-zhejiang'));
  assert.ok(data.exclusions.some(e => e.reason === 'unsupported-codec-label'));
  for (const entry of data.multicast) {
    assert.doesNotMatch(entry.name + entry.sourceName, /浙江|AVS2|CAVS/i);
    assert.match(entry.url, /^igmp:\/\/239\.0\.(?:1|10)\./);
    assert.notEqual(entry.name, 'CCTV164');
  }
  assert.ok(data.multicast.some(e => e.name === 'CCTV16' && e.quality === '4k'));
  const cctv5plus = data.multicast.filter(e => e.url === 'igmp://239.0.1.101:8004');
  assert.ok(cctv5plus.length > 0);
  assert.ok(cctv5plus.every(e => e.name === 'CCTV5+'));
  assert.ok(data.multicast.some(e => e.name === '北京纪实'));
  assert.ok(data.multicast.some(e => e.name === '上海纪实'));
});
