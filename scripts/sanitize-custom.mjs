import fs from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const blocklistPath = path.join(root, 'config', 'source-blocklist.json');
const groupPolicyPath = path.join(root, 'config', 'group-source-policy.json');
const targetPath = path.join(root, 'config', 'target-channels.json');
const reportPath = path.join(m3uDir, 'custom-report.json');
const backupsPath = path.join(m3uDir, 'custom-backups.json');
const customPath = path.join(m3uDir, 'custom.m3u');

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function toRegexList(values = []) {
  return values.map((value) => new RegExp(value, 'i'));
}

function cleanMetaValue(value = '') {
  return String(value).replace(/"/g, '').trim();
}

function buildMatcher(blocklist, groupPolicy) {
  const urlPatterns = toRegexList(blocklist.blockedUrlPatterns || []);
  const sourcePatterns = toRegexList(blocklist.blockedSourcePatterns || []);
  const titlePatterns = toRegexList(blocklist.blockedTitlePatterns || []);

  return (item = {}, channel = {}) => {
    const policy = groupPolicy.groups?.[channel.group] || {};
    if (policy.requireOfficial && !(item.official || item.officialForced)) {
      return { blocked: true, reason: `group-policy:${channel.group}:require-official` };
    }

    if (item.official || item.officialForced) return { blocked: false, reason: '' };

    const url = String(item.url || '');
    const source = String(item.sourceName || '');
    const title = String(item.title || item.sourceTitle || '');

    const byUrl = urlPatterns.find((reg) => reg.test(url));
    if (byUrl) return { blocked: true, reason: `blocked-url-pattern:${byUrl.source}` };

    const bySource = sourcePatterns.find((reg) => reg.test(source));
    if (bySource) return { blocked: true, reason: `blocked-source-pattern:${bySource.source}` };

    const byTitle = titlePatterns.find((reg) => reg.test(title));
    if (byTitle) return { blocked: true, reason: `blocked-title-pattern:${byTitle.source}` };

    return { blocked: false, reason: '' };
  };
}

function normalizeCandidate(item = {}) {
  return {
    title: item.title || item.sourceTitle || '',
    sourceName: item.sourceName || '',
    official: Boolean(item.official),
    officialForced: Boolean(item.officialForced),
    officialPage: item.officialPage || '',
    latencyMs: item.latencyMs,
    resolution: item.resolution,
    qualityLabel: item.qualityLabel,
    bandwidth: item.bandwidth,
    qualityScore: item.qualityScore,
    url: item.url || '',
  };
}

function makeExtinf(target, selected) {
  const title = cleanMetaValue(selected.title || target.name);
  const resolution = selected.resolution ? ` resolution="${selected.resolution}"` : '';
  const quality = selected.qualityLabel ? ` quality="${selected.qualityLabel}"` : '';
  const official = selected.official || selected.officialForced ? ' official="true"' : '';
  const latency = selected.latencyMs ? ` latency="${selected.latencyMs}ms"` : '';
  return `#EXTINF:-1 tvg-name="${target.name}" group-title="${target.group}" source-title="${title}"${resolution}${quality}${official}${latency},${target.name}`;
}

async function main() {
  if (!fs.existsSync(reportPath)) {
    console.log('[SANITIZE] custom-report.json not found, skip.');
    return;
  }

  const blocklist = readJson(blocklistPath, {});
  const groupPolicy = readJson(groupPolicyPath, { groups: {} });
  const targetConfig = readJson(targetPath, {});
  const reportJson = readJson(reportPath, { report: [] });
  const isBlocked = buildMatcher(blocklist, groupPolicy);
  const removed = [];
  const lines = [`#EXTM3U${targetConfig.epgUrl ? ` x-tvg-url="${targetConfig.epgUrl}"` : ''}`];
  const sanitizedReport = [];
  const sanitizedBackups = [];

  for (const channel of reportJson.report || []) {
    const candidates = [];
    if (channel.selected) candidates.push(normalizeCandidate(channel.selected));
    for (const backup of channel.backups || []) candidates.push(normalizeCandidate(backup));

    const clean = [];
    for (const candidate of candidates) {
      const result = isBlocked(candidate, channel);
      if (result.blocked) {
        removed.push({
          channel: channel.name,
          group: channel.group,
          title: candidate.title,
          sourceName: candidate.sourceName,
          url: candidate.url,
          reason: result.reason,
        });
      } else if (candidate.url) {
        clean.push(candidate);
      }
    }

    const selected = clean[0] || null;
    const backups = clean.slice(1).map((item, index) => ({ order: index + 1, ...item }));

    sanitizedReport.push({
      ...channel,
      count: clean.length,
      selected,
      backups,
    });

    if (!selected) continue;

    sanitizedBackups.push({
      name: channel.name,
      group: channel.group,
      main: selected.url,
      mainOfficial: selected.official || selected.officialForced,
      backups: backups.map((item) => item.url),
      sources: [selected, ...backups].map((item, index) => ({
        role: index === 0 ? 'main' : 'backup',
        title: item.title,
        sourceName: item.sourceName,
        official: item.official || item.officialForced,
        officialForced: item.officialForced,
        officialPage: item.officialPage || '',
        latencyMs: item.latencyMs,
        resolution: item.resolution,
        qualityLabel: item.qualityLabel,
        bandwidth: item.bandwidth,
        qualityScore: item.qualityScore,
        url: item.url,
      })),
    });

    lines.push('');
    lines.push(makeExtinf(channel, selected));
    lines.push(selected.url);
  }

  await mkdir(m3uDir, { recursive: true });
  await writeFile(customPath, `${lines.join('\n')}\n`, 'utf-8');
  await writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), report: sanitizedReport }, null, 2), 'utf-8');
  await writeFile(backupsPath, JSON.stringify({ generatedAt: new Date().toISOString(), channels: sanitizedBackups }, null, 2), 'utf-8');
  await writeFile(
    path.join(m3uDir, 'custom-sanitize-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), removedCount: removed.length, removed }, null, 2),
    'utf-8'
  );

  console.log(`[SANITIZE] Removed ${removed.length} blocked custom sources`);
}

main().catch((error) => {
  console.error('[SANITIZE] Failed:', error);
  process.exitCode = 1;
});
