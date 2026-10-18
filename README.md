# 广东 IPTV 播放列表

本仓库自动整理广东电信 IPTV 和广东联通 IPTV 播放列表。广东电信数据来自 `Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List`。

## 广东电信

电视主源使用直接 RTP 组播。同一个频道保留多条有效线路，默认把画质最高的线路排在最前面。

主源（直接 RTP，多线路，4K 优先）：

```text
https://tv.shaowt.com/gd-telecom.m3u
```

udpxy 备用源（每个频道只保留一条最佳线路）：

```text
https://tv.shaowt.com/gd-telecom-udpxy.m3u
```

独立 4K RTP 源：

```text
https://tv.shaowt.com/gd-telecom-4k.m3u
```

EPG：

```text
https://tv.shaowt.com/gd-telecom-epg.xml
```

GitHub Raw 备用地址：

```text
https://raw.githubusercontent.com/ShaoWentao/iptv-sources/main/m3u/gd-telecom.m3u
https://raw.githubusercontent.com/ShaoWentao/iptv-sources/main/m3u/gd-telecom-udpxy.m3u
https://raw.githubusercontent.com/ShaoWentao/iptv-sources/main/m3u/gd-telecom-4k.m3u
https://raw.githubusercontent.com/ShaoWentao/iptv-sources/main/m3u/gd-telecom-epg.xml
```

### 广东电信整理规则

- 主源直接输出 `rtp://` 组播地址，不经过 udpxy。
- 同一频道保留全部有效 RTP 候选线路，并使用相同的 `tvg-id`、`tvg-name`、显示名和分组，便于播放器聚合为一个频道。
- 线路顺序按画质和稳定性排序：8K、4K、UHD/超高清、超清、高清、未标注、标清；同等级下主用线路优先于备用或测试线路。
- 上游 HD 和 4K 专用列表继续作为画质判断依据。
- 过滤 CAVS、AVS2、时移、回看、广告、测试卡、无节目、无效地址和重复 RTP 地址。
- 删除内容重复的“央视精品”，保留“央视文化精品”。
- CCTV、CGTN 和央视系列频道统一放入“央视”。
- “经济科教”归入“广东”。
- `CCTV-4K`、`CCTV-8K`归“央视”，`广东4K`归“广东”；普通卫视的 4K 线路仍归“卫视”。
- udpxy 备用源继续使用 `config/udpxy.json`，每个频道仅输出排序后的第一条线路。
- 独立 4K 源使用直接 RTP，仅保留 8K、4K、UHD、超高清以及上游 4K 列表确认的线路。

当前 udpxy 配置：

```text
http://192.168.5.7:4022
```

## 广东联通

广东联通使用 HTTP/HLS 单播。当前同时合并以下两个上游：

- `xisohi/CHINA-IPTV` 的 `Unicast/guangdong/unicom.txt`
- `lu791758-hub/GDIPTV` 的 `tv.m3u`

主源（多线路，4K 优先，并带独立 4K 分组）：

```text
https://tv.shaowt.com/gd-unicom.m3u
```

简化源（每个常规频道只保留最高优先级线路，同时保留 4K 分组入口）：

```text
https://tv.shaowt.com/gd-unicom-simple.m3u
```

### 广东联通整理规则

- 只保留广东联通 IPTV 的 `PLTV/88888973/224/` 单播地址，目前允许 `120.87.0.0/16` 和 `112.89.121.23`。
- 排除汕头公网 HLS、作者本地 Huya 代理、快手/抖音视频以及其他非广东联通 IPTV 地址。
- 同频道合并两个上游的有效线路，按 `4K → 1080P → 720P/其他` 排序；存在 4K 或 1080P 线路时删除 720P/低清线路；如果该频道只有 720P/低清线路，则保留 1 条作为兜底，避免频道消失。
- 相同节目资源仅鉴权参数不同的 URL 自动去重，已有主上游线路优先保留。
- 常规分组继续保留完整频道；存在 4K 线路的频道同时在 `4K超高清` 分组建立独立入口。
- 4K 分组使用独立 `tvg-id`，同时保留原频道 `tvg-name`，避免 MyIPTV 将 4K 入口重新合并回常规分组。

### 实测补充（2026-10-18）

从 `qist/tvbox` 的广东联通单播源中，用户实测确认 `120.87.4.17`、资源 ID `3221225725` 播放的实际节目为 **延边卫视**。上游标签误写为“广东综艺”，已在补充配置中按真实频道名登记，自动生成时加入主源与简化源。视频分辨率尚未实测。

`112.89.33.*` 中另有六条用户实测正常的卫视备用资源；这六个频道在现有主源均已收录，暂未改变高清优先的来源排序。`112.89.45.*` 本轮测试超时，`120.87.4.33` 精选4K超时，`120.87.4.28` 阳江文化生活超时。具体测试 URL 和验证结果见 [广东联通单播实测记录](docs/gd-unicom-playback-20261018.md)。

### 附件补充及独立联通组播

`config/gd-unicom-supplement.json` 收录用户提供的 `1949.txt` 中缺少的 7 个联通单播频道：广东房产、梨园频道、靓装、CETV早期教育、武术世界、文物宝库、环球奇观。这些地址带有旧鉴权，且用户反馈无法播放，现已移出主源和简化源，单独保存在 `m3u/gd-unicom-unverified.m3u`。地址属于联通不代表仍能播放，workflow 成功也不代表播放验证成功。

附件单播必须在广东联通网络实际确认音视频可播放并标记 `playbackStatus: verified`，才会在两个实时上游都没有该频道时加入主源；仍通过白名单和原有画质筛选。上游补回频道后优先使用上游。附件中的浙江频道不新增。原有 `现代教育`、`广东现代教育` 来自上游，不属于这次新增。

CCTV4K 单播目前只有一个实际资源，4K 分组和央视分组只是同一 URL 的两个入口。用户反馈在 APTV 有声音无画面，视频编码尚未从媒体数据确认；不能仅凭这个症状认定 AVS2，也没有将猜测的 fmt 或鉴权参数作为替代源发布。

独立组播候选来自用户 ZIP 内的频道表及 [恩山论坛该帖](https://www.right.com.cn/forum/thread-8443839-1-1.html) 的 2025-08-25 组播表，来源名称、地址及文件摘要保存在配置中。论坛示例 `1.2.3.0:0000/udp/...` 是代理占位符，不作为单播地址导入；缺少鉴权后缀的单播示例也不拼造补齐。

- UDP 候选：`m3u/gd-unicom-multicast.m3u`（`udp://@组播地址:端口`）。
- RTP 候选：`m3u/gd-unicom-multicast-rtp.m3u`（`rtp://组播地址:端口`）。
- 审计报告：`m3u/gd-unicom-multicast-report.json`，记录独有频道、排除条目和地址冲突。

`igmp://` 只说明加入组播，不能确认实际载荷是裸 UDP MPEG-TS 还是 RTP。两个文件是待验证的替代格式，需在广东联通 IPTV 网络上抓包或探测后选择，不能据此声称可播放。需具备对应 IPTV VLAN/路由、IGMP 及播放器组播支持；GitHub Actions 的公网环境无法验证 IPTV 专网可达性。没有配置或虚构公网 udpxy 转发地址。

组播与 HTTP/HLS 主源完全分开。组播依据原始标签排序（4K、高清、低清），有高清时移除低清，仅低清时保留一条；标签不等于实测分辨率。浙江条目、AVS2/CAVS 标记条目及同地址对应不同频道的冲突记录不进入候选输出。原有单播列表中的浙江卫视保持原规则。

## 自动更新

每天北京时间 06:30 和 18:30 自动检查上游并重新生成播放列表。

## 本地验证

```bash
npm test
```
