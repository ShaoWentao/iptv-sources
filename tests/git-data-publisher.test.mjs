import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  gitBlobSha,
  findChangedFiles,
} from '../scripts/lib/git-data-publisher.mjs';

test('computes the canonical Git blob SHA for an EPG file larger than 1 MB', () => {
  const content = Buffer.alloc(1_408_368, 0x61);
  const expected = crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
    .digest('hex');

  assert.equal(gitBlobSha(content), expected);
});

test('selects only generated files whose Git blob SHA changed', () => {
  const playlist = Buffer.from('#EXTM3U\n');
  const report = Buffer.from('{"selectedChannels":195}\n');
  const epg = Buffer.from('<?xml version="1.0"?><tv></tv>');
  const files = [
    { path: 'm3u/gd-telecom.m3u', content: playlist },
    { path: 'm3u/gd-telecom-report.json', content: report },
    { path: 'm3u/gd-telecom-epg.xml', content: epg },
  ];
  const currentShas = new Map([
    ['m3u/gd-telecom.m3u', gitBlobSha(playlist)],
    ['m3u/gd-telecom-report.json', '0'.repeat(40)],
    ['m3u/gd-telecom-epg.xml', gitBlobSha(epg)],
  ]);

  const changed = findChangedFiles(files, currentShas);

  assert.deepEqual(changed.map((file) => file.path), ['m3u/gd-telecom-report.json']);
  assert.equal(changed[0].blobSha, gitBlobSha(report));
});
