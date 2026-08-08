import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, item, i, arr) => {
    if (item.startsWith('--')) acc.push([item.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const input = args.input;
const outputDir = args.output || 'm3u';
const upstreamSha = args['upstream-sha'] || 'unknown';

if (!input) throw new Error('Missing --input');

const text = fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/);

const entries = [];
let group = '其他';

for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;

  const comma = line.indexOf(',');
  if (comma < 1) continue;

  const name = line.slice(0, comma).trim();
  const value = line.slice(comma + 1).trim();

  if (value === '#genre#') {
    group = name || '其他';
    continue;
  }

  if (!/^https?:\/\//i.test(value)) continue;
  if (!/\.m3u8(?:\?|$)/i.test(value)) continue;

  entries.push({ name, group, url: value });
}

if (entries.length < 20) {
  throw new Error(`Upstream Guangdong Unicom list looks incomplete: ${entries.length} playable entries`);
}

// The primary playlist is APTV-oriented: keep all upstream lines so channels
// with multiple URLs retain their alternate streams. The simple playlist keeps
// only the first URL for each group + channel name pair for broader compatibility.
const seen = new Set();
const simple = [];
for (const entry of entries) {
  const key = `${entry.group}\u0000${entry.name}`;
  if (seen.has(key)) continue;
  seen.add(key);
  simple.push(entry);
}

function esc(value) {
  return String(value).replace(/"/g, "'");
}

function render(items) {
  const out = [
    '#EXTM3U',
    '# Generated from xisohi/CHINA-IPTV Guangdong Unicom unicast source',
    `# Upstream commit: ${upstreamSha}`,
  ];
  for (const item of items) {
    out.push(`#EXTINF:-1 tvg-name="${esc(item.name)}" group-title="${esc(item.group)}",${item.name}`);
    out.push(item.url);
  }
  return `${out.join('\n')}\n`;
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'gd-unicom.m3u'), render(entries));
fs.writeFileSync(path.join(outputDir, 'gd-unicom-simple.m3u'), render(simple));

const groups = {};
for (const item of simple) groups[item.group] = (groups[item.group] || 0) + 1;

const report = {
  schemaVersion: 2,
  upstream: 'xisohi/CHINA-IPTV',
  upstreamFile: 'Unicast/guangdong/unicom.txt',
  upstreamSha,
  upstreamEntries: entries.length,
  selectedChannels: simple.length,
  alternateEntries: entries.length - simple.length,
  groups,
  primaryPlaylistMode: 'all-lines-for-aptv',
  simplePlaylistMode: 'first-line-per-channel',
  note: 'Stream reachability is network-dependent and is not tested by GitHub Actions.',
};
fs.writeFileSync(path.join(outputDir, 'gd-unicom-report.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify(report, null, 2));
