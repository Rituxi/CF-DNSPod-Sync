# 部署与验收

## 当前状态（2026-10-26，UTC+8）

当前流程为轻量 Cloudflare 时钟 → Actions Node 入口 → 原工具 D1 / DNSPod。同步每 30 分钟、探测每 15 分钟。网页抓取、候选、实际三网探测调度、历史比较及 DNSPod 更新全部在 Actions；测试 Worker 独立保留。

2026-10-26 15:16:38（UTC+8）已按维护者明确授权执行 `npm run resume`，命令回读及随后独立 D1 回读均确认 `frozen=0`。只允许现有规则自动维护 `pick.luro.qzz.io` 的四条受管 A 记录；正式 Luro 域名、业务后端、小程序及业务数据库不在本次操作范围内。

解除前已核对 Cloudflare 账号 King、GitHub 账号 Rituxi、远端 `main` 提交 `0ff081f`，以及线上时钟版本 `b20fff12-2e27-4de5-ac40-b8f42641e156`、测试 Worker 版本 `dd9408e2-163d-4399-8141-b12a8213e4db`。定时投递已开启，Cron 保持原有 30/15 分钟；D1 仍为原工具库，无未完成切换或占用中的租约。主来源四线各 10 个候选有效，补充来源的过期数据继续过滤；解除前只读计划 D1 写入 0 行、DNS 未写入。

解除前四条 DNS 的最后修改时间为 2026-10-25 21:45:40–51，切换审计为 0 次。默认线的 14:10、15:10 两轮，当前 `172.64.229.14` 均成功 7/9，候选 `104.18.43.109` 均成功 9/9，三家各 3 个可比样本，符合两轮失败更少规则；已从 Globalping 原始结果回读确认与 D1 一致。解除冻结本身未执行 DNS 修改；随后默认、联通两线在正常周期内自动切换，见下表。

旧后台 `cf-dnspod-sync`、`cf-dnspod-probe` 已在确认 Cron、路由、域名和服务引用均为空后删除。对应入口、Wrangler 配置、部署命令和临时高频诊断分支已移除。GitHub 原生 schedule 不再配置，临时 schedule 诊断文件及其运行记录已清理。旧方案资料仅保留在本机忽略目录或 Git 历史，当前维护入口见 README。

## 解除冻结后的正常周期验收

| 验证 | 实际结果 | 记录 |
| --- | --- | --- |
| 15:25 自动三网探测 | 联通线 4 个目标，每目标电信 2、联通 3、移动 3 个，共 32 次实际测试；`measured`、`validForLine:true`，仅满足本线路覆盖。普通入口的 2 次联通超时保留；按原规则预留 36 次预算 | [正常周期探测](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40285724450) |
| 15:33 自动同步 | `frozen:false`、`publicationAllowed:true`、`dnsWrites:true`；默认和联通实际更新，电信与移动保持；D1 两条切换审计均为 `verified` | [正常周期同步](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40286513666) |
| 15:34 独立回读 | DNSPod 按四个原 RecordId 逐条查询，与 D1 和审计中的写后记录一致；TTL 600、备注、线路和启用状态正确。NS 未变，无未完成切换，租约已释放，`frozen=0`，两 Worker 版本及 Cron 未变 | 本机忽略目录保存原始验收证据 |

| 线路 | 本次地址结果 | 依据 |
| --- | --- | --- |
| 默认 | `172.64.229.14` → `104.18.43.109`，15:33:50 修改 | `v2:1992220:DEFAULT`、`v2:1992216:DEFAULT` 两轮均由 2 次失败降为 0 次，其他运营商无新增失败 |
| 联通 | `104.20.20.96` → `162.159.133.17`，15:33:52 修改 | `v2:1992221:CU`、`v2:1992217:CU` 双方均零失败，P95 分别 3094→1657ms、2960→2277ms，两轮都改善至少 20% 和 100ms |
| 电信 | 保持 `172.64.229.247` | 最近一轮只有 2 个电信探针，不足原规则的 3 个，`round-collection-incomplete` |
| 移动 | 保持 `104.16.159.144` | 一个候选前轮新增失败；另一个两轮速度没有持续改善，`no-consistent-improvement-hold-current` |

时钟 Tail 可分别关联上述两个运行 ID，来源均为 `cloudflare-cron`；CPU 为 1ms、0ms，无异常。新探测原始结果与 D1 逐样本一致；两条切换的连续两轮、基准版本和原判定阈值均独立重算通过，没有依赖 Actions 绿色状态代替验收。本机原有 105 项检查通过。

本轮没有手动启动探测或同步，没有强制换 IP、放宽规则、调整频率、部署代码或购买探针。验收后保持正常自动运行。全国网络效果、晚高峰和长期运行仍未验证；需要对照时按 [ITDOG 复测](itdog-acceptance.md) 短暂冻结并等到 `earliestItdogAt`，保存结果后解除冻结。

## 此前 Actions 迁移阶段的实际证据（解除冻结前）

| 验证 | 实际结果 | 记录 |
| --- | --- | --- |
| Actions 来源抓取 | 主来源四线各 10 个合格候选，无 HTTP 520；HostMonit 过期数据被过滤 | [来源](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40267710965) |
| Actions 只读选址 | `planned`、冻结、DNS 未写入；带用量版本 D1 写入 0 行 | [只读预览](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40268111739) |
| 冻结完整链路 | 时钟返回实际运行 ID，Actions 抓来源、读权威和历史、更新原 D1 快照，四线因冻结保持 | [清理后主动验证](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40279712850) |
| 正常周期自动同步 | 14:03 自动投递，完整同步成功，DNS 未写入 | [自动同步](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40277621052) |
| 新版时钟正常自动投递 | 14:33 原 Cron 自动启动同步成功，Tail 无异常、CPU 取整 0ms、墙钟 1350ms | [清理后自动同步](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40280520549) |
| 正常周期自动三网探测 | 14:10 默认线 4×9=36 次实际测试，每目标三家各 3 个；完整采集、真实失败保留、结果进入原 D1 | [自动探测](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40278302989) |
| 删除旧 Worker 后的自动探测 | 14:25 周期延迟至约 14:27 开始，36 次真实测试，`measured`、`validForLine:true` | [清理后自动探测](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40279933427) |
| 其他正常周期 | 13:40、13:55 的自动探测成功，均可关联时钟时间和运行 ID | [13:40](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40275620478)、[13:55](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40276894552) |
| 最终整理版本 Linux CI | 提交 `fd109ca`，Node 24.22.1，105 项全部通过 | [CI](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40281566726) |
| 同提交来源抓取 | 四线各 10 个合格候选，无 HTTP 520，过期来源继续过滤 | [新版来源](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40281601487) |
| 同提交只读选址 | 实际 D1 名称/ID 检查通过，读取 397 行、写入 0 行，DNS 未写入 | [新版只读预览](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40281673026) |
| 同提交冻结完整同步 | 部署后的时钟启动 Actions，读取 468 行、写入 6 行，四线冻结保持，DNS 未写入 | [新版完整同步](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40281752094) |
| 同提交真实探测 | 移动线 4 个目标，每目标电信 1、联通 3、移动 3 个实际探针，共 28 次；移动线覆盖满足原规则，`measured`、`validForLine:true`，D1 写入 7 行 | [新版探测](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40281806380) |
| 新探测后的完整同步 | 从原 D1 读入新报告并重新判定，读取 484 行、写入 6 行；仍冻结，DNS 未写入 | [新版测量后同步](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40281918055) |

14:10 一轮普通入口 8/9 成功、当前 7/9、两个候选 9/9 与 7/9。完整采集不代表全部访问成功；超时照常进入失败数，没有以 GitHub 本机测速替代，也没有用重试覆盖失败。

最终验证轮因提供方实际分配少于请求，每目标只有 7 个探针；它仅满足移动线路的原有判定要求，不能作为默认线三网完整覆盖的证据。没有补造缺失的电信样本，也没有放宽测量标准。

13:40 样本从时钟到 Node 入口约 88 秒。摘要的事件类型为 `workflow_dispatch`，自动来源由 `triggerSource:cloudflare-cron`、`scheduledAt` 和关联运行 ID 确认。快照及证据时效没有放宽。

轻量时钟三次完整 API 调用的实际 CPU 为 3.876、2.159、1.528ms；自动 Cron 的 Tail CPU 为 0、0、1ms，均成功。这些是轻量触发器样本，长期分布仍需观察。后台完整任务已移到 Node，不再依赖 Workers Free 10ms CPU 预算。未购买服务。

## 此前 Actions 迁移阶段的架构复核（解除冻结前）

- Node 改读独立 `runtime.json`，删除旧 Worker 后不再有配置依赖；部署命令只支持时钟与测试 Worker，不能重建旧后台。
- SQL 前核对远端 D1 名称和 ID，防止误填业务数据库；保留批量事务和用量统计。
- 移除旧手动榜单发布捷径，所有发布都要求连续两轮实测，D1 发布意图也强制携带两轮证据；原测量标准、冻结、冷却、预算及失败保持规则保留。
- 去掉只为旧 Worker 优化的流读取分支，验证 Node 的真实分块、gzip 中文响应及解压后 1MiB 限制。
- 新令牌轮换先启动只读计划验证权限，再替换时钟 Secret；无效令牌不会覆盖现有配置。
- 状态及 Actions 摘要区分最后检查时间与 DNS 最后修改时间，写后权威回读也保留修改时间。

原工具 D1、冻结值及冻结时间、全部 DNS 记录、测试 Worker 版本和健康响应、正式业务 Worker 版本及域名均已逐项回读比较，符合本轮保持原状的要求。代码与公开历史的密钥扫描、公开文件中的本机内容检查、两 Worker 构建和 actionlint 通过。

本轮本机 105 项检查通过，覆盖以上修复以及原选址、预算、并发、崩溃恢复、原生 D1 回滚和失败保持规则。修改后的 Node 代码已通过真实来源、DNSPod 及原工具 D1 验证：只读计划写入 0 行；冻结完整同步写入 6 行，DNS 未写入。新版时钟已部署，清理后主动启动的真实 Actions 同步成功。

## 验收边界

本次提交前复核重新核对了全部未提交改动、来源到发布的调用链、配置依赖、两轮证据和状态事务、真实调度及公开内容。没有发现新的阻止提交问题；前两轮留下的新版 Actions 验证已在提交 `fd109ca` 上补齐。代码已推送，轻量时钟已重新部署；运行记录的提交号可以区分新旧版本证据。

本次解除冻结已获维护者明确授权，未冻结的正常周期自动选址、两条真实 DNS 修改及独立写后回读已在线验证。长期自动运行与晚高峰效果、全国网络验收仍需继续观察。独立测试 Worker 和原工具 D1 继续沿用，正式 Luro 域名、业务后端、小程序及业务数据库没有改动。
