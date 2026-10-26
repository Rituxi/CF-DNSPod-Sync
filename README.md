# Cloudflare 三网实测与 DNSPod 地址池

运行流程只有一条：**轻量 Worker 定时触发 → GitHub Actions 抓取、实测、选址 → 工具 D1 保存证据 → 按规则更新 DNSPod**。

当前发布保持冻结：继续抓取和测量，保持现有 DNS。正式业务接入需另行验收。[实际验证记录](docs/deployment-and-acceptance.md) · [ITDOG 复测](docs/itdog-acceptance.md)

## 当前架构

| 入口或资源 | 职责 | 周期（UTC） |
| --- | --- | --- |
| `cf-dnspod-actions-trigger` | 仅向本仓库发送一个工作流启动请求，不运行后台业务 | 同步 03/33 分；探测 10/25/40/55 分 |
| Actions `DNSPod sync` / `run.mjs` | 网页抓取、候选、权威回读、历史选址、DNSPod 更新及验证 | 每 30 分钟 |
| Actions `Three-carrier probe` / `probe.mjs` | 调度 Globalping 真实大陆电信 AS4134、联通 AS4837、移动 AS9808 探针 | 每 15 分钟 |
| D1 `cf-dnspod-state` | 原有候选、权威快照、测量历史、冻结、租约、预算及切换审计 | 沿用原库 |
| `cf-ipv4-test` | 独立 `https://probe.luro.qzz.io/health`，提供固定正确 JSON | 无 Cron |

GitHub 服务器负责抓取和调度，三网测速发生在真实运营商探针上。两个旧后台 Worker 已删除；业务工作流只接受 `workflow_dispatch`，定时入口统一由轻量 Worker 负责，保持 30/15 分钟频率。实际启动时间可能因 Cloudflare 投递或 GitHub 排队而后移。

配置与代码边界：

- `runtime.json`：两个 Node 入口的业务配置；不依赖 Worker 部署文件。
- `wrangler.trigger.jsonc`、`wrangler.test.jsonc`：仅部署时钟和独立测试 Worker。
- `src/sources.ts`、`candidates.ts`：来源及候选连续性；`globalping.ts`、`measurement.ts`、`remote-probe.ts`：实测；`selection.ts`：选址；`state.ts`：状态事务；`sync.ts`：发布。阈值集中在 `src/config.ts`。

## 选址规则

1. V2RaySSR 优先、HostMonit 补足。每源每线前 3 个合格地址中保留最多 2 个不同挑战者，当前 IP 掉榜仍参与测量。校验 IPv4、Cloudflare 官方网段、来源原始时间不超过 6 小时、未来容差 5 分钟、丢包不超过 1%、延迟不超过 1000ms。新坏报告使候选失效；默认线只接受明确多线数据。
2. 10 秒内完成、HTTP 200、有效 TLS、完整正确的服务 JSON、固定 IP 符合才算成功。慢 200、快速 403、错误页面均失败。保留真实首次失败，不以重试成功覆盖；正确 Host/SNI、HTTPS 和 `/health` 不变。
3. 每轮普通入口、当前和最多 2 个挑战者，共至多 4 目标，每目标电信、联通、移动各 3 个探针。尽力复用同轮探针组，核对运营商和地区元数据；提供方没有稳定节点 ID。运营商线需要本运营商 3 个可比结果，默认线需要三家各 3 个；未完成、离线、429 和元数据异常不算成功。
4. 最近 6 小时，同候选、同权威基准连续两轮完整可比测量，每轮失败更少才允许切换。平手保持。仅双方两轮均零失败、每轮 P95 同时改善至少 20% 和 100ms，才允许速度切换；默认线任一家失败数不能增加。所有发布入口均执行这套判定。
5. 正常冷却 60 分钟。仅当前连续两轮多数失败，且同轮零失败的已验证备用仍在 2 小时内，才可绕过冷却。单节点失败不触发；优先复测仍共享预算。
6. DNSPod 权威回读是基准。写前检查记录身份、IP、候选、时效及租约；冻结、最新两轮证据和发布意图原子检查。写后回读；异常或结果不明时重建基准、重新积累证据。
7. 只管理 `pick.luro.qzz.io` 已初始化的 `@ A` 默认、电信、联通、移动四条记录，每条一个 IPv4、TTL 600、备注 `managed-by:cf-dnspod-sync`。证据不足、来源或测量失败就保持原 DNS，不按榜单直接发布，不迁移其他记录。

## 预算与延迟

轮转顺序：联通 → 电信 → 移动 → 默认。正常上限约 144 次探针测试/小时；手动与失败复测共享 D1 的 15 分钟时段、3 分钟租约、滚动小时 180 次预留上限。失败轮的预留也计入。创建不重试，429 按提供方时间退避，不绕过额度、不购买探针。

保留 10 秒测量预算、20 秒首次轮询等待、5 秒后续间隔、最多 20 次结果查询。首次完成结果及时落库，历史保留 48 小时。两个业务工作流共用 concurrency，运行中的任务不被新任务取消；D1 同时负责租约及去重。

权威快照有效期 35 分钟、证据有效期 6 小时不放宽。延迟导致快照过期时跳过探测、保持 DNS，不追补漏掉的时段。摘要保留 `triggerSource` 和 `scheduledAt`，便于核对自动投递及排队时间。

免费额度：[公开仓库标准 Actions runner 免费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)，本项目只用 `ubuntu-24.04`，每天计划 48 次同步、96 次探测，不使用付费大型 runner、artifacts 或缓存。[Workers Free](https://developers.cloudflare.com/workers/platform/limits/) 每天 10 万请求、账户共 5 条 Cron；本工具时钟约 144 次调用/天、2 条 Cron。[D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) 每天读 500 万行、写 10 万行、账户存储共 5GB；运行摘要报告实际行读写，需与账户其他数据库共用额度。[Globalping 匿名免费额度](https://globalping.io/credits)每出口 IP 每小时 250 次测试；每轮创建前读取实际余额并保留 18 次余量，共用 GitHub 出口额度不足就退避。

## 配置与维护

使用 Node.js 24.22.1、PowerShell 7。安装并检查：`npm ci`、`npm run check`。

GitHub 仓库 Variables 填 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID`。Secrets 如下；不要把密钥放进代码、聊天或日志。

| Actions Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 指定账户的 D1 Edit，无需 DNS/Workers 权限 |
| `TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY` | 仅限工具 DNSPod 域名的子用户凭据，策略见 [模板](docs/dnspod-policy.json) |

探测工作流只接收 D1 token。程序在发送 SQL 前向 Cloudflare 核对数据库名称与 ID，必须是 `cf-dnspod-state`。账户级 D1 token 的权限不能精确到单库，不要填入业务数据库 ID。

时钟只持有本仓库 `Actions: write` 的 GitHub fine-grained token，保存在 Cloudflare Secret `GITHUB_DISPATCH_TOKEN`。维护者需在到期前轮换：先 `pwsh -File scripts/set-trigger-token.ps1` 隐藏输入，再 `npm run trigger:token`。上传前先用新令牌启动只读 `plan` 验证权限，通过后才替换 Secret。时钟没有 D1、DNSPod 或代码写入权限。

本机资源标识保存在忽略文件 `.local/cloudflare-state.json`：`accountId`、`databaseId`、可选 `wranglerProfile`；也支持 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID`、`WRANGLER_PROFILE` 环境变量。本机可用已有 Wrangler 登录；腾讯云凭据用 `scripts/set-credentials.ps1` 隐藏保存。Actions 只使用 Secrets，不使用本机登录或文件。

| 命令 / Actions 手动模式 | 用途 |
| --- | --- |
| `npm run observe` / sync `observe` | 只抓公开来源，无 D1/DNS 写入 |
| `npm run plan` / sync `plan` | 来源、权威、历史选址预览，不写 D1/DNS |
| sync `frozen` | 完整同步，要求冻结已开启，写快照而不写 DNS |
| `npm run apply` / sync `apply` | 完整同步；冻结时仍不写 DNS |
| `npm run probe` / probe 手动运行 | 真实三网探测，共享时段及预算 |
| `npm run status` | 查看冻结、权威检查时间、DNS 最后修改时间及近期测量 |
| `npm run freeze` / `npm run resume` | 手动开启 / 解除发布冻结；解除前须由维护者明确决定 |
| `npm run deploy` / `npm run deploy:test` | 部署轻量时钟 / 独立测试 Worker |
| `npm run deploy:dry-run` | 构建检查这两个 Worker |
| `npm run logs` / `npm run logs:test` | 查看时钟 / 独立测试 Worker 日志 |

Actions 不提供解除冻结功能。时钟 `DISPATCH_ENABLED` 只控制定时投递；关闭它不会解除冻结。需要主动排查链路时，可用专用令牌鉴权 `POST /dispatch`，只允许启动必须冻结的同步或探测，不需要临时增加 Cron。

DNSPod 后台的更新时间是**记录最后修改时间**，不是任务检查时间。冻结或没有符合条件的新地址时，这个时间保持原值属于正常行为。用 `status` 的 `lastAuthoritativeCheckAt`、`lastProbeCompletedAt` 和每条记录的 `dnsUpdatedOn` 分别判断检查、测量和实际修改；不要为刷新显示时间反复写入同一地址。

## 在 Cloudflare 连接 GitHub 自动部署

一个仓库可以部署多个 Worker。分别打开下面两个**已有 Worker**的「设置 → 构建 → 连接 Git」，连接同一个 `Rituxi/CF-DNSPod-Sync` 仓库；首次连接需在面板授权 Cloudflare GitHub App，只为本次新增授权这个工具仓库。

两个 Worker 均选择生产分支 `main`、仓库根目录 `/`、构建命令 `npm run check`。Node 版本由仓库 `.node-version` 固定为 24.22.1。部署命令分别填写：

| 已有 Worker | 部署命令 |
| --- | --- |
| `cf-dnspod-actions-trigger` | `npx wrangler deploy --config wrangler.trigger.jsonc` |
| `cf-ipv4-test` | `npx wrangler deploy --config wrangler.test.jsonc` |

只开启生产分支自动部署，不启用其他分支的自动部署。保存连接后，用首次构建的成功记录确认配置生效；本节说明不表示云端连接已启用。使用当前 Workers Free 构建额度，不升级付费方案。

推送到 `main` 后，Cloudflare 分别检查并发布两个 Worker。业务选址代码由 Actions 在下一次运行时从 `main` 取用，无需另建 Worker。继续只使用 Cloudflare 这一条 Worker 自动部署入口；Actions 保留业务任务和代码检查。

Cloudflare 构建只需要部署权限，不要复制 Actions 中的 D1 或 DNSPod 密钥到构建环境。已有定时 Worker 的 `GITHUB_DISPATCH_TOKEN` 继续留在它的加密 Secret 中。公开范围包括代码、测试域名/IP 和白名单运行摘要；密钥、原始测量、本机文件及其他项目内容不随仓库公开。维护时继续检查新增文件和日志，避免手动输出密钥。
