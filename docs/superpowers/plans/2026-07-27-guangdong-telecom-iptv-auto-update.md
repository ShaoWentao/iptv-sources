# Guangdong Telecom IPTV Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish one automatically updated, deduplicated and television-friendly Guangdong Telecom IPTV playlist at `https://tv.shaowt.com/gd-telecom.m3u`.

**Architecture:** A focused Node.js generator downloads the upstream full, HD, SD and 4K RTP playlists plus EPG, treats the full list as the canonical channel inventory, and uses the auxiliary quality lists as evidence when selecting the best source for each normalized channel. GitHub Actions runs twice daily, generates the udpxy HTTP playlist and report, validates the result, and commits only meaningful changes.

**Tech Stack:** Node.js ES modules, Vitest, GitHub Actions, Cloudflare static assets from `m3u/`.

## Global Constraints

- udpxy endpoint is configured only in `config/udpxy.json` and initially equals `http://192.168.5.7:4022`.
- Canonical upstream inventory is `GuangdongIPTV_rtp_all.m3u` on branch `master` of `Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List`.
- Also fetch `GuangdongIPTV_rtp_hd.m3u`, `GuangdongIPTV_rtp_sd.m3u`, and `GuangdongIPTV_rtp_4k.m3u` and use exact RTP URL membership as quality evidence.
- Explicit quality text wins over contradictory auxiliary-list membership; an explicit `4K` entry must never be downgraded because it also appears in the SD file.
- 4K-list membership is strong positive evidence; HD-list membership is positive evidence; SD-list membership is weak evidence and only applies when no higher-quality evidence exists.
- Remove channel entries containing `CAVS` or time-shift wording; preserve `AVS2`.
- Each normalized channel outputs exactly one selected source.
- Output groups are: 央视、卫视、广东、地方、体育、少儿、电影电视剧、纪录科教、4K超高清、其他.
- The scheduled checks run at 06:30 and 18:30 China Standard Time.
- Existing valid `gd-telecom.m3u` remains untouched when download, parsing or validation fails.
- Legacy aggregation and Yangshipin test artifacts are removed only after the new generator and workflow pass tests.

---

### Task 1: Add fixture-driven parser, filtering, quality evidence and selection tests

**Files:**
- Create: `tests/fixtures/gd-telecom-all.m3u`
- Create: `tests/fixtures/gd-telecom-hd.m3u`
- Create: `tests/fixtures/gd-telecom-sd.m3u`
- Create: `tests/fixtures/gd-telecom-4k.m3u`
- Create: `tests/build-gd-telecom.test.mjs`
- Create: `scripts/lib/gd-telecom.mjs`

**Interfaces:**
- Produces: `parseM3u(text)`, `buildQualityEvidence(playlists)`, `filterEntries(entries)`, `normalizeChannelName(entry)`, `scoreCandidate(entry, evidence)`, `selectBestChannels(entries, evidence)`, `classifyChannel(channel)`, `toUdpxyUrl(rtpUrl, config)`, and `renderPlaylist(channels, config)`.
- `parseM3u(text: string): Array<{name:string,tvgName:string,groupTitle:string,url:string,index:number}>`.
- `buildQualityEvidence({hd,sd,fourK}): Map<string, Set<'hd'|'sd'|'4k'>>` keyed by exact RTP URL.
- `selectBestChannels(entries,evidence): Array<SelectedChannel>` returns one item per normalized channel with selection metadata.

- [ ] **Step 1: Write representative fixtures**

Include these cases in the fixtures:

```m3u
#EXTM3U
#EXTINF:-1 tvg-name="广东卫视",广东卫视高清
rtp://239.77.0.4:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视4k超高清
rtp://239.77.0.66:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视4K(CAVS)
rtp://239.77.1.99:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视时移专用
rtp://239.77.0.84:5146
#EXTINF:-1 tvg-name="广东卫视",广东卫视 4K (AVS2)
rtp://239.77.1.96:5146
#EXTINF:-1 tvg-name="CCTV-5",CCTV-5体育高清
rtp://239.77.0.105:5146
#EXTINF:-1 tvg-name="嘉佳卡通",嘉佳卡通高清
rtp://239.77.0.179:5146
```

- [ ] **Step 2: Write failing tests**

Tests must assert:

```js
expect(parseM3u(allText)).toHaveLength(7)
expect(filterEntries(parsed).map(x => x.name)).not.toContain(expect.stringMatching(/CAVS|时移/i))
expect(normalizeChannelName(avs2Entry)).toBe('广东卫视')
expect(scoreCandidate(explicit4kInSdList, evidence)).toBeGreaterThan(scoreCandidate(hdEntry, evidence))
expect(selectBestChannels(filtered, evidence).filter(x => x.channel === '广东卫视')).toHaveLength(1)
expect(selectedGuangdong.sourceName).toContain('4K')
expect(classifyChannel(cctv5)).toBe('体育')
expect(classifyChannel(guangdong4k)).toBe('4K超高清')
expect(toUdpxyUrl('rtp://239.77.0.66:5146', config)).toBe('http://192.168.5.7:4022/udp/239.77.0.66:5146/')
```

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
pnpm vitest run tests/build-gd-telecom.test.mjs
```

Expected: FAIL because `scripts/lib/gd-telecom.mjs` functions are not implemented.

- [ ] **Step 4: Implement the pure library functions**

Implement deterministic parsing, filtering, quality scoring, normalization, classification and rendering. Quality score order must be:

```text
explicit 8K > explicit 4K/UHD > 4K-list membership > explicit 超清 > explicit 高清/HD > HD-list membership > unmarked > SD-list membership or explicit 标清/SD
```

Tie-breakers:

```text
fewer annotation characters > earlier full-list index > lexical RTP URL
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run tests/build-gd-telecom.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests scripts/lib/gd-telecom.mjs
git commit -m "feat: add Guangdong IPTV selection engine"
```

---

### Task 2: Add udpxy configuration and production generator

**Files:**
- Create: `config/udpxy.json`
- Create: `scripts/build-gd-telecom.mjs`
- Modify: `package.json`
- Test: `tests/build-gd-telecom.test.mjs`

**Interfaces:**
- Consumes all pure functions from `scripts/lib/gd-telecom.mjs`.
- Produces `m3u/gd-telecom.m3u`, `m3u/gd-telecom-report.json`, and `m3u/gd-telecom-epg.xml`.
- CLI arguments: `--all`, `--hd`, `--sd`, `--4k`, `--epg`, `--upstream-sha`, with sensible temporary-file defaults used by the workflow.

- [ ] **Step 1: Add failing integration test**

Create a temporary directory, invoke the generator with fixture paths, and assert:

```js
expect(output).toContain('#EXTM3U name="广东电信IPTV"')
expect(output).toContain('group-title="4K超高清"')
expect(output).not.toMatch(/CAVS|时移|rtp:\/\//i)
expect(report.inputs.fourK).toBeDefined()
expect(report.qualityEvidence.fourKUrls).toBeGreaterThan(0)
expect(report.selectedChannels).toBeGreaterThan(0)
```

- [ ] **Step 2: Run integration test and confirm failure**

Run:

```bash
pnpm vitest run tests/build-gd-telecom.test.mjs
```

Expected: FAIL because the CLI generator and config do not exist.

- [ ] **Step 3: Add `config/udpxy.json`**

```json
{
  "protocol": "http",
  "host": "192.168.5.7",
  "port": 4022
}
```

- [ ] **Step 4: Implement generator with atomic output**

Generate files in a temporary directory, validate them, then rename into `m3u/`. Refuse to replace existing files when:

```text
full input has fewer than 100 parsed entries
selected output has fewer than 50 channels
output contains CAVS, 时移, or rtp://
output contains duplicate normalized names
udpxy config is invalid
```

The report must include upstream SHA, source file SHA-256 values, counts for each input list, filtered counts, auxiliary-list overlaps, per-group counts, and per-channel selected/removed candidates.

- [ ] **Step 5: Add package commands**

Add:

```json
"gd:build": "node scripts/build-gd-telecom.mjs",
"gd:test": "vitest run tests/build-gd-telecom.test.mjs"
```

- [ ] **Step 6: Run tests and fixture build**

```bash
pnpm gd:test
node scripts/build-gd-telecom.mjs --all tests/fixtures/gd-telecom-all.m3u --hd tests/fixtures/gd-telecom-hd.m3u --sd tests/fixtures/gd-telecom-sd.m3u --4k tests/fixtures/gd-telecom-4k.m3u --epg /dev/null --output-dir /tmp/gd-iptv-test
```

Expected: tests pass and the temporary playlist contains one Guangdong TV source selected from the 4K candidates.

- [ ] **Step 7: Commit**

```bash
git add config/udpxy.json scripts/build-gd-telecom.mjs package.json tests/build-gd-telecom.test.mjs
git commit -m "feat: generate classified Guangdong Telecom playlist"
```

---

### Task 3: Build the first production playlist from current upstream data

**Files:**
- Create: `m3u/gd-telecom.m3u`
- Create: `m3u/gd-telecom-report.json`
- Create: `m3u/gd-telecom-epg.xml`

**Interfaces:**
- Consumes current upstream files from the master branch.
- Produces the static assets published by Cloudflare.

- [ ] **Step 1: Download all upstream inputs**

```bash
curl -fsSL -o /tmp/GuangdongIPTV_rtp_all.m3u https://raw.githubusercontent.com/Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List/master/GuangdongIPTV_rtp_all.m3u
curl -fsSL -o /tmp/GuangdongIPTV_rtp_hd.m3u https://raw.githubusercontent.com/Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List/master/GuangdongIPTV_rtp_hd.m3u
curl -fsSL -o /tmp/GuangdongIPTV_rtp_sd.m3u https://raw.githubusercontent.com/Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List/master/GuangdongIPTV_rtp_sd.m3u
curl -fsSL -o /tmp/GuangdongIPTV_rtp_4k.m3u https://raw.githubusercontent.com/Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List/master/GuangdongIPTV_rtp_4k.m3u
curl -fsSL -o /tmp/gd-telecom-epg.xml https://raw.githubusercontent.com/Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List/master/epg.xml
```

- [ ] **Step 2: Generate production assets**

```bash
node scripts/build-gd-telecom.mjs --all /tmp/GuangdongIPTV_rtp_all.m3u --hd /tmp/GuangdongIPTV_rtp_hd.m3u --sd /tmp/GuangdongIPTV_rtp_sd.m3u --4k /tmp/GuangdongIPTV_rtp_4k.m3u --epg /tmp/gd-telecom-epg.xml --output-dir m3u
```

- [ ] **Step 3: Validate production output**

```bash
node --check scripts/build-gd-telecom.mjs
pnpm gd:test
! grep -Eqi 'CAVS|时移|rtp://' m3u/gd-telecom.m3u
grep -q '192.168.5.7:4022/udp/' m3u/gd-telecom.m3u
```

Inspect the report and confirm that 4K candidates were identified through both explicit names and `GuangdongIPTV_rtp_4k.m3u` membership.

- [ ] **Step 4: Commit**

```bash
git add m3u/gd-telecom.m3u m3u/gd-telecom-report.json m3u/gd-telecom-epg.xml
git commit -m "data: publish Guangdong Telecom IPTV playlist"
```

---

### Task 4: Add twice-daily upstream synchronization workflow

**Files:**
- Create: `.github/workflows/update-gd-telecom-iptv.yml`

**Interfaces:**
- Runs at `30 22 * * *` and `30 10 * * *`, plus manual dispatch.
- Downloads five upstream files and current upstream commit SHA.
- Runs `pnpm gd:test` before replacing or committing assets.

- [ ] **Step 1: Write workflow**

The workflow must:

```yaml
permissions:
  contents: write
concurrency:
  group: update-gd-telecom-iptv
  cancel-in-progress: false
```

Use Node 22 and pnpm, download all/HD/SD/4K/EPG inputs, obtain the upstream master SHA from the GitHub commits API, run the generator, and commit only these paths when changed:

```text
m3u/gd-telecom.m3u
m3u/gd-telecom-report.json
m3u/gd-telecom-epg.xml
```

- [ ] **Step 2: Validate workflow syntax and commands**

Review cron conversion, file names and generated paths. Run the same commands locally where possible.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/update-gd-telecom-iptv.yml
git commit -m "ci: update Guangdong Telecom IPTV twice daily"
```

---

### Task 5: Retire legacy aggregation artifacts safely

**Files:**
- Delete: `m3u/yangshipin.m3u`
- Delete: `m3u/yangshipin-test.m3u`
- Delete: `yangshipin.m3u`
- Delete: `config/yangshipin-webview-candidates.json`
- Delete: `docs/index.html`
- Delete: `.github/workflows/refresh-iptv-candidates.yml`
- Modify: `package.json`
- Modify or delete only after reference inspection: legacy custom/candidate scripts and generated outputs.

**Interfaces:**
- Leaves Cloudflare `assets.directory` set to `m3u`.
- Leaves the new Guangdong generator, workflow and outputs intact.

- [ ] **Step 1: Search references before deletion**

```bash
grep -R "yangshipin\|build-custom\|remote-candidates\|catvod\|custom.m3u" -n package.json scripts config .github m3u docs || true
```

- [ ] **Step 2: Remove confirmed unused files and commands**

Remove only files serving the old aggregation pipeline. Reduce the default `build`/`static` commands so they cannot recreate deleted custom or candidate outputs.

- [ ] **Step 3: Run complete verification**

```bash
pnpm gd:test
pnpm lint
node scripts/build-gd-telecom.mjs --all /tmp/GuangdongIPTV_rtp_all.m3u --hd /tmp/GuangdongIPTV_rtp_hd.m3u --sd /tmp/GuangdongIPTV_rtp_sd.m3u --4k /tmp/GuangdongIPTV_rtp_4k.m3u --epg /tmp/gd-telecom-epg.xml --output-dir /tmp/gd-verify
```

Expected: no legacy aggregation command runs and the new playlist remains valid.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: retire legacy IPTV aggregation pipeline"
```

---

### Task 6: Final verification and deployment check

**Files:**
- Verify: `m3u/gd-telecom.m3u`
- Verify: `m3u/gd-telecom-report.json`
- Verify: `.github/workflows/update-gd-telecom-iptv.yml`
- Verify: `wrangler.jsonc`

**Interfaces:**
- Public subscription URL: `https://tv.shaowt.com/gd-telecom.m3u`.

- [ ] **Step 1: Run final repository checks**

```bash
pnpm gd:test
pnpm lint
node --check scripts/build-gd-telecom.mjs
```

- [ ] **Step 2: Verify playlist invariants**

Confirm:

```text
no CAVS
no 时移
no rtp:// URLs
one output per normalized channel
all URLs point to 192.168.5.7:4022/udp/
all ten groups use the agreed names
report contains all/HD/SD/4K input counts and evidence statistics
```

- [ ] **Step 3: Verify publication path**

Confirm `wrangler.jsonc` still publishes `m3u/`, then verify the deployed URL after Cloudflare finishes rebuilding.

- [ ] **Step 4: Commit any final corrections**

```bash
git add -A
git commit -m "fix: finalize Guangdong Telecom IPTV publishing"
```
