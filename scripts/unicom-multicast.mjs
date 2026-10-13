import fs from 'node:fs';
import path from 'node:path';

const score = { normal: 0, sd: 1, hd: 2, '4k': 3 };

function addressOf(value) {
  // igmp:// in the supplied file describes group membership, not RTP framing.
  const match = String(value).match(/^igmp:\/\/(239\.0\.(?:1|10)\.\d{1,3}):(\d{1,5})$/);
  if (!match || match[1].split('.').some(n => Number(n) > 255)) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return `${match[1]}:${port}`;
}

export function generateMulticast(supplement, outputDir, unicastNames) {
  const owners = new Map();
  const valid = [];
  let rejectedEntries = 0;
  for (const item of supplement.multicast || []) {
    const address = addressOf(item.url);
    if (!address || !item.name || /[\r\n"]/.test(item.name) || !Object.hasOwn(score, item.quality)) {
      rejectedEntries += 1;
      continue;
    }
    if (!owners.has(address)) owners.set(address, new Set());
    owners.get(address).add(item.name);
    valid.push({ ...item, address });
  }
  const conflicts = [...owners].filter(([, names]) => names.size > 1)
    .map(([address, names]) => ({ address, channels: [...names] }));
  const conflictAddresses = new Set(conflicts.map(c => c.address));
  const buckets = new Map();
  const seen = new Set();
  for (const item of valid) {
    if (conflictAddresses.has(item.address)) continue;
    const key = `${item.name}\0${item.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!buckets.has(item.name)) buckets.set(item.name, []);
    buckets.get(item.name).push(item);
  }
  const selected = [];
  for (const items of buckets.values()) {
    items.sort((a, b) => score[b.quality] - score[a.quality]);
    const hd = items.filter(i => score[i.quality] >= score.hd);
    selected.push(...(hd.length ? hd : [items[0]]));
  }
  for (const protocol of ['udp', 'rtp']) {
    const lines = ['#EXTM3U', '# Guangdong Unicom multicast candidates: transport and reachability NOT verified',
      '# Requires Guangdong Unicom IPTV network; choose UDP or RTP only after checking actual stream framing'];
    for (const item of selected) {
      lines.push(`#EXTINF:-1 tvg-name="${item.name}" group-title="广东联通组播",${item.name}`);
      lines.push(`${protocol}://${protocol === 'udp' ? '@' : ''}${item.address}`);
    }
    const filename = protocol === 'udp' ? 'gd-unicom-multicast.m3u' : 'gd-unicom-multicast-rtp.m3u';
    fs.writeFileSync(path.join(outputDir, filename), `${lines.join('\n')}\n`);
  }
  const report = {
    schemaVersion: 1, provenance: supplement.provenance || [],
    inputEntries: (supplement.multicast || []).length, rejectedEntries,
    excludedEntries: supplement.exclusions || [],
    conflicts, selectedChannels: buckets.size, selectedLines: selected.length,
    missingFromUnicast: [...buckets.keys()].filter(n => !unicastNames.has(n)),
    qualityEvidence: 'attachment-labels-only', transport: 'unknown', reachability: 'not-verified',
    note: 'IGMP is group membership, not a media transport. UDP and RTP files are alternative candidates, not verified playable streams. No unicast conversion or public relay is inferred. Conflicting addresses are excluded. Requires Guangdong Unicom IPTV VLAN/routing and multicast support; GitHub Actions cannot verify that network.',
  };
  fs.writeFileSync(path.join(outputDir, 'gd-unicom-multicast-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
