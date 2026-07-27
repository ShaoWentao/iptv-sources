# 广东电信 IPTV 播放列表

本仓库只维护一份广东电信 IPTV 播放列表。数据来自 `Tzwcard/ChinaTelecom-GuangdongIPTV-RTP-List`，定时转换为本地 udpxy 可播放的 HTTP 地址。

## 播放列表

```text
https://tv.shaowt.com/gd-telecom.m3u
```

EPG：

```text
https://tv.shaowt.com/gd-telecom-epg.xml
```

GitHub Raw 备用地址：

```text
https://raw.githubusercontent.com/ShaoWentao/iptv-sources/main/m3u/gd-telecom.m3u
https://raw.githubusercontent.com/ShaoWentao/iptv-sources/main/m3u/gd-telecom-epg.xml
```

## 当前规则

- 过滤 CAVS、时移、回看、广告和无效地址。
- 暂时过滤 8K、4K、UHD 和名称中标注“超高清”的源，减少播放卡顿。
- 同一频道优先选择剩余候选源中画质最高的版本，超高清版本被过滤后自动退回超清或高清。
- 上游 4K 与 HD 列表只作为辅助证据，频道名称中的明确画质标注优先。
- 输出按央视、卫视、广东、地方、体育、少儿、电影电视剧、纪录科教、4K超高清和其他分类。
- 每天北京时间 06:30 和 18:30 自动检查上游更新。

恢复超高清源时，将 `config/udpxy.json` 中的 `excludeUltraHd` 改为 `false`。

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
