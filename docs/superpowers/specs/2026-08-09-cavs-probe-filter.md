# 广东电信 CAVS 线路探测过滤

## 问题

现有生成器只根据频道名称中的 `CAVS` 字样过滤线路。上游 `GuangdongIPTV_rtp_probe.txt` 已记录每条 RTP 的实际视频编码，因此名称未标 CAVS、实际 `V: cavs` 的线路会漏入播放列表。在当前 MyIPTV 环境中，这类线路表现为有声音、无画面。

## 修复

自动更新时下载上游 `GuangdongIPTV_rtp_probe.txt`，解析其中所有 `V: cavs` 地址并转换为规范 RTP URL 黑名单。主源、udpxy 备用源和独立 4K 源统一排除这些线路。

过滤以线路为单位，同频道其他 H.264、HEVC、MPEG-2 等可播放线路继续保留。报告增加 probe 输入摘要和 `cavsProbe` 过滤数量，自动验证保证 probe 中的 CAVS 地址不会进入输出。
