# Cloudflare 三网实测与 DNSPod 地址池

GitHub Actions 运行现有 Node 入口，抓取候选、调度真实大陆三网探针、比较历史并按证据更新独立测试地址池 `pick.luro.qzz.io`。独立测试 Worker `cf-ipv4-test` 与工具 D1 `cf-dnspod-state` 保留在同一项目。正式业务服务不在本工具的操作范围。

当前发布保持冻结。冻结期间仍抓取和测量，DNS 不更新。迁移进度和真实验证见[部署记录](docs/deployment-and-acceptance.md)。

## 架构与频率

| 任务或资源 | 职责 | 周期（UTC） |
| --- | --- | --- |
| Actions `DNSPod sync` | 来源、候选、权威回读、历史决策、DNSPod 发布及验证；唯一自动 DNS 写入方 | 每小时 03、33 分 |
| Actions `Three-carrier probe` | 通过 Globalping 调度大陆电信 AS4134、联通 AS4837、移动 AS9808，每家 3 个实际探针 | 每小时 10、25、40、55 分 |
| `cf-ipv4-test` | `https://probe.luro.qzz.io/health` 固定 HTTPS 响应 | 无 Cron |
| `cf-dnspod-state` | 权威快照、候选、近 48 小时报告、租约、冻结和切换审计 | 原有独立 D1 |

半小时同步、15 分钟探测的频率不变；启动分钟整体后移 3 分钟，避开整点负载。两个旧后台 Worker 保留为停用备份，配置中 Cron 为空。Actions 通过 `ACTIONS_SCHEDULER_ENABLED=true` 接管调度；这一变量只启用调度，不解除 D1 中的发布冻结。

GitHub 服务器只负责抓取网页、请求 API 和决策，测速始终发生在 Globalping 的真实大陆三网探针上。普通入口、当前 IP 和候选尽力复用同轮探针组，核对运营商和地区元数据；Globalping 不公开稳定节点 ID。

模块边界保持：`sources.ts` 来源校验，`candidates.ts` 候选连续性，`measurement.ts` 实测归一化和公平比较，`selection.ts` 纯策略，`state.ts` D1，`sync.ts` 发布，`remote-probe.ts` 远程探针调度。Node 与 Worker 入口共用这些模块，阈值集中在 `src/config.ts`。

## 测量和选址规则

1. V2RaySSR 优先、HostMonit 补足。每源每线前 3 个合格地址中保留最多 2 个不同挑战者，当前 IP 即使掉榜仍参与测量。严格校验 IPv4、Cloudflare 官方网段、来源原始时间不超过 6 小时、未来容差 5 分钟、丢包不超过 1%、延迟不超过 1000ms。新坏报告使候选失效，默认线只接受明确多线数据。
2. 10 秒内完成、HTTP 200、有效 TLS、完整正确的服务 JSON、固定 IP 符合才算成功。慢 200、快速 403、错误页面均失败；真实首次失败保留，不能以重试成功覆盖。正确 Host/SNI、HTTPS 和 `/health` 保持。
3. 每轮普通入口、当前和最多 2 个挑战者共至多 4 目标，每目标至多 9 个探针。采集未完成、429、离线、ASN/地域异常不能伪装为成功。运营商线至少需要本运营商 3 个可比结果，默认线需要三家各 3 个。
4. 最近 6 小时，同候选、同权威基准连续两轮完整可比测量，每轮失败更少才允许切换。平手保持；仅双方两轮均零失败且每轮 P95 同时改善至少 20% 和 100ms，才允许速度切换。默认线任一家失败数不能增加。
5. 正常冷却 60 分钟。只有当前连续两轮多数失败、同轮零失败的已验证备用仍在 2 小时内，才可绕过冷却。单个失败节点不触发。优先复测仍共享预算。
6. DNSPod 权威回读是基准。写前核对记录身份、IP、候选、新鲜度、最新两轮证据和租约；冻结检查、发布意图和证据检查保持原子性。写后回读，异常或结果不明时下轮重建基准，重新积累证据。
7. 只管理已初始化的 `@ A` 默认、电信、联通、移动四条记录，每条一个 IPv4、TTL 600、备注 `managed-by:cf-dnspod-sync`。不迁移旧 CNAME、不删除其他记录。证据不足或来源/测量失败就保持当前 DNS，不自动退回榜单第一名。

## 预算与调度延迟

轮转顺序为联通→电信→移动→默认。正常探针测试上限约 144 次/小时；手动和失败复测共享 D1 的 15 分钟时段、3 分钟租约及滚动小时 180 次预留上限，失败轮预留也计入。创建不重试，429 按提供方时间退避，不更换出口绕过额度，不购买探针。

保留 10 秒测量预算、20 秒首次轮询等待、5 秒后续间隔及最多 20 次结果查询。D1 批量请求保持事务语义，首次完成结果先保存。工作流共用 concurrency 分组，运行中任务不被新任务取消；D1 租约与去重仍负责跨平台重叠保护。

GitHub 定时任务可能延迟或丢弃，不保证准点；35 分钟快照和 6 小时证据时效不放宽。快照过期就跳过探测、保持 DNS，不补跑漏掉的时段。公开仓库连续 60 天无活动可能自动停用定时任务，需要维护者检查 Actions 状态并重新启用。详见 [GitHub 调度说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

本仓库只用标准 `ubuntu-24.04` 托管 runner；[公开仓库标准 runner 免费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。每天计划 48 次同步、96 次探测，不受私有仓库每月 2,000 分钟配额约束。不使用付费大型 runner，不上传 artifacts、不启用缓存，避免额外存储用量；D1 和 Globalping 沿用原预算。公开日志只输出白名单摘要，完整测量保存在工具 D1。

## 配置与操作

需要 Node.js 24.22.1（24 系列）、PowerShell 7。本机运行 `npm ci`、`npm run check`。

Actions 仓库变量：`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID`、`ACTIONS_SCHEDULER_ENABLED`。凭据只放 Actions Secrets：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 对工具所在账户的 D1 Edit；无需 DNS/Workers 权限 |
| `TENCENTCLOUD_SECRET_ID` | 限工具 DNSPod 域名的腾讯云子用户 SecretId |
| `TENCENTCLOUD_SECRET_KEY` | 同一对 SecretKey |

探测工作流只接收 D1 token，不接收腾讯云凭据。Cloudflare D1 token 的权限范围是选定账户，代码额外限制为配置的工具数据库；不要把业务数据库 ID 填入变量。腾讯云策略模板见 [dnspod-policy.json](docs/dnspod-policy.json)。不要将密钥贴到聊天、日志或仓库中。

本机资源标识放在忽略文件 `.local/cloudflare-state.json`：`accountId`、`databaseId`、可选 `wranglerProfile`；也可设置同名用途的环境变量 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID`、`WRANGLER_PROFILE`。本机 D1 可用现有 Wrangler profile 登录；Actions 只使用 API Token。腾讯云本机凭据仍由 `scripts/set-credentials.ps1` 隐藏输入并保存到忽略目录。

| 命令或手动工作流模式 | 作用 |
| --- | --- |
| `npm run observe` / sync `observe` | 只抓公开来源，无 D1/DNS 写入 |
| `npm run plan` / sync `plan` | 来源、权威记录、历史选址只读预览，不写 D1/DNS |
| sync `frozen` | 完整同步，必须已有冻结；更新快照而不写 DNS |
| `npm run apply` / sync `apply` | 正常完整同步；冻结时仍不写 DNS |
| `npm run probe` / probe 手动触发 | 调度远程三网探针，共享原有时段和预算 |
| `npm run status` | 查看冻结、当前线路和近期测量 |
| `npm run freeze` | 开启发布冻结；不停止测量 |
| `npm run resume` | 仅维护者明确决定后手动解除冻结 |

Actions 不提供解除冻结功能。定时任务开关与发布冻结彼此独立。部署独立测试 Worker 使用 `npm run deploy:test`；`npm run deploy:dry-run` 验证三个保留入口可构建。部署脚本把本机标识填入忽略的临时配置，后台配置不再设置 Cron。

跨平台切换前必须按顺序完成来源、只读、冻结全流程验证，再启用 Actions 调度并清空两个旧后台 Cron，检查回读。回退时先关闭 Actions 调度，确认无在途任务，再按本机备份恢复旧 Cron；这会重新引入原 Worker CPU 与来源风险。不要同时长期启用两套调度。
