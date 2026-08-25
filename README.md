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
- 同频道合并两个上游的有效线路，按 `4K → 高清 → 普通` 排序。
- 相同节目资源仅鉴权参数不同的 URL 自动去重，已有主上游线路优先保留。
- 常规分组继续保留完整频道；存在 4K 线路的频道同时在 `4K超高清` 分组建立独立入口。
- 4K 分组使用独立 `tvg-id`，同时保留原频道 `tvg-name`，避免 MyIPTV 将 4K 入口重新合并回常规分组。

## 自动更新

每天北京时间 06:30 和 18:30 自动检查上游并重新生成播放列表。

## 本地验证

```bash
npm test
```
