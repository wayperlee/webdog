# PR 3：持久化任务、租约和恢复

本阶段接入 PR 2 的原生引擎，实现 [冻结契约](p0-contract-v1.md) 的执行层。应用 Run now 可提交持久化 Run，Worker 负责抓取。扫描结果、来源和缓存可以查询；正式库存、增删事件、Candidate 与 baseline 采纳由 PR 4 实现。当前完整扫描的 adoptionStatus 仍是 none。

## 数据与并发

新增 crawl_run、crawl_run_attempt、crawl_run_source、sitemap_revision 和 sitemap_source_cache；target 增加 scope/filter/baseline、根、缓存策略和 archivedAt 字段。迁移为 0004 与 0005，两份由 Drizzle 生成，保留既有认证/网站/target/snapshot/alert 数据。Run、baseline、来源缓存/revision 通过 restrict 外键保留引用；本阶段不做年龄清理或物理删除。

`crawl_run_one_active_per_target` 使用 execution_status IN ('queued','running') 的 partial unique index。所有入口使用同一个 enqueueRun，并在 target 行锁下提交；并发请求返回同一个活动 Run。Run now 返回 HTTP 202，提交期间不执行抓取。

claim 使用 FOR UPDATE OF target SKIP LOCKED，再更新 Run，生成新的 leaseToken、增加 leaseEpoch 和 attempt。attempt 只在领取时增加，初值 0，最多 4 次实际执行。所有多行事务按 target → Run 顺序锁定，抓取和 XML 解析在事务外进行。

heartbeat 每 20 秒执行，租约初值 60 秒。先取得 Run 行锁，再用 clock_timestamp() 检验 token/running/未过期并续租，避免锁等待后恢复已过期租约。最终提交在锁后核对 scope、archivedAt、originBaselineRunId，并在写入结束后再次检验真实数据库时间与 token；零行返回 LEASE_LOST，整个事务回滚。数据库函数语义见 [PostgreSQL 时间函数](https://www.postgresql.org/docs/current/functions-datetime.html)，领取机制见 [SELECT SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)。

## 重试、周期和恢复

- 可重试失败回到同一个 Run 的 queued，availableAt 使用数据库当前时间加 5/15/60 分钟，尊重更长的 Retry-After。不存在 retry_wait。
- 确定性错误不原样重试；有不可重试 issue 的不完整扫描进入 failed。第四次失败耗尽重试。
- scheduled 在入队时推进固定 cadence，错过多个周期只推进到下一次未来时间；活动槽位繁忙时也推进时钟，避免立即补跑一串历史任务。manual、retry、confirmation 不移动周期。
- paused 允许 manual，禁止自动任务；archived 拒绝提交和领取。scope/归档/baseline 改变使旧结果 cancelled + stale，缓存与正式 baseline 均不采纳。
- 租约续期最多到 attemptStartedAt + 10 分钟。到期后该 attempt 失败，可重试时同 Run 回队；Run 生命周期可跨多次 attempt 和等待，超过 10 分钟。
- Worker 崩溃后 expired-lease sweeper 将 attempt 记为 lost，回队或终止。达到 attempt wall-time 时记为 failed/ATTEMPT_TIMEOUT。旧 token 无法续租、失败记录或提交。
- graceful shutdown 中止抓取并记录可重试 WORKER_SHUTDOWN；heartbeat 失败立即撤销本地写权限。持久化结果不确定时保持 running，交给租约恢复，避免重复写终态。

Worker 的 scheduler 每次 tick 扫描最多 100 个到期 target。它预留 confirmation 入队原因；Candidate 的到期选择和再安排归 PR 4，不预建等待一小时的 queued Run。

## 缓存与结果

每次 Run 保存全量 URL 结果和完整性；来源按 Run/attempt 保存，不截断为前 100 条。revisions 不可变，缓存采用 target + scopeVersion + sourceUrl，重启后可恢复 304。父 304 继续访问 children。

持久化层再次保护完整性：partial/unusable 始终保留 target 上一张完整 liveSources。当前缓存只保留上一完整图与本次观察所需引用，完整图退出来源后可以移除当前缓存引用。旧来源记录和 revisions 保留，PR 4 再按基线/Candidate/保留窗口引用做 GC。缓存变化不是 URL 移除事件。

GET /api/targets/:id/runs 只提供最近 20 个 Run 的状态、完整性、attempt、计数、错误和时间。它经过已有账号所有权鉴权，不返回 leaseToken、workerId、全量 URL 或配置。

## 使用和验收

```sh
npm run db:migrate
npm run dev
# 单独进程运行：
npm run worker
# 一次 tick，最多实际执行一个 Run：
npm run worker:once

# 独立本地 QA 数据库专用的真实 PostgreSQL 并发测试：
PR3_QUEUE_ACCEPTANCE=1 npm test
```

`DATABASE_URL` 和 Better Auth 按本地/部署环境配置。Context.dev、AI、邮件 key 都不需要。SCRAPE_CRON 是被忽略的旧配置，Worker 空闲时每 5 秒轮询，忙时持续处理可领取 Run。每个 Web/Worker 进程的数据库 Pool 上限 10；Production 连接预算由 PR 6 验收。

真实 PostgreSQL 测试显式限制 localhost/127.0.0.1 与 sitemap_radar_pr1，创建独立随机 schema，测试后删除。覆盖 15 并发入队、10 并发领取、数据库 unique index、延期领取、4 次重试、旧 token、锁等待过期、缓存/result 原子回滚、scope/归档/baseline stale、固定 cadence、长期缓存重启、partial 图保护、超时失败、graceful shutdown、实际 Worker SIGKILL，以及默认原生 Worker 拒绝私网根。

SIGKILL 用实际子进程，确认 running 后终止；验收通过 SQL 将租约设为已过期来加速恢复，不伪称等待了完整 60 秒。单次 attempt 10 分钟边界也通过数据库时间 fixture 验证，没有真实等待 10 分钟。

API/浏览器使用 production build + 独立本地 QA 数据库验证：匿名/跨所有者拒绝，10 并发 HTTP 返回 202 和同一 Run，paused 手动执行，archive 拒绝，旧 /api/cron/run 同队列提交，历史 snapshot/alert SHA-256 不变。浏览器完成登录、Run now、queued 状态和自动轮询到 succeeded。浏览器显示的 2 URLs 来自原生 XML fixture，不是真实竞品 URL 数量。真实 HTTP/TLS 站点兼容性证据仍见 PR 2；本机 fake-IP DNS 继续被默认引擎拒绝。

最终检查日志见 [tests](evidence/pr3/tests.txt)、[typecheck](evidence/pr3/typecheck.txt)、[lint](evidence/pr3/lint.txt)、[build](evidence/pr3/build.txt)、[API](evidence/pr3/api.txt)、[browser](evidence/pr3/browser.txt)。迁移仅应用于本地隔离 QA；没有 Preview/Production 迁移、合并或部署。PR 3 基于尚未合并的 PR 2 分支。

本地最终计数：57 项测试通过（启用真实 PostgreSQL 集成测试，0 skipped）、typecheck/build 通过，lint 0 error、8 条既有 warning。普通 npm test 默认跳过需要专用数据库的集成 suite，不能替代上述显式运行。

## PR 4 接口边界

PR 4 在最终短事务内接入库存/事件/Candidate/baseline 采纳，保留当前锁顺序、真实时间和 token 校验；scope/baseline CAS 失败必须整体回滚。完整性只是采纳前提，不能单独表示 baseline 已建立。配置变更必须递增 scopeVersion 并重置当前 scope 的发现/图状态；Include/Exclude 仅递增 filterVersion。历史 Run 和 source/revision 引用不能因库存重建而丢失。
