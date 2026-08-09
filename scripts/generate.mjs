#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  GROUP_ORDER,
  canonicalRtpUrl,
  parsePlaylist,
  filterEntries,
  buildQualityEvidence,
  selectAllEntries,
  selectBestEntries,
  classifyChannel,
  renderPlaylist,
  renderRtpPlaylist,
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

function countLinesByChannel(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.channel, (counts.get(entry.channel) || 0) + 1);
  return counts;
}

function cavsUrlsFromProbe(text) {
  const urls = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!/\bV:\s*cavs\b/i.test(raw)) continue;
    const match = raw.match(/^\s*((?:\d{1,3}\.){3}\d{1,3}:\d{1,5})\b/);
    if (!match) continue;
    const url = canonicalRtpUrl(`rtp://${match[1]}`);
    if (url) urls.add(url);
  }
  return urls;
}

const args = argsFrom(process.argv.slice(2));
const allText = read(args.all, true);
const hdText = read(args.hd);
const fourKText = read(args['4k']);
const probeText = read(args.probe);
const epgText = read(args.epg);
const config = JSON.parse(read(args.config || 'config/udpxy.json', true));
const outputDir = path.resolve(String(args.output || 'm3u'));
const upstreamSha = String(args['upstream-sha'] || 'unknown');

const allEntries = parsePlaylist(allText);
if (allEntries.length < 100) throw new Error(`Upstream full playlist has only ${allEntries.length} entries`);
const hdEntries = parsePlaylist(hdText);
const fourKEntries = parsePlaylist(fourKText);
const evidence = buildQualityEvidence({ hd: hdEntries, fourK: fourKEntries });
const cavsProbeUrls = cavsUrlsFromProbe(probeText);

const combinedEntries = [...allEntries, ...hdEntries, ...fourKEntries]
  .map((entry, index) => ({ ...entry, index }));
const baseFiltered = filterEntries(combinedEntries, { excludeUltraHd: false });
let cavsProbe = 0;
const probeFilteredEntries = baseFiltered.entries.filter((entry) => {
  if (!cavsProbeUrls.has(entry.rtpUrl)) return true;
  cavsProbe += 1;
  return false;
});
const filtered = {
  entries: probeFilteredEntries,
  stats: { ...baseFiltered.stats, cavsProbe },
};
const allRanked = selectAllEntries(filtered.entries, evidence);
const best = selectBestEntries(filtered.entries, evidence);
if (best.length < 50) throw new Error(`Generated playlist has only ${best.length} channels`);

const playlist = renderRtpPlaylist(allRanked, { name: '广东电信IPTV' });
if (/CAVS|时移|回看/i.test(playlist)) throw new Error('Blocked source leaked into RTP primary output');
if (/https?:\/\/[^\n]*\/udp\//i.test(playlist)) throw new Error('udpxy URL leaked into RTP primary output');

const udpxyPlaylist = renderPlaylist(best, config);
if (/CAVS|时移|回看|rtp:\/\//i.test(udpxyPlaylist)) throw new Error('Blocked source leaked into udpxy backup output');

const ultraHdCandidates = filtered.entries.filter((entry) => {
  const label = `${entry.name || ''} ${entry.tvgName || ''}`;
  return /8K|4K|UHD|超高清/i.test(label) || evidence.get(entry.rtpUrl)?.has('4k');
});
const ultraHdRanked = selectAllEntries(ultraHdCandidates, evidence);
const ultraHdPlaylist = renderRtpPlaylist(ultraHdRanked, { name: '广东电信IPTV 4K' });
if (/CAVS|时移|回看/i.test(ultraHdPlaylist)) throw new Error('Blocked source leaked into 4K output');
if (/https?:\/\/[^\n]*\/udp\//i.test(ultraHdPlaylist)) throw new Error('udpxy URL leaked into 4K output');

const groups = Object.fromEntries(GROUP_ORDER.map((group) => [group, 0]));
for (const entry of best) groups[classifyChannel({ ...entry, name: entry.channel, tvgName: entry.channel })] += 1;

const lineCounts = countLinesByChannel(allRanked);
const multiLineChannels = [...lineCounts.values()].filter((count) => count > 1).length;
const maxLinesPerChannel = lineCounts.size ? Math.max(...lineCounts.values()) : 0;
const report = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  upstreamRepository: 'Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List',
  upstreamSha,
  udpxy: config,
  inputs: {
    all: { entries: allEntries.length, sha256: sha256(allText) },
    hd: { entries: hdEntries.length, sha256: sha256(hdText) },
    fourK: { entries: fourKEntries.length, sha256: sha256(fourKText) },
    probe: { bytes: Buffer.byteLength(probeText), sha256: sha256(probeText), cavsUrls: cavsProbeUrls.size },
    epg: { bytes: Buffer.byteLength(epgText), sha256: sha256(epgText) },
  },
  filtered: filtered.stats,
  selectedChannels: best.length,
  selectedLines: allRanked.length,
  multiLineChannels,
  maxLinesPerChannel,
  ultraHdSelectedChannels: new Set(ultraHdRanked.map((entry) => entry.channel)).size,
  ultraHdSelectedLines: ultraHdRanked.length,
  groups,
  selections: best.map((entry) => ({
    channel: entry.channel,
    group: classifyChannel({ ...entry, name: entry.channel, tvgName: entry.channel }),
    sourceName: entry.name,
    rtpUrl: entry.rtpUrl,
    quality: entry.selection.quality,
    evidence: entry.selection.evidence,
    candidateCount: entry.candidateCount,
  })),
};

writeAtomic(path.join(outputDir, 'gd-telecom.m3u'), playlist);
writeAtomic(path.join(outputDir, 'gd-telecom-udpxy.m3u'), udpxyPlaylist);
writeAtomic(path.join(outputDir, 'gd-telecom-4k.m3u'), ultraHdPlaylist);
writeAtomic(path.join(outputDir, 'gd-telecom-report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (epgText.trim()) writeAtomic(path.join(outputDir, 'gd-telecom-epg.xml'), epgText);
console.log(`Generated ${best.length} channels / ${allRanked.length} RTP lines; ${ultraHdRanked.length} ultra-HD lines; removed ${cavsProbe} probe-detected CAVS lines`);
