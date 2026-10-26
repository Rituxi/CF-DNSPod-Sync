# 部署与验收

## 2026-10-26：GitHub Actions 迁移

迁移网页抓取、候选整理、历史比较、选址、DNSPod 更新和远程探针调度到 Actions；复用 `run.mjs`、`probe.mjs` 以及原业务模块。独立测试 Worker 和原工具 D1 保留，不迁移数据、不改正式业务。

发布冻结保持开启，连续两轮门槛、冷却、预算和失败保持原 DNS 的规则保持。GitHub runner 只调度实际大陆三网探针，不参与替代测速。

迁移前已确认：发布冻结开启、切换审计 0 次、独立 HTTPS 测试入口 200 且正确 JSON/no-store。原同步每 30 分钟，探测在每小时 07、22、37、52 分。旧历史与内部交接内容仅保存在本机忽略目录及本机历史分支，公开仓库从清理后的新历史开始。

Actions 配置保持 30/15 分钟频率，整体后移 3 分钟避开整点。两工作流共享 concurrency，D1 租约、去重和滚动预算继续生效。初始化时 `ACTIONS_SCHEDULER_ENABLED=false`，先验证再交接；发布冻结不会随调度开启而解除。

### 实际验证

所有时间使用 UTC+8。运行详情链接公开，密钥由 Actions 自动遮蔽，完整原始测量仍在工具 D1。

| 验证 | 实际结果 | Actions 记录 |
| --- | --- | --- |
| 首次 CI | Linux/Node 24.22.1，92 项通过 | [Check](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40267699718) |
| 12:10 来源抓取 | 主来源四线各 10 个合格候选，无 520；HostMonit 过期数据被过滤 | [observe](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40267710965) |
| 12:11 只读选址 | `planned`，发布冻结，`dnsWrites:false`；证据不足保持当前地址 | [plan](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40267779948) |
| 12:12 冻结完整同步 | 正常读来源/权威/历史并更新 D1 快照，四线均因冻结持有，DNS 未写入 | [frozen sync](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40267840921) |
| 12:13 同时段重复探测 | `round-already-claimed`，没有新建探测或新增消耗 | [duplicate protection](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40267918589) |
| 新增 D1 用量统计后的 CI | 93 项通过 | [Check](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40268034031) |
| 12:15 带用量统计的只读选址 | D1 读取 260 行、写入 0 行，DNS 未写入 | [plan](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40268111739) |
| 12:15–12:16 完整三网探测 | 默认线一组：普通入口、当前和 2 个挑战者，4×9=36 次实际探针测试；每目标电信/联通/移动各 3 个，覆盖完整，`measured`、`validForLine:true`；D1 读取 56 行、写入 7 行 | [probe](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40268144308) |
| 12:17 测量后再次同步 | 从原 D1 读入新报告，仍按两轮证据判定；四线冻结持有，D1 读取 328 行、写入 6 行，DNS 未写入 | [post-probe sync](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40268283869) |

本机额外验证：三个 Worker 入口 dry-run 可构建，actionlint 通过；四个旧提交与公开新历史均经 Gitleaks 扫描无泄漏，公开文件逐一匹配本机凭据值和内部内容无命中。旧分支、bundle、原文档和验证输出仅留在本机忽略目录。D1 REST 批量接口已在原工具数据库中验证事务失败回滚，临时验证表已清理，原控制表和迁移保持。

测量、候选、连续两轮、冷却、冻结、预算、状态事务与迁移的原业务模块与迁移前一致。`sync.ts` 仅增加迁移验证模式的“必须冻结”断言，避免验证时误以为冻结已开启。

本次探测保留真实失败：普通入口 8/9 成功、当前 8/9、两个候选分别 9/9 和 6/9。采集完整不代表每个网络请求都成功；失败照常进入分母，没有用 GitHub 服务器测速或用重试覆盖。仅一轮候选更好不能解除冻结，也不能跳过连续两轮门槛。

正常每天 48 次同步、96 次探测，GitHub 标准公开 runner 免费。D1 上述单次实际行数明显低于免费日额度，但不是全账户长期额度验收；读写量会随历史、候选和错误路径变化，保留摘要便于后续观察。未购买服务、探针或额外存储。

### 调度交接

12:18 在上述真实验证完成后启用 `ACTIONS_SCHEDULER_ENABLED=true`，再通过 Cloudflare API 清空 `cf-dnspod-sync`、`cf-dnspod-probe` 的 Cron。两工作流均为 active，代码配置也保留空 Cron，防止后续部署误恢复两套后台。旧 Worker 实例和代码保留为停用备份，没有重新部署；测试 Worker 无需变更。

12:19 回读确认：两后台 Cron 均为空；冻结值及冻结时间、四条 DNS 的全部记录信息和更新时间、切换审计 0 次、工具/测试 Worker 版本、正式业务 Worker 和 Custom Domain 均与迁移前一致。独立健康入口仍为 200、正确 JSON、no-store。原 D1 和既有迁移不变。

截至 12:38，12:25 探测与 12:33 同步的自动运行记录仍未生成。默认分支、远端 YAML、工作流 active、仓库 Actions 权限和调度变量均已回读正常；手动与 push 事件运行正常。GitHub 状态页没有公告 Actions 故障，但这不能证明当前仓库调度链路正常。仅凭这些信息尚不能确定是初始化、延迟、丢弃或仓库调度登记问题。

12:36 已通过 API 重新启用两工作流；随后将 Cron 改为等价的范围/步长写法（同步 `3-59/30`，探测 `10-59/15`），重新提交以刷新定时登记，仍为 03/33 和 10/25/40/55 分，不增加频率或探针。这个排查动作尚不等于已证明根因或已恢复自动运行。参考 [GitHub 定时排障](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#scheduled-workflow-stopped-running)。

自动定时触发仍待真实记录验收。长期准点性、晚高峰效果和未冻结的真实 DNS 修改路径仍不在本次冻结验证结论内。
