import fs from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const blocklistPath = path.join(root, 'config', 'source-blocklist.json');
const groupPolicyPath = path.join(root, 'config', 'group-source-policy.json');
const channelValidationPath = path.join(root, 'config', 'channel-validation.json');
const targetPath = path.join(root, 'config', 'target-channels.json');
const aliasPath = path.join(root, 'config', 'channel-aliases.json');
const reportPath = path.join(m3uDir, 'custom-report.json');
const backupsPath = path.join(m3uDir, 'custom-backups.json');
const customPath = path.join(m3uDir, 'custom.m3u');

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function normalizeName(input = '') {
  return String(input)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\-_—–·•.,，。:：()（）\[\]【】《》「」『』]/g, '')
    .replace(/高清|超清|蓝光|标清|频道|频道高清|hd|fhd|uhd|4k超高清|源\d+|线路\d+|备用\d*/g, '')
    .replace(/中央电视台/g, '央视')
    .trim();
}

function toRegexList(values = []) {
  return values.map((value) => new RegExp(value, 'i'));
}

function cleanMetaValue(value = '') {
  return String(value).replace(/"/g, '').trim();
}

function buildTargetAliasMap(targetConfig = {}, aliasesConfig = {}, validation = {}) {
  const broad = new Set((validation.broadAliases || []).map(normalizeName));
  const minSubstringAliasLength = Number(validation.minSubstringAliasLength || 4);
  const map = new Map();
  const allTargets = [];

  for (const group of targetConfig.groups || []) {
    for (const name of group.channels || []) {
      const aliases = [name, ...(aliasesConfig[name] || [])]
        .map((value) => ({ raw: value, normalized: normalizeName(value) }))
        .filter((item) => item.normalized && !broad.has(item.normalized));

      const strongAliases = aliases.filter((item) => {
        if (item.normalized === normalizeName(name)) return true;
        if (/\d|[a-z]/i.test(item.normalized)) return true;
        return item.normalized.length >= minSubstringAliasLength;
      });

      map.set(name, strongAliases);
      allTargets.push({ name, group: group.name, aliases: strongAliases });
    }
  }

  return { map, allTargets };
}

function titleMatchesChannel(candidate = {}, channel = {}, aliasMap) {
  const title = normalizeName(candidate.title || candidate.sourceTitle || '');
  if (!title) return false;

  const aliases = aliasMap.get(channel.name) || [];
  return aliases.some((alias) => title === alias.normalized || title.includes(alias.normalized));
}

function titleContainsOtherTarget(candidate = {}, channel = {}, allTargets = []) {
  const title = normalizeName(candidate.title || candidate.sourceTitle || '');
  if (!title) return null;

  for (const target of allTargets) {
    if (target.name === channel.name) continue;
    for (const alias of target.aliases || []) {
      if (!alias.normalized) continue;
      if (title === alias.normalized || title.includes(alias.normalized)) {
        return target.name;
      }
    }
  }

  return null;
}

function buildMatcher(blocklist, groupPolicy, channelValidation, aliasMap, allTargets) {
  const urlPatterns = toRegexList(blocklist.blockedUrlPatterns || []);
  const sourcePatterns = toRegexList(blocklist.blockedSourcePatterns || []);
  const titlePatterns = toRegexList(blocklist.blockedTitlePatterns || []);

  return (item = {}, channel = {}) => {
    if (channelValidation.enabled && channelValidation.rejectIfOtherTargetInTitle) {
      const otherTarget = titleContainsOtherTarget(item, channel, allTargets);
      if (otherTarget) return { blocked: true, reason: `channel-mismatch:title-contains:${otherTarget}` };
    }

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

    if (channelValidation.enabled && channelValidation.strictTitleCheck && !titleMatchesChannel(item, channel, aliasMap)) {
      return { blocked: true, reason: `channel-mismatch:title-not-match:${channel.name}` };
    }

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
  const channelValidation = readJson(channelValidationPath, { enabled: false });
  const targetConfig = readJson(targetPath, {});
  const aliasesConfig = readJson(aliasPath, {});
  const reportJson = readJson(reportPath, { report: [] });
  const { map: aliasMap, allTargets } = buildTargetAliasMap(targetConfig, aliasesConfig, channelValidation);
  const isBlocked = buildMatcher(blocklist, groupPolicy, channelValidation, aliasMap, allTargets);
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
