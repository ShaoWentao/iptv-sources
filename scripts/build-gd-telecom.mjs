#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  parseM3u,
  buildQualityEvidence,
  filterEntries,
  selectBestChannels,
  classifyChannel,
  renderPlaylist,
  sha256,
  GROUP_ORDER,
} from './lib/gd-telecom.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    args[key] = value;
  }
  return args;
}

function readRequired(filePath, label) {
  if (!filePath) throw new Error(`Missing --${label} input`);
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) throw new Error(`Empty ${label} input: ${filePath}`);
  return text;
}

function readOptional(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function validateConfig(config) {
  if (!config || !['http', 'https'].includes(config.protocol)) throw new Error('udpxy protocol must be http or https');
  if (!String(config.host || '').trim()) throw new Error('udpxy host is required');
  if (!Number.isInteger(Number(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535) throw new Error('udpxy port is invalid');
}

function validateOutput(playlist, selected, minOutput, config) {
  if (selected.length < minOutput) throw new Error(`Selected channel count ${selected.length} is below minimum ${minOutput}`);
  if (/CAVS|时移|rtp:\/\//i.test(playlist)) throw new Error('Output contains blocked text or RTP URLs');
  const outputUrls = [...playlist.matchAll(/^https?:\/\/[^\s]+$/gm)].map((m) => m[0]);
  if (outputUrls.length !== selected.length) throw new Error('Output URL count does not match selected channel count');
  const endpoint = `${config.protocol}://${config.host}:${config.port}/udp/`;
  if (!outputUrls.every((url) => url.startsWith(endpoint))) throw new Error('Output contains URLs outside configured udpxy endpoint');
  const names = selected.map((item) => item.channel);
  if (new Set(names).size !== names.length) throw new Error('Output contains duplicate normalized channels');
  const groups = new Set(selected.map((item) => classifyChannel(item)));
  for (const group of groups) if (!GROUP_ORDER.includes(group)) throw new Error(`Unexpected group: ${group}`);
}

function inputSummary(text, entries) {
  return { sha256: sha256(text), entries: entries.length };
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(String(args.config || 'config/udpxy.json'));
  const outputDir = path.resolve(String(args['output-dir'] || 'm3u'));
  const minInput = Number(args['min-input'] || 100);
  const minOutput = Number(args['min-output'] || 50);
  const upstreamSha = String(args['upstream-sha'] || 'unknown');

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  validateConfig(config);

  const allText = readRequired(args.all, 'all');
  const hdText = readOptional(args.hd);
  const sdText = readOptional(args.sd);
  const fourKText = readOptional(args['4k']);
  const epgText = readOptional(args.epg);

  const allEntries = parseM3u(allText);
  const hdEntries = parseM3u(hdText);
  const sdEntries = parseM3u(sdText);
  const fourKEntries = parseM3u(fourKText);
  if (allEntries.length < minInput) throw new Error(`Full input entry count ${allEntries.length} is below minimum ${minInput}`);

  const evidence = buildQualityEvidence({ hd: hdEntries, sd: sdEntries, fourK: fourKEntries });
  const filtered = filterEntries(allEntries);
  const selected = selectBestChannels(filtered.entries, evidence);
  const playlist = renderPlaylist(selected, config);
  validateOutput(playlist, selected, minOutput, config);

  const groupCounts = Object.fromEntries(GROUP_ORDER.map((group) => [group, 0]));
  for (const item of selected) groupCounts[classifyChannel(item)] += 1;

  const evidenceCounts = { fourKUrls: 0, hdUrls: 0, sdUrls: 0, overlaps: 0 };
  for (const tags of evidence.values()) {
    if (tags.has('4k')) evidenceCounts.fourKUrls += 1;
    if (tags.has('hd')) evidenceCounts.hdUrls += 1;
    if (tags.has('sd')) evidenceCounts.sdUrls += 1;
    if (tags.size > 1) evidenceCounts.overlaps += 1;
  }

  const report = {
    schemaVersion: 1,
    upstreamRepository: 'Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List',
    upstreamSha,
    udpxy: config,
    inputs: {
      all: inputSummary(allText, allEntries),
      hd: inputSummary(hdText, hdEntries),
      sd: inputSummary(sdText, sdEntries),
      fourK: inputSummary(fourKText, fourKEntries),
      epg: { sha256: sha256(epgText), bytes: Buffer.byteLength(epgText) },
    },
    filtered: filtered.stats,
    validAfterFiltering: filtered.entries.length,
    normalizedChannels: selected.length,
    selectedChannels: selected.length,
    qualityEvidence: evidenceCounts,
    groups: groupCounts,
    selections: selected.map((item) => ({
      channel: item.channel,
      group: classifyChannel(item),
      sourceName: item.name,
      tvgName: item.tvgName,
      rtpUrl: item.rtpUrl,
      score: item.selection.score,
      quality: item.selection.quality,
      evidence: item.selection.evidence,
      evidenceLabel: item.selection.evidenceLabel,
      candidateCount: item.candidateCount,
      removedCandidates: item.removedCandidates,
    })),
  };

  atomicWrite(path.join(outputDir, 'gd-telecom.m3u'), playlist);
  atomicWrite(path.join(outputDir, 'gd-telecom-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (epgText) atomicWrite(path.join(outputDir, 'gd-telecom-epg.xml'), epgText);

  process.stdout.write(`Generated ${selected.length} channels in ${outputDir}\n`);
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
}
