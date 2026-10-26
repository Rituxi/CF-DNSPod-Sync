# ITDOG 复测

日常保持正常自动运行。准备做一组 ITDOG 对照时，先在 PowerShell 7 执行：

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

本组对照期间保持冻结，避免两轮中途发生切换。保存结果后执行 `npm run resume`，再用 `npm run status` 确认 `publicationFrozen: false`，恢复正常自动发布。白天与晚高峰可分别短暂冻结后做近时对照，无需为了等晚高峰一直冻结。

有限 Globalping 样本用于选址，不能替代全国验收。正式域名、业务后端、小程序及业务数据库的接入仍需另行验收和授权。
