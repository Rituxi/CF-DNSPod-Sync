# ITDOG 复测

正式业务入口已在 2026-10-26 接入，见[业务接入记录](deployment-and-acceptance.md#正式-luro-入口接入2026-10-26)。验收普通用户链路时，用 `https://luro.928889.xyz/api/health`、运营商 DNS、**指定解析留空**；检查实际响应 IP、HTTPS 和 `service:luro-zone`。旧 IP `104.21.79.214` / `172.67.148.208` 仍出现时单独统计，不把缓存未收敛的结果当作纯优选线路表现，也不把所有失败归因于缓存。下面的测试 Worker 对照继续用于工具自身验证。

日常查看效果保持正常自动运行，直接使用下面的两轮测试步骤即可，无需先冻结或等待 TTL。正式业务域名现在也接入了同一地址池，冻结会同时暂停其优选 IP 的自动切换。

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
