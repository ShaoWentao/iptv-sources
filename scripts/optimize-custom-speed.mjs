import fs from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const targetPath = path.join(root, 'config', 'target-channels.json');
const reportPath = path.join(m3uDir, 'custom-report.json');
const backupsPath = path.join(m3uDir, 'custom-backups.json');
const customPath = path.join(m3uDir, 'custom.m3u');

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function cleanMetaValue(value = '') {
  return String(value).replace(/"/g, '').trim();
}

function qualityRank(item = {}) {
  const label = String(item.qualityLabel || item.resolution || '').toLowerCase();
  const height = Number(String(item.resolution || '').match(/x(\d{3,5})/)?.[1] || 0);

  if (/8k|4320/.test(label) || height >= 4320) return 8;
  if (/4k|2160/.test(label) || height >= 2160) return 7;
  if (/1080/.test(label) || height >= 1080) return 6;
  if (/720/.test(label) || height >= 720) return 5;
  if (/576/.test(label) || height >= 576) return 4;
  if (/480|360|标清|低清|sd/.test(label) || (height > 0 && height < 576)) return 2;
  return 3;
}

function latencyMs(item = {}) {
  const value = Number(item.latencyMs || 99999);
  return Number.isFinite(value) && value > 0 ? value : 99999;
}

function speedScore(item = {}) {
  const officialBoost = item.official || item.officialForced ? 1000000 : 0;
  const latency = latencyMs(item);
  const quality = qualityRank(item);
  const bandwidth = Number(item.bandwidth || 0);

  let score = officialBoost;

  // 1080P and 720P usually start faster and remain watchable.
  if (quality === 6) score += 80000;
  else if (quality === 5) score += 70000;
  else if (quality === 4) score += 50000;
  else if (quality >= 7) score += 35000;
  else score += 20000;

  // Very high-bitrate 4K/8K sources often slow down first-frame response.
  if (quality >= 7 && !item.official && !item.officialForced) score -= 30000;
  if (bandwidth > 12000000 && !item.official && !item.officialForced) score -= 15000;

  score -= Math.min(latency, 15000) * 25;

  return score;
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
    console.log('[SPEED] custom-report.json not found, skip.');
    return;
  }

  const targetConfig = readJson(targetPath, {});
  const reportJson = readJson(reportPath, { report: [] });
  const lines = [`#EXTM3U${targetConfig.epgUrl ? ` x-tvg-url="${targetConfig.epgUrl}"` : ''}`];
  const nextReport = [];
  const nextBackups = [];
  const changes = [];

  for (const channel of reportJson.report || []) {
    const candidates = [];
    if (channel.selected) candidates.push(normalizeCandidate(channel.selected));
    for (const backup of channel.backups || []) candidates.push(normalizeCandidate(backup));

    const unique = [];
    const seen = new Set();
    for (const item of candidates) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      unique.push(item);
    }

    unique.sort((a, b) => speedScore(b) - speedScore(a));

    const selected = unique[0] || null;
    const backups = unique.slice(1).map((item, index) => ({ order: index + 1, ...item }));

    if (channel.selected?.url && selected?.url && channel.selected.url !== selected.url) {
      changes.push({
        channel: channel.name,
        from: {
          title: channel.selected.title,
          sourceName: channel.selected.sourceName,
          latencyMs: channel.selected.latencyMs,
          resolution: channel.selected.resolution,
          url: channel.selected.url,
        },
        to: {
          title: selected.title,
          sourceName: selected.sourceName,
          latencyMs: selected.latencyMs,
          resolution: selected.resolution,
          url: selected.url,
        },
      });
    }

    nextReport.push({
      ...channel,
      count: unique.length,
      selected,
      backups,
    });

    if (!selected) continue;

    nextBackups.push({
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
  await writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), report: nextReport }, null, 2), 'utf-8');
  await writeFile(backupsPath, JSON.stringify({ generatedAt: new Date().toISOString(), channels: nextBackups }, null, 2), 'utf-8');
  await writeFile(
    path.join(m3uDir, 'custom-speed-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), changedCount: changes.length, changes }, null, 2),
    'utf-8'
  );

  console.log(`[SPEED] Optimized custom.m3u for faster start: ${changes.length} main sources changed`);
}

main().catch((error) => {
  console.error('[SPEED] Failed:', error);
  process.exitCode = 1;
});
