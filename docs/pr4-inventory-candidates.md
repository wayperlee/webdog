# PR 4：URL 库存、Candidate 与原子采纳

基于 PR 3 分支，遵循 [冻结规格](p0-contract-v1.md)。本阶段完成后端库存和采纳，网站列表、详情 Tabs、筛选配置与归档/恢复界面在 PR 5。

## 正式采纳

首次完整扫描创建当前 scope 的 `site_url`，零事件，并推进 `baseline_run_id`。之后完整扫描全量记录 `added / removed / reappeared`，不截取前 100 条。库存键为 website + scope + URL SHA-256；已有 URL 的 firstSeenAt 保留。

第一次缺失进入 pending_removed。第二次必须是独立完整 Run，且距 firstMissingObservedAt 至少一小时；快速扫描可以推进基线，但不能增加确认次数。partial/unusable 和同 Run retry 不构成额外证据。恢复会清空本轮缺失字段，已 removed 的 URL 再出现生成 reappeared。

采纳与来源缓存、事件、基线 CAS、Run/attempt 状态使用同一个短事务。锁顺序仍为 target → Run；最终 UPDATE 再以 clock_timestamp 验证租约。租约在库存写入后过期也会整体回滚。

`configureScope` 提供经过所有权、公网 URL/host 校验的后端事务入口：语义相同配置不增加版本；根或 host 变化增加 scopeVersion，清空当前基线及发现/来源图状态，取消旧 queued Run，旧 running 结果在最终提交时丢弃，活跃 Candidate 变 stale。旧范围库存、事件和 Run 保留。配置 UI/API 接线属于 PR 5；filterVersion 不参与库存采纳或缺失确认。

PR 3 的成功 Run 不自动反向产生事件：升级后若 target 尚无基线，下一次完整 Run 建立新库存基线。

## Candidate

异常完整扫描终结为 succeeded + complete + quarantined。Candidate、完整缺失明细及一小时后的 nextConfirmationAt 同事务保存；等待期间不占 queued/running 槽。

Scheduler 在到期时通过同一个 enqueueRun 创建 confirmation，与 manual/scheduled 使用相同活动任务唯一约束。confirmation 不改常规定时 cadence。创建确认 Run 时增加 confirmationAttempts 并记录 lastConfirmationRunId，将下一次独立确认安排为一小时后；Run 内的退避和 attempt 仍由 PR 3 管理。失败/partial 不采纳库存或提供第二证据。

pending 自动确认比较同一个原始基线的完整缺失集合，同时检查 scope、当前基线、TTL 与一小时间隔。无关新增可以不同。相等时在一个事务采纳 A 的第一次观察和 B 的第二次观察，将 A 标为 first_observation，基线推进到 B。间隔不足且集合相等的完整 Run 继续 quarantined，保留 A，不重置等待时间。

集合变化按冻结规则拒绝旧批次：`status=rejected, reason=missing_set_changed`，保留原集合及当前恢复数量；仍缺失明细保持 pending，表示该批次已被替代，而非已确认恢复。B 若仍异常建立新 Candidate，否则采用正常逐 URL 规则。`reason` 区分批次替代与“全部 URL 恢复”的 rejected，避免审计时把两者混为一谈。

Approve 验证所有权、scope、有效 pending 和 origin baseline，只采纳 A 第一次证据，不写 Removed；重复 adopted/confirmed 幂等。旧范围或过期候选返回 CANDIDATE_STALE（HTTP 409）。Approve 与 Worker 通过 target 锁串行：已启动旧基线 Run 的结果将 stale。

adopted 汇总从 site_url 状态逐 URL 刷新；4 条原始缺失中 2 recovered + 2 removed => confirmed。全部恢复 => rejected。终态明细与数量不再随之后的 reappeared 改写。普通 pending TTL 不清除 adopted 证据。

## 查询接口

- GET `/api/targets/:id/urls`：库存，可按 status 查询。
- GET `/api/targets/:id/events`：全量变化事件。
- GET `/api/targets/:id/candidates`：Candidate 汇总。
- GET `/api/targets/:id/candidates/:candidateId/urls`：完整候选缺失明细与 resolution。
- POST `/api/targets/:id/candidates/:candidateId/approve`：严格空 JSON body，采用现有写账号所有权逻辑。

GET 默认 limit=100，上限 200，offset 0..200000。库存/事件/Candidate 汇总支持 scopeVersion，默认当前范围；Candidate 明细固定候选范围。单个查询使用一致数据库快照返回 total/items/nextOffset。跨请求 offset 分页仍可能受并发新事件影响，稳定导出能力留待后续。所有读取沿用原有账号可见性；写入验证当前有效 owner，客户端不能传 lease 或配置。

## GC 与迁移

新增迁移 0006（库存、事件、Candidate、observedAt、状态 CHECK/FK）和 0007（Candidate 历史/活跃引用索引及每 Run 一个 Candidate）。之前迁移未改写。外键使用 RESTRICT，事件与 Run identity 不删除。

Worker 启动及每小时调用引用驱动 GC，每类大字段/来源/revision 分批清理，默认每类最多 1000 条：

- pending TTL 过期或 scope/baseline 失效时结束 Candidate；adopted 只在 scope 失效时结束。
- 非当前 scope 缓存退出当前缓存；历史来源记录按引用保留。
- 90 天以上 Run source，仅在不被当前基线或活跃 Candidate 引用时清理。
- 180 天以上终态 Run 的大 result/error 与 attempt.error，仅在不被当前基线或活跃 Candidate 引用时清理。
- 30 天以上 revision 必须没有任何来源缓存或 Run source 引用才删除。当前基线和活跃候选先保护 Run source，因此连续长期 304 的内容保留。

GC 不删除 Candidate 原始明细、URL 事件、库存或 Run identity。部署时必须先应用迁移再启动新 Web/Worker。

## 本地证据

专用 PostgreSQL 16 QA：127.0.0.1:55471 / sitemap_radar_pr1。未访问其他 SaaS 或 Production 数据库。

- `PR3_QUEUE_ACCEPTANCE=1 PR4_INVENTORY_ACCEPTANCE=1 npm test`：79 项测试全部通过、0 skipped；数据库矩阵与抓取/队列回归见 evidence/pr4/tests.txt。
- typecheck/build/API 验收通过；lint 无 error，8 条既有上游 warning。
- API 验证首次零事件、500 条新增全量分页、完整 Candidate 明细、Approve、2 recovered + 500 removed、409 和匿名/跨账号拒绝。旧 snapshot/alert 内容摘要保持一致。
- 来源图、304 和分片移动沿用 PR 2 原生引擎测试。数据库 rollback 测试包括锁等待前过期，以及通过触发器让租约在库存写入后过期。
- 默认原生 Worker 另外实际验证 fake-IP 的 UNSAFE_ADDRESS 拒绝路径，失败后基线、库存和事件数量不变，见 evidence/pr4/native-worker.txt。
- API 中的 XML 为明确的可控 fixture；时间边界通过专用测试数据调整时间验证，未伪称实际等待一小时或真实站点上线/下线。
- 本轮不改变界面交互，未新增浏览器视觉验收。真实公网抓取仍受本机 fake-IP DNS 环境影响；未放宽 SSRF 校验。容量/部署/备份恢复验收属于 PR 6。
