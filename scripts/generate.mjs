#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  GROUP_ORDER,
  parsePlaylist,
  filterEntries,
  buildQualityEvidence,
  selectBestEntries,
  classifyChannel,
  renderPlaylist,
  sha256,
} from './playlist.mjs';

function argsFrom(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function read(pathname, required = false) {
  if (!pathname || !fs.existsSync(pathname)) {
    if (required) throw new Error(`Missing required file: ${pathname || '(unset)'}`);
    return '';
  }
  const text = fs.readFileSync(pathname, 'utf8');
  if (required && !text.trim()) throw new Error(`Required file is empty: ${pathname}`);
  return text;
}

function writeAtomic(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, filename);
}

const args = argsFrom(process.argv.slice(2));
const allText = read(args.all, true);
const hdText = read(args.hd);
const fourKText = read(args['4k']);
const epgText = read(args.epg);
const config = JSON.parse(read(args.config || 'config/udpxy.json', true));
const outputDir = path.resolve(String(args.output || 'm3u'));
const upstreamSha = String(args['upstream-sha'] || 'unknown');

const allEntries = parsePlaylist(allText);
if (allEntries.length < 100) throw new Error(`Upstream full playlist has only ${allEntries.length} entries`);
const hdEntries = parsePlaylist(hdText);
const fourKEntries = parsePlaylist(fourKText);
const filtered = filterEntries(allEntries);
const evidence = buildQualityEvidence({ hd: hdEntries, fourK: fourKEntries });
const selected = selectBestEntries(filtered.entries, evidence);
if (selected.length < 50) throw new Error(`Generated playlist has only ${selected.length} channels`);

const playlist = renderPlaylist(selected, config);
if (/CAVS|时移|rtp:\/\//i.test(playlist)) throw new Error('Blocked source leaked into output');
const groups = Object.fromEntries(GROUP_ORDER.map((group) => [group, 0]));
for (const entry of selected) groups[classifyChannel(entry)] += 1;
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  upstreamRepository: 'Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List',
  upstreamSha,
  udpxy: config,
  inputs: {
    all: { entries: allEntries.length, sha256: sha256(allText) },
    hd: { entries: hdEntries.length, sha256: sha256(hdText) },
    fourK: { entries: fourKEntries.length, sha256: sha256(fourKText) },
    epg: { bytes: Buffer.byteLength(epgText), sha256: sha256(epgText) },
  },
  filtered: filtered.stats,
  selectedChannels: selected.length,
  groups,
  selections: selected.map((entry) => ({
    channel: entry.channel,
    group: classifyChannel(entry),
    sourceName: entry.name,
    rtpUrl: entry.rtpUrl,
    quality: entry.selection.quality,
    evidence: entry.selection.evidence,
    candidateCount: entry.candidateCount,
  })),
};

writeAtomic(path.join(outputDir, 'gd-telecom.m3u'), playlist);
writeAtomic(path.join(outputDir, 'gd-telecom-report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (epgText.trim()) writeAtomic(path.join(outputDir, 'gd-telecom-epg.xml'), epgText);
console.log(`Generated ${selected.length} channels`);
