# Guangdong Unicom APTV Playlist Design

## Goal
Generate an APTV-oriented Guangdong Unicom playlist that keeps every upstream URL for the same channel name, while also providing a single-line compatibility playlist for players that handle duplicates poorly.

## Output
- `m3u/gd-unicom.m3u`: primary APTV playlist; keep all valid HLS entries from the upstream list, including multiple URLs with identical channel names.
- `m3u/gd-unicom-simple.m3u`: compatibility playlist; keep only the first URL for each `group + channel name` pair.
- `m3u/gd-unicom-report.json`: report upstream entry count, unique channel count, alternate line count and groups.

## Data flow
Fetch `xisohi/CHINA-IPTV/Unicast/guangdong/unicom.txt`, parse `name,url` rows and `#genre#` group markers, keep only HTTP(S) HLS URLs, then render the two M3U variants.

## Constraints
GitHub Actions must not test actual stream reachability because the streams are network-dependent and may only be reachable from Guangdong Unicom networks. Existing Guangdong Telecom generation must remain unchanged.
