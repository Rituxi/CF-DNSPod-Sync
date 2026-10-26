# ITDOG 复测

保持发布冻结，运行 `npm run status`，等到 `earliestItdogAt` 后再测。

1. 打开 [ITDOG HTTP(S) 测试](https://www.itdog.cn/http/)，URL 填 `https://probe.luro.qzz.io/health`。高级选项“指定解析”留空，DNS 选“运营商 DNS”，先测普通入口。
2. 保持相同运营商、协议、URL，仅将“指定解析”改为 `pick.luro.qzz.io`，再测一轮。不要填到“指定 DNS”中。
3. 保存两轮链接，核对实际 IP、时间、三网各自节点数和失败数。HTTP 200、有效 TLS、JSON 含 `ok:true` 与 `service:cf-ipv4-test` 才有效。
4. 白天与晚高峰各做近时对照。缓存旧 IP 分开统计；只有地图颜色或平均耗时不足以证明成功率改善。所有节点使用同一 IP 时，还需独立验证 DNS 分线路。

有限 Globalping 样本用于选址，不能替代全国验收。验收完成前保持冻结，不自动接入正式业务。
