# 广东电信 RTP 多线路主源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `gd-telecom.m3u` 改为直接 RTP、多线路、4K 优先的电视主源，同时保留单线路 udpxy 备用源和独立 4K 源。

**Architecture:** 继续复用现有 M3U 解析、频道标准化和画质评分逻辑。新增“同频道保留全部候选并排序”的数据路径，RTP 主源和 4K 源使用直接组播地址；udpxy 备用源仍从每个频道的第一条最佳线路生成。GitHub Actions 同时验证三种输出。

**Tech Stack:** Node.js 22、ESM、`node:test`、GitHub Actions、M3U/XMLTV。

## Global Constraints

- `gd-telecom.m3u` 固定为直接 `rtp://` 多线路主源。
- 同频道排序：8K > 4K > UHD/超高清 > 超清 > 高清 > 未标注 > 标清；同等级下主用优先于备用/测试。
- 主源重新包含 4K/8K。
- CAVS、时移、回看、广告、测试卡、无节目和无效地址继续过滤。
- CCTV、CGTN、央视系列统一归“央视”；“经济科教”归“广东”；普通卫视不因 4K 进入独立画质分组。
- `gd-telecom-udpxy.m3u` 保留为每频道一条最佳线路的兼容备用源。
- `gd-telecom-4k.m3u` 继续保留并改为直接 RTP。
- 不修改 MyIPTV 代码。

---

### Task 1: 多线路排序与 RTP 渲染

**Files:**
- Modify: `scripts/playlist.mjs`
- Modify: `tests/playlist.test.mjs`

**Interfaces:**
- Produces: `selectAllEntries(entries, evidence)`，返回按频道聚合后展开的全部候选，候选已按画质和稳定性排序。
- Produces: `renderRtpPlaylist(entries, options)`，直接输出 `rtp://` 地址。
- Keeps: `selectBestEntries(entries, evidence)` 供 udpxy 单线路备用源使用。

- [ ] **Step 1: 写失败测试**

新增测试数据：广东卫视包含 4K、超清、高清、备用高清四条 RTP；CCTV-5 保持央视分组；广东4K归广东。

测试断言：

```js
const ranked = selectAllEntries(filterEntries(parsePlaylist(source)).entries, new Map());
const gd = ranked.filter((entry) => entry.channel === '广东卫视');
assert.deepEqual(gd.map((entry) => entry.selection.quality), ['4k', 'super-hd', 'hd', 'hd']);
assert.match(gd[3].name, /备用/);
```

并验证 RTP 渲染结果中同频道重复 `#EXTINF` 使用相同 `tvg-name` / `group-title`，地址保持 `rtp://`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test`

Expected: FAIL，原因是 `selectAllEntries` / `renderRtpPlaylist` 尚未实现。

- [ ] **Step 3: 实现最小代码**

在 `playlist.mjs` 中：

```js
export function selectAllEntries(entries, evidence = new Map()) {
  const grouped = new Map();
  for (const entry of entries) {
    const channel = normalizeChannelName(entry);
    if (!channel) continue;
    const candidate = { ...entry, channel, selection: qualityScore(entry, evidence) };
    if (!grouped.has(channel)) grouped.set(channel, []);
    grouped.get(channel).push(candidate);
  }

  const output = [];
  for (const [channel, candidates] of grouped) {
    candidates.sort(compareCandidates);
    const representative = candidates[0];
    for (let i = 0; i < candidates.length; i += 1) {
      output.push({
        ...candidates[i],
        channel,
        candidateCount: candidates.length,
        lineIndex: i,
        canonicalTvgId: representative.tvgId || '',
        canonicalTvgName: representative.tvgName || channel,
      });
    }
  }
  return output;
}
```

抽出 `compareCandidates()` 给 `selectBestEntries()` 和 `selectAllEntries()` 共用。

新增：

```js
export function renderRtpPlaylist(entries, options = {}) {
  const name = options.name || '广东电信IPTV';
  // 按 group -> channel -> lineIndex 排序；同频道元数据一致；直接写 entry.rtpUrl
}
```

调整 `classifyChannel()`：去除基于 4K/UHD 的单独分组优先级，使卫视、广东等按频道身份归类；CCTV/CGTN 仍优先归央视。

- [ ] **Step 4: 运行测试并确认通过**

Run: `npm test`

Expected: PASS，且现有过滤、央视分组、经济科教规则无回归。

- [ ] **Step 5: 提交**

```bash
git add scripts/playlist.mjs tests/playlist.test.mjs
git commit -m "feat: support ranked RTP alternates per channel"
```

---

### Task 2: 生成主源、udpxy备用源和4K源

**Files:**
- Modify: `scripts/generate.mjs`
- Modify: `config/udpxy.json`
- Modify: `tests/playlist.test.mjs`

**Interfaces:**
- Consumes: `selectAllEntries()`、`selectBestEntries()`、`renderRtpPlaylist()`、现有 `renderPlaylist()`。
- Produces: `m3u/gd-telecom.m3u`、`m3u/gd-telecom-udpxy.m3u`、`m3u/gd-telecom-4k.m3u`。

- [ ] **Step 1: 写失败测试**

增加生成级测试夹具，断言：

```js
assert.match(main, /\nrtp:\/\//);
assert.doesNotMatch(main, /192\.168\.5\.7:4022/);
assert.match(backup, /http:\/\/192\.168\.5\.7:4022\/udp\//);
assert.doesNotMatch(backup, /\nrtp:\/\//);
```

主源中广东卫视至少两条线路，4K行排在高清行之前。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test`

Expected: FAIL，因为生成器尚未输出三种目标文件。

- [ ] **Step 3: 修改生成器**

核心流程改为：

```js
const filteredAll = filterEntries(allEntries, { excludeUltraHd: false });
const allRanked = selectAllEntries(filteredAll.entries, evidence);
const best = selectBestEntries(filteredAll.entries, evidence);

const playlist = renderRtpPlaylist(allRanked, { name: '广东电信IPTV' });
const udpxyPlaylist = renderPlaylist(best, config);
```

4K源从全量 + 4K证据中筛选超高清候选，保留全部有效线路并用 `renderRtpPlaylist()` 输出。

报告升级为 `schemaVersion: 3`，增加：

```js
selectedChannels: new Set(allRanked.map((e) => e.channel)).size,
selectedLines: allRanked.length,
multiLineChannels: [...counts.values()].filter((n) => n > 1).length,
maxLinesPerChannel: Math.max(...counts.values()),
ultraHdSelectedLines: ultraHdRanked.length,
```

输出：

```js
writeAtomic(path.join(outputDir, 'gd-telecom.m3u'), playlist);
writeAtomic(path.join(outputDir, 'gd-telecom-udpxy.m3u'), udpxyPlaylist);
writeAtomic(path.join(outputDir, 'gd-telecom-4k.m3u'), ultraHdPlaylist);
```

将 `config/udpxy.json` 的 `excludeUltraHd` 调整为 `false`；该字段仅保留兼容性，不再控制 RTP 主源。

- [ ] **Step 4: 运行测试并确认通过**

Run: `npm test`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/generate.mjs config/udpxy.json tests/playlist.test.mjs
git commit -m "feat: generate RTP multiline primary playlist"
```

---

### Task 3: 自动更新、验证与文档

**Files:**
- Modify: `.github/workflows/update.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 2 生成的四个广东电信文件。
- Produces: 自动验证和提交新的 RTP 主源、udpxy 备用源、4K 源、EPG 与报告。

- [ ] **Step 1: 更新 GitHub Actions 验证**

主源验证：

```bash
test -s m3u/gd-telecom.m3u
grep -q '^rtp://' m3u/gd-telecom.m3u
! grep -Eq '192\.168\.5\.7:4022/udp/' m3u/gd-telecom.m3u
! grep -Eqi 'CAVS|时移|回看' m3u/gd-telecom.m3u
```

备用源验证：

```bash
test -s m3u/gd-telecom-udpxy.m3u
grep -q 'http://192\.168\.5\.7:4022/udp/' m3u/gd-telecom-udpxy.m3u
! grep -q '^rtp://' m3u/gd-telecom-udpxy.m3u
```

4K源验证为直接 RTP。

报告验证改为：

```js
if (telecom.schemaVersion !== 3) throw new Error('Unexpected Telecom report schema');
if (telecom.selectedChannels < 50) throw new Error('Too few Telecom channels');
if (telecom.selectedLines <= telecom.selectedChannels) throw new Error('No alternate RTP lines generated');
if (telecom.multiLineChannels < 1) throw new Error('No multi-line channels generated');
```

更新提交文件数组，加入 `m3u/gd-telecom-udpxy.m3u`。

- [ ] **Step 2: 更新 README**

明确：

```text
主源（直接 RTP，多线路，4K优先）
https://tv.shaowt.com/gd-telecom.m3u

udpxy备用源（单线路）
https://tv.shaowt.com/gd-telecom-udpxy.m3u

独立4K RTP源
https://tv.shaowt.com/gd-telecom-4k.m3u
```

删除“主列表暂时过滤4K”的旧说明。

- [ ] **Step 3: 本地完整验证**

Run:

```bash
npm test
node scripts/generate.mjs --all .tmp/all.m3u --hd .tmp/hd.m3u --4k .tmp/4k.m3u --epg .tmp/epg.xml --config config/udpxy.json --output /tmp/iptv-out --upstream-sha test
```

检查：

```bash
grep -c '^#EXTINF:' /tmp/iptv-out/gd-telecom.m3u
grep -c '^rtp://' /tmp/iptv-out/gd-telecom.m3u
grep -c '^#EXTINF:' /tmp/iptv-out/gd-telecom-udpxy.m3u
grep -c '^http://' /tmp/iptv-out/gd-telecom-udpxy.m3u
```

Expected: 主源 RTP 行数大于频道数；udpxy 源每频道一条。

- [ ] **Step 4: 提交**

```bash
git add .github/workflows/update.yml README.md
git commit -m "ci: validate RTP multiline Telecom playlists"
```

---

### Task 4: 发布与最终核验

**Files:**
- Generated: `m3u/gd-telecom.m3u`
- Generated: `m3u/gd-telecom-udpxy.m3u`
- Generated: `m3u/gd-telecom-4k.m3u`
- Generated: `m3u/gd-telecom-report.json`

- [ ] **Step 1: 推送代码并等待 Actions 生成数据**

确认 Actions 生成提交包含新的 `gd-telecom-udpxy.m3u`。

- [ ] **Step 2: 拉取生成文件核验结构**

至少检查：广东卫视/CCTV 等存在多 RTP；同频道 `#EXTINF` 元数据一致；第一条为最高画质候选；主源无 udpxy 地址。

- [ ] **Step 3: 核对固定地址**

```text
https://tv.shaowt.com/gd-telecom.m3u
https://tv.shaowt.com/gd-telecom-udpxy.m3u
https://tv.shaowt.com/gd-telecom-4k.m3u
```

Cloudflare 静态资源根目录仍为 `m3u`，无需改域名路径。
