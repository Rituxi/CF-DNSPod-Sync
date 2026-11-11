# ITDOG 复测

共用地址池为 `pick.luro.qzz.io`，冻结会暂停该池的 IP 更新。[Luro 接入记录](deployment-and-acceptance.md#正式-luro-入口接入2026-10-26)

### 排查业务入口失败

先选要排查的入口，用运营商 DNS，保持「指定解析」留空。检查 TLS、HTTP 200 和对应的 JSON 服务标识。

| 入口 | 健康接口 | JSON 服务标识 |
| --- | --- | --- |
| Luro | `https://luro.928889.xyz/api/health` | `service: luro-zone` |
| One 的小程序入口（橙云对照） | `https://api.rtxone.dpdns.org/health` | `data.service: rituxione` |
| One 的优选 XYZ | `https://one.luro.928889.xyz/health` | `data.service: rituxione` |
| 用药提醒的小程序入口 | `https://api.zbbj.dpdns.org/healthz` | `service: rituxi-reminder` |
| 用药提醒的优选 XYZ | `https://remind.luro.928889.xyz/healthz` | `service: rituxi-reminder` |

用 `npm run status` 查看各线路的当前 IP、候选地址和探测结果。`dnsUpdatedOn` 是 DNSPod 记录更新时间。最近回读和探测时间看 `lastAuthoritativeCheckAt` 与 `lastProbeCompletedAt`。

若某条线路失败集中，在 ITDOG 保持业务 URL，分别固定当前 IP 和候选 IP。再用 `https://probe.luro.qzz.io/health` 固定当前 IP 对照。同 IP 的探测入口能通、业务入口持续失败时，优先核对业务域名的证书和路由。自动探测使用独立入口，业务可用性以各自 URL 的实测为准。

### 严格对照地址池

只有要做“同一组池内 IP”的严格近时对照，才先在 PowerShell 7 执行：

```powershell
Set-Location 'D:\Mini-Program\CF-DNSPod-Sync'
npm run freeze
npm run status
```

确认 `publicationFrozen: true`，等到状态返回的 `earliestItdogAt` 后再测。时间末尾的 `Z` 表示 UTC，台湾/北京时间加 8 小时。每条记录 TTL 为 600 秒；冻结时间会包含尚在运行的同步租约，因此以返回时间为准，不直接从敲命令时算 10 分钟。冻结只暂停 DNS 发布，正常抓取和探测继续运行。

1. 打开 [ITDOG HTTP(S) 测试](https://www.itdog.cn/http/)，URL 填 `https://probe.luro.qzz.io/health`。高级选项“指定解析”留空，DNS 选“运营商 DNS”，先测普通入口。
2. 保持相同运营商、协议、URL，仅将“指定解析”改为 `pick.luro.qzz.io`，再测一轮。不要填到“指定 DNS”中。
3. 保存两轮链接，核对实际 IP、时间、三网各自节点数和失败数。HTTP 200、有效 TLS、JSON 含 `ok:true` 与 `service:cf-ipv4-test` 才有效。
4. 白天与晚高峰各做近时对照。缓存旧 IP 分开统计；只有地图颜色或平均耗时不足以证明成功率改善。所有节点使用同一 IP 时，还需独立验证 DNS 分线路。

若本次为严格对照主动开启了冻结，对照期间保持冻结，避免两轮中途发生切换；保存结果后执行 `npm run resume`，再用 `npm run status` 确认 `publicationFrozen: false`。如果开始测试前就已因其他维护冻结，不要为了测试自行解除。白天与晚高峰可分别短暂冻结后做近时对照，无需为了等晚高峰一直冻结。

有限 Globalping 样本用于选址，不能替代全国验收。本工具不管理正式业务的 DNS / Worker 路由或业务数据；后续入口变更在业务项目维护和验收。
