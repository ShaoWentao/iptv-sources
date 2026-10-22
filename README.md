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

- 只保留广东联通 IPTV 的 `PLTV/88888973/224/` 单播地址。允许 `120.87.0.0/16`、`112.89.121.23`、已验证的 `112.89.33.4/.5/.6/.7/.8/.9`、`112.89.35.70`、`112.89.121.21/.22/.24` 和 `112.89.77.21/.22/.23/.24`。超时的 `112.89.45.*` 及未验证的网段不扩充白名单。
- 排除汕头公网 HLS、作者本地 Huya 代理、快手/抖音视频以及其他非广东联通 IPTV 地址。
- 同频道合并两个上游的有效线路，按 `4K → 1080P → 720P/其他` 排序；存在 4K 或 1080P 线路时删除 720P/低清线路；如果该频道只有 720P/低清线路，则保留 1 条作为兜底，避免频道消失。
- 相同节目资源仅鉴权参数不同的 URL 自动去重，已有主上游线路优先保留。
- 常规分组继续保留完整频道；存在 4K 线路的频道同时在 `4K超高清` 分组建立独立入口。
- 4K 分组使用独立 `tvg-id`，同时保留原频道 `tvg-name`，避免 MyIPTV 将 4K 入口重新合并回常规分组。

### 实测补充（2026-10-18）

用户先前实测确认 `120.87.4.17`、资源 ID `3221225725` 播放的实际节目为 **延边卫视**（上游误写“广东综艺”）；已修正频道名并收录阳江综合。之前验证正常的12条备用线路继续保留。

[第二批223条单播测试表](m3u/gd-unicom-test-untested-batch-20261018.m3u) 已按IP分组进行测试：168条正常、55条超时。用户反馈的超时IP为 `120.87.19.109`、`112.89.33.4`、`112.89.33.9`、`112.89.77.25`、`112.89.77.26`、`120.87.4.18`。此结果仅适用于该批所测的对应URL；此前同IP经验证正常的其他线路不删除。

168条正常候选中，160条已按现有 PLTV 资源 ID 匹配到正式频道，并加入 `config/gd-unicom-supplement.json` 作为实测备用线路；另8条名称与同资源ID已有频道存在冲突，先保留在审计记录中核对，避免错标。正式多线路源根据高清优先规则选择保留的线路；明确为低清、且该频道已有更高清线路时，仍过滤低清备份。简化源每频道仍保留一条最佳线路。详见[逐条测试和合并审计](docs/gd-unicom-batch-verification-20261018.json)。

视频实际分辨率尚未通过媒体探针逐条核验，`fmt` 代码与原始频道标签仅作辅助判断。

### 附件补充及独立联通组播

`config/gd-unicom-supplement.json` 收录用户提供的 `1949.txt` 中缺少的 7 个联通单播频道：广东房产、梨园频道、靓装、CETV早期教育、武术世界、文物宝库、环球奇观。这些地址带有旧鉴权，且用户反馈无法播放，现已移出主源和简化源，单独保存在 `m3u/gd-unicom-unverified.m3u`。地址属于联通不代表仍能播放，workflow 成功也不代表播放验证成功。

附件单播必须在广东联通网络实际确认音视频可播放并标记 `playbackStatus: verified`，才有资格加入正式源；缺失频道自动补充，已存在的频道需明确标记 `verifiedAlternate: true` 才作为备用线路保留。原1080P线路仍优先，明确识别为低清的备用线路在已有高清时会被过滤；分辨率未知的实测正常线路暂列为多线路主源的备用，等待进一步核验。上游现有频道优先使用原线，简化源不追加备用线路。附件中的浙江频道不新增。原有 `现代教育`、`广东现代教育` 来自上游，不属于这次新增。

广东联通 CCTV4K 旧单播资源 ID `3221226217` 在 APTV 中曾出现有声音无画面的情况，现已从正式主源和简化源移除。生成器只过滤这个已确认有问题的资源 ID，仍可收录其他经验证正常的 CCTV4K 新资源。附件 `广东联通IPTV.m3u` 的 CCTV-4K（资源 ID `3221226704`）和 CCTV-奥林匹克4K（资源 ID `3221226698`）原始URL播放超时、仅出现静态画面。参照已实测正常线路，修正 `accountinfo` 尾部后，A版（移除异常时间戳并以 `%2CEND` 结尾）与B版（保留时间戳并规范逗号编码）均经用户于2026-10-22在广东联通网络实测正常。正式主源与简化源采用A版各一条；B版保留在[4K尾部修正测试列表](m3u/gd-unicom-test-4k-tailfix-20261022.m3u)作为已验证的参数替代版本，避免同一资源重复增加播放线路。视频实际分辨率尚未进行探针核验。其他4K频道（包括广东4K，资源 ID `3221226174`）保留，独立组播候选不受单播排除规则影响。

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
