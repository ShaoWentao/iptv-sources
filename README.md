# 广东电信 IPTV 播放列表

本仓库只维护一份广东电信 IPTV 播放列表。数据来自 `Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List`，定时转换为本地 udpxy 可播放的 HTTP 地址。

## 播放列表

```text
https://raw.githubusercontent.com/ShaoWentao/iptv-sources/main/m3u/gd-telecom.m3u
```

EPG：

```text
https://raw.githubusercontent.com/ShaoWentao/iptv-sources/main/m3u/gd-telecom-epg.xml
```

## 当前规则

- 过滤 CAVS、时移、回看、广告和无效地址。
- 同一频道只保留一条，按 8K、4K、超高清、超清、高清、未标注、标清的顺序择优。
- 上游 4K 与 HD 列表只作为辅助证据，频道名称中的明确画质标注优先。
- 输出按央视、卫视、广东、地方、体育、少儿、电影电视剧、纪录科教、4K超高清和其他分类。
- 每天北京时间 06:30 和 18:30 自动检查上游更新。

## udpxy 地址

当前配置：

```text
http://192.168.5.7:4022
```

地址变化时只需修改 `config/udpxy.json`，工作流会重新生成播放列表。

## 本地验证

```bash
npm test
```
