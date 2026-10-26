# 部署与验收

## 当前状态（2026-10-26，UTC+8）

当前流程为轻量 Cloudflare 时钟 → Actions Node 入口 → 原工具 D1 / DNSPod。同步每 30 分钟、探测每 15 分钟。网页抓取、候选、实际三网探测调度、历史比较及 DNSPod 更新全部在 Actions；测试 Worker 独立保留。

发布冻结保持开启，切换审计为 0 次。四条 DNS 的最后修改时间仍为 2026-10-25 21:45:40–51；这是最后发布时刻，不代表后台停止。今天的同步持续刷新权威检查时间，冻结期间不改 DNS。

旧后台 `cf-dnspod-sync`、`cf-dnspod-probe` 已在确认 Cron、路由、域名和服务引用均为空后删除。对应入口、Wrangler 配置、部署命令和临时高频诊断分支已移除。GitHub 原生 schedule 不再配置，临时 schedule 诊断文件及其运行记录已清理。旧方案资料仅保留在本机忽略目录或 Git 历史，当前维护入口见 README。

## 已取得的实际证据

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
| 已发布版本 Linux CI | Node 24.22.1，101 项通过 | [CI](https://github.com/Rituxi/CF-DNSPod-Sync/actions/runs/40274787871) |

14:10 一轮普通入口 8/9 成功、当前 7/9、两个候选 9/9 与 7/9。完整采集不代表全部访问成功；超时照常进入失败数，没有以 GitHub 本机测速替代，也没有用重试覆盖失败。

13:40 样本从时钟到 Node 入口约 88 秒。摘要的事件类型为 `workflow_dispatch`，自动来源由 `triggerSource:cloudflare-cron`、`scheduledAt` 和关联运行 ID 确认。快照及证据时效没有放宽。

轻量时钟三次完整 API 调用的实际 CPU 为 3.876、2.159、1.528ms；自动 Cron 的 Tail CPU 为 0、0、1ms，均成功。这些是轻量触发器样本，长期分布仍需观察。后台完整任务已移到 Node，不再依赖 Workers Free 10ms CPU 预算。未购买服务。

## 本轮架构复核

- Node 改读独立 `runtime.json`，删除旧 Worker 后不再有配置依赖；部署命令只支持时钟与测试 Worker，不能重建旧后台。
- SQL 前核对远端 D1 名称和 ID，防止误填业务数据库；保留批量事务和用量统计。
- 移除旧手动榜单发布捷径，所有发布都要求连续两轮实测，D1 发布意图也强制携带两轮证据；原测量标准、冻结、冷却、预算及失败保持规则保留。
- 去掉只为旧 Worker 优化的流读取分支，验证 Node 的真实分块、gzip 中文响应及解压后 1MiB 限制。
- 新令牌轮换先启动只读计划验证权限，再替换时钟 Secret；无效令牌不会覆盖现有配置。
- 状态及 Actions 摘要区分最后检查时间与 DNS 最后修改时间，写后权威回读也保留修改时间。

原工具 D1、冻结值及冻结时间、全部 DNS 记录、测试 Worker 版本和健康响应、正式业务 Worker 版本及域名均已逐项回读比较，符合本轮保持原状的要求。代码与公开历史的密钥扫描、公开文件中的本机内容检查、两 Worker 构建和 actionlint 通过。

本轮本机 105 项检查通过，覆盖以上修复以及原选址、预算、并发、崩溃恢复、原生 D1 回滚和失败保持规则。修改后的 Node 代码已通过真实来源、DNSPod 及原工具 D1 验证：只读计划写入 0 行；冻结完整同步写入 6 行，DNS 未写入。新版时钟已部署，清理后主动启动的真实 Actions 同步成功。

## 验收边界

Actions 验证以运行记录中的提交号为准。迁移前的成功记录证明现有调度可用；本轮 Node 配置整理及策略入口收拢还需在推送后使用对应新提交验证，不能把本机检查当作新版 Actions 运行结果。

长期自动运行与晚高峰效果、全国网络验收仍需继续观察。未冻结的真实 DNS 修改尚未在线验证，必须由维护者后续明确授权；不为测试解除现有冻结。独立测试 Worker、原工具 D1、正式域名、业务后端及业务数据库保持原资源。
