# PR 6b：容量与 Web / Worker 运行配置验收

日期：2026-10-02。基于 PR 6a 分支 codex/pr6-live-backup-acceptance。完成本轮授权的容量验收和运行配置；实施阶段 PR 6 的审查合并与正式部署仍待执行。

## 容量结果

脚本 pr6-capacity-acceptance.ts 严格限制源连接为 127.0.0.1:55471/sitemap_radar_pr1，仅在该服务器新建随机 radar_capacity 数据库，应用已有迁移后运行，结束删除。XML 传输使用合成 fixture；原生解析、预算、持久化队列、executeClaim、真实 PostgreSQL、库存和事件代码均实际执行。不是对 100 个公网站点发起压力请求。

| 验收 | 最终样本结果 |
|---|---:|
| 单站 200,000 URL 首次基线 | 8.44s，零事件 |
| 同站持久化缓存加载，父/子共 5 来源 304 | 11.15s |
| 200,000 URL 集合替换其中 500 条 | 14.04s，完整 500 added，旧 500 pending_removed |
| 200,001 URL 超限 | 1.12s，RESOURCE_LIMIT，urls=null，未采纳截断集合 |
| 库存分页查询，20 样本、4 并发、含 offset 199,800 | p50 415ms，p95 883ms |
| 20 万 URL 中 contains 搜索 /new/ | 414ms，完整命中 500 |
| 100 target、每站 2,000 URL、4 独立 Worker 队列循环 | 11.55s，100 Run 全部 succeeded |
| 100 站点摘要，target 统计信息未主动更新 | 693ms |
| 更新统计信息后的同一摘要 | 505ms，结果相同 |

测试门槛在首次运行前设定为单次扫描 45s、分页 p95 2s、100 站点汇总 3s；没有通过调宽门槛让失败变成功。冻结的十分钟单 attempt 上限、60s 租约、5/15/60 分钟退避及语句超时未改变。

最初汇总约 6s，且受统计信息影响。修复为一次物化选定监控及路径规则、按目标批量聚合库存/事件，避免每个站点重复扫描和每条 URL 展开 JSON 规则。空库存/空事件的计数继续返回 0，过滤只影响视图，范围和库存事实不变。

并行验收期间原逐行 UPSERT 曾触发 10s statement_timeout，完整事务回滚。库存改为在原有 target 锁与同一个事务内批量 join-update 已有 URL，再只插入新 URL；先写事件、保留首次出现时间、缺失证据重置及所有状态转换。完整状态机、Candidate 与原子回滚回归测试通过。未放宽数据库语句超时。

测试程序峰值 RSS 558,530,560 bytes，事件循环 p99 42ms，数据库连接峰值 8，总测试数据库约 361MB。四个执行循环位于同一个 Node 进程并使用独立 Pool；这是数据库并发与应用处理样本，不是四台服务器的公网吞吐或线上容量承诺。分页是 API 相同形态的真实 SQL，不是大库存浏览器加载时间。

## 运行配置

- Dockerfile：Node 22、构建阶段 npm ci / next build，运行阶段移除 devDependencies，node 非 root 用户；私有环境文件不进入镜像。
- compose.runtime.yml：一次性迁移完成后启动独立 Web / Worker；unless-stopped，独立探针，日志轮转，内存上限，退出宽限。Web 默认只绑定本机。
- Pool 可配置，Web 默认 10 / Worker 默认 2，健康探针独立使用 1；连接等待/空闲超时有边界验证。
- Web readiness 不仅检查 SELECT 1，还核对 P0 schema、关键唯一索引及字段。Worker readiness 核对 PID、tick 或数据库活跃租约/heartbeat；不会修改 Run。
- SIGTERM 时中止抓取，保留同一个 Run 并遵守原退避；退出等待默认 15s，超时失败退出后由租约恢复处理不确定状态。
- railway.json 收口为 Web；另提供独立 Worker 配置。Railway 模板没有实部署验收。

使用步骤、连接预算、健康失败处理及备份回滚见 [运行手册](runtime-runbook.md)。Docker healthcheck 标记 unhealthy 本身不会触发 restart policy；需安排独立监控处理，不将其写成自动修复能力。

## 容器实际验证

pr6-runtime-acceptance.ts 新建独立临时数据库与私有环境文件，以同一个实际镜像启动上述 Compose，自动迁移空库、认证注册、API 建站、实际 daemon 原生抓取 supermaker.ai，观察 1,735 URL，并确认源库不存在试验账号。

验证包括：Web / Worker 独立容器、非 root、健康状态；临时隐藏库存表时 Web 返回 503，恢复表后返回 200；失去 tick 进展的 Worker 探针返回失败；真实 SIGKILL 后 Docker 自动重启，Worker identity 改变并恢复健康；真实抓取期间 stop 能干净退出，Run 保持 queued + availableAt，重启后不提前执行。

最终镜像 ID 见 evidence/pr6b/docker-build.txt；重启和退出时间及清理状态见 runtime.json。所有临时容器、网络、试验数据库及私有 env 均清理；原 localhost:31072 与原 Worker 持续运行，未切换其构建。私有备份继续保留在之前验收指定的位置。

容器复测曾使用 Docker CLI 手动 kill 整个容器，该操作没有触发自动重启。最终测试直接 SIGKILL Worker 进程，验证的是进程崩溃后的重启；手动停止容器仍保持停止。试验超时记录保留在 runtime-manual-stop.txt。

## 检查与边界

- typecheck、lint 通过，lint 0 errors / 8 条既有 warning。
- PR3_QUEUE_ACCEPTANCE=1 PR4_INVENTORY_ACCEPTANCE=1 npm test：91/91，通过且 0 skipped，包含真实数据库 schema、stale tick、长 attempt 活租约、过期 heartbeat / lease 和探针只读检查。
- Docker 中 production build 和 production 依赖 Worker 实际启动通过；没有覆写正在运行的原 .next。
- GitHub 未配置 CI；这些是本地证据。没有新数据库迁移、PR 合并或线上部署。
- 本轮没有正式服务器、域名、HTTPS、生产数据库角色、离机备份、平台监控或长期负载的验收。正式上线必须单独完成这些环境项。

原始结果见 evidence/pr6b。capacity-initial-slow.txt、capacity-intermediate.txt、capacity-statement-timeout.txt 保留修复前证据；capacity.json / capacity-log.txt 是最终通过结果。
