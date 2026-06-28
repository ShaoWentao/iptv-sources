import fs from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const root = process.cwd();
const m3uDir = path.join(root, 'm3u');
const distributionPath = path.join(root, 'config', 'distribution-candidates.json');
const targetPath = path.join(root, 'config', 'target-channels.json');

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function normalizeChannel(channel = '') {
  return String(channel)
    .trim()
    .replace(/^CCTV(\d+)/i, 'CCTV-$1')
    .replace(/^CCTV5\+$/i, 'CCTV-5+')
    .replace(/^CCTV16$/i, 'CCTV-16');
}

function buildTargetSet(targetConfig) {
  const set = new Set();
  for (const group of targetConfig.groups || []) {
    for (const channel of group.channels || []) set.add(channel);
  }
  return set;
}

function buildProfile({ name, title, filter, distributionConfig, targetConfig }) {
  const targetSet = buildTargetSet(targetConfig);
  const lines = [
    '#EXTM3U',
    `# ${title}`,
    '# Network-scoped playlist. Some sources may only work on the matching ISP or local network.',
  ];
  const report = [];
  const seen = new Set();

  for (const stream of distributionConfig.streams || []) {
    if (!filter(stream)) continue;
    const channel = normalizeChannel(stream.channel);
    if (!targetSet.has(channel) && !['咪咕4K', '咪咕视频4K', '五星体育'].includes(channel)) continue;
    if (!/^https?:\/\//i.test(stream.url || '')) continue;
    const key = `${channel}\t${stream.url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const group = stream.type === 'operatorNetworkIptv' ? '运营商IPTV' : '分发平台候选';
    const sourceTitle = String(stream.title || channel).replace(/"/g, '');
    lines.push('');
    lines.push(
      `#EXTINF:-1 tvg-name="${channel}" group-title="${group}" source-title="${sourceTitle}" source-type="${stream.type || ''}",${channel}`
    );
    lines.push(stream.url);

    report.push({
      channel,
      title: stream.title || channel,
      url: stream.url,
      type: stream.type || '',
      providerHint: stream.providerHint || '',
      accessScope: stream.accessScope || '',
      recommendedUse: stream.recommendedUse || '',
      mainPlaylist: Boolean(stream.mainPlaylist),
    });
  }

  return {
    filename: `${name}.m3u`,
    reportFilename: `${name}-report.json`,
    text: `${lines.join('\n')}\n`,
    report,
  };
}

async function main() {
  const distributionConfig = readJson(distributionPath, { streams: [] });
  const targetConfig = readJson(targetPath, { groups: [] });
  await mkdir(m3uDir, { recursive: true });

  const profiles = [
    buildProfile({
      name: 'custom-gd-mobile',
      title: 'Guangdong Mobile IPTV candidate playlist',
      distributionConfig,
      targetConfig,
      filter: (stream) => stream.type === 'operatorNetworkIptv' && /gmcc|广东移动|移动宽带/i.test([stream.url, stream.providerHint, stream.accessScope].join(' ')),
    }),
    buildProfile({
      name: 'custom-distribution-candidates',
      title: 'Distribution platform candidate playlist for manual testing',
      distributionConfig,
      targetConfig,
      filter: (stream) => ['platformRedirect', 'thirdPartyProxy'].includes(stream.type),
    }),
  ];

  for (const profile of profiles) {
    await writeFile(path.join(m3uDir, profile.filename), profile.text, 'utf-8');
    await writeFile(
      path.join(m3uDir, profile.reportFilename),
      JSON.stringify({ generatedAt: new Date().toISOString(), count: profile.report.length, streams: profile.report }, null, 2),
      'utf-8'
    );
    console.log(`[NETWORK] Write ${profile.filename}: ${profile.report.length} URLs`);
  }
}

main().catch((error) => {
  console.error('[NETWORK] Build network profile playlists failed:', error);
  process.exitCode = 1;
});
