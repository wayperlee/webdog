# Sitemap Radar P0 冻结规格 v1

冻结日期：2026-10-02。上游：context-dot-dev/webdog，commit `426158f543fbaf591f7248f1be62ebfa8b4d695c`。本文记录已确认的实施契约；PR 1 仅完成底座复现与入口收口。

## 范围与模块

沿用 Next.js、TypeScript、Tailwind、Better Auth、Drizzle、PostgreSQL 和独立 Node Worker。P0 每个网站只有一个 Sitemap Target。暂不做竞品分组、正文/价格监控、品牌识别、截图、AI、通知、付费抓取、公开分享或新账号协作。保留认证表与既有账号所有权逻辑。

网站“从 sitemap 移除”不代表网页下线；首次观察不代表真实上线。首次完整扫描只建立基线，事件为零。新增、移除、重新出现事件全量保存。

## 来源图与范围

根来源由用户配置或首次发现后固定，不在失效时悄悄切换为更小的根集合。完整来源图由本轮全部根及递归引用的子来源组成；304 复用有效 revision，并继续检查 children。

仍被图引用的文件失败 => partial，正式库存不变。不再被任何当前父节点引用的来源才可 retired。只在整个来源图完整后计算 retirement。分片移动/合并先合并全站 URL 再 diff。

target 持有 scopeVersion、filterVersion、baselineRunId 和周期配置。根集合、允许页面 host 或 URL normalization policy 变更递增 scopeVersion。新 scope 首次完整扫描重新建立基线，不生成 added/removed/reappeared；旧历史保留。库存唯一键为 websiteId + scopeVersion + normalizedUrlHash，所有正式查询和缺失证据隔离范围。

Include/Exclude 仅改变 filterVersion。site_url 与 url_event 全量保存；过滤影响查询、摘要及未来通知，不改变库存、时间、事件和基线。

## Run、调度与租约

- executionStatus = queued | running | succeeded | failed | cancelled
- completeness = unknown | complete | partial | unusable
- adoptionStatus = none | baseline | applied | quarantined | first_observation | discarded | stale

属性名 executionStatus，数据库列 execution_status：

```sql
CREATE UNIQUE INDEX crawl_run_one_active_per_target
ON crawl_run(target_id)
WHERE execution_status IN ('queued', 'running');
```

不存在 retry_wait。重试保持 queued + availableAt，属于同一 crawl_run。attempt 每次实际执行增加一次，不在失败回队与领取时重复计数。退避初值为 5、15、60 分钟，重试耗尽进入终态；尊重 Retry-After。资源超限等确定性错误不原样重试。

常规周期可选 1、6、12、24 小时，默认 6 小时；retry、manual 与 confirmation 不改变固定 cadence。paused 可手动检查；archived 禁止检查。归档保留全部历史，可恢复。

每次 claim 生成唯一 leaseToken，leaseEpoch 单调增加；workerId 仅用于诊断。租约初值 60 秒。所有 heartbeat、失败记录、续租及提交都验证 token、running 和未过期租约：

```sql
UPDATE crawl_run
SET lease_expires_at = clock_timestamp() + interval '60 seconds',
    heartbeat_at = clock_timestamp()
WHERE id = $1
  AND execution_status = 'running'
  AND lease_token = $2
  AND lease_expires_at > clock_timestamp()
RETURNING id;
```

零行 => LEASE_LOST，旧执行立即失去写权限。最终采纳在短事务锁后检验租约、scope、archivedAt 和 baseline CAS；库存、事件、基线和 Run 采纳一起提交，CAS 失败整体回滚。抓取不占数据库长事务。

## 逐 URL 缺失证据

site_url 状态 active | pending_removed | removed。保留 firstSeenAt、lastSeenAt、firstMissingRunId、firstMissingObservedAt、lastMissingRunId、missingConfirmations、removedAt。

第一次合格缺失 => pending_removed；第二次同范围、完整、独立 Run 且间隔至少一小时仍缺失 => removed。同 Run 的 attempt 不构成新的观察。pending_removed 恢复 => active，重置这轮缺失证据；removed 再出现 => reappeared，firstSeenAt 不重置。

中间完整扫描可以推进 baseline，即使不足一小时不能增加缺失计数。后续 Run 与其启动时当前 baseline 做 CAS，不要求 baseline 永远等于第一次缺失 Run。

## Suspicious 与 Candidate

异常初值：上次非空、本次为零；或一次缺失至少 100 条且占上次集合至少 30%。命中后完整 Run 为 succeeded + complete + quarantined，释放活动任务槽位，正式库存及 baseline 不变。

Candidate 状态：
- pending：尚未进入正式库存。
- adopted：已人工采纳，至少还有 URL 待确认。
- confirmed：至少一个 URL 最终 removed，且已无 pending URL。
- rejected：候选 URL 全部恢复，无 removed。
- stale / expired。

Candidate 保存 target/scope、originBaselineRunId、candidateRunId、完整缺失 URL 明细（candidate_missing_url）、missingSetHash、originalMissingCount、pendingCount、recoveredCount、removedCount、nextConfirmationAt、confirmationAttempts、lastConfirmationRunId。

Candidate 汇总来自逐 URL 事实。混合结果如 4 条中 2 removed + 2 recovered + 0 pending => confirmed；不足一小时的仍缺失 URL 保持 pending_removed。终态汇总记录当时确认结果，后来重新出现产生独立事件。

A 终态、Candidate 和 nextConfirmationAt 在一个事务中保存；不预先创建等待一小时的 queued Run。Scheduler 在到期且 target 无活动 Run 时，通过统一 enqueueRun 创建 confirmation。失败/partial/unusable 的确认不会变成第二次证据，应按策略再安排。

pending TTL = min(14 天, max(72 小时, 3 × 周期))。adopted 之后第一次缺失证据已进入库存，普通 TTL 不清除它。

pending 自动确认条件：A、B 同 scope；候选有效；B complete；两次观察间隔至少一小时；当前 baseline 等于 originBaselineRunId；相对同一原 baseline 的缺失集合 M_A == M_B。无关新增可不同。完整明细用于审计，hash 用于比较。条件满足时原子采纳 A 的第一次证据和 B 的第二次证据，写事件并把 baseline 推进到 B。

集合不相同：不沿用旧集合自动批量删除，旧候选 rejected；B 若仍可疑则创建新候选，否则进入正常采纳规则。

人工 Approve 仅对有效 pending、相同 scope 和 origin baseline 执行：A 进入首次缺失证据，baseline = A，Candidate adopted。不直接生成 Removed。后续所有完整 Run 可正常推进 baseline，通过逐 URL 证据确认移除/恢复。重复 Approve adopted/confirmed 幂等；不满足条件 => 409 Candidate Stale。

## 抓取预算与 GC

只访问经过校验的公网 HTTP/HTTPS，逐跳检查重定向、IPv4/IPv6 和实际连接 IP；禁止 DNS 重绑定与私网访问。XML 禁用 DTD/外部实体。合法空 XML 与 HTML 挑战/损坏 XML/解压错误分开；超限不采纳截断集合。

初值：
- files/site 500；URLs/site 200,000；递归深度 10；重定向/请求 5。
- 单 sitemap 解压 52,428,800 bytes。
- 单 attempt 全站压缩累计 128,000,000 bytes，解压累计 256,000,000 bytes。
- **单次 attempt wall-time 上限 10 分钟**；整个 Run 可跨多个 attempt 与退避等待。

Run identity 长期保留，180 天后清理大诊断/调试字段。crawl_run_source 默认 90 天，活跃 Candidate 引用期间保留。revision 年龄超过 30 天且无当前来源缓存、当前必要基线、活跃候选或保留窗口来源记录引用时才可 GC。事件长期保存，清理不能级联删除事件。连续长期 304 的当前 revision 不清理。

## PR 边界与验收

1. 固定上游与基线、解除 Context.dev 主流程依赖、关闭旧入口；保留 auth/website/target。
2. 原生抓取、解析、缓存、安全与完整来源图。
3. 持久化队列、唯一约束、availableAt、leaseToken、重试、CAS 所需边界和崩溃恢复。
4. 范围库存、逐 URL 证据、Candidate、原子采纳及引用驱动 GC。
5. 网站列表、详情、过滤、恢复操作与错误状态 UI。
6. 部署、备份恢复、容量和真实站点兼容性验收。

核心验收包含：首次零事件、500 条变化全量保存、分片移动无事件、partial 库存不变、父 304 子变化可见、快速手动检查不能确认移除、旧租约写入失败、并发同 target 唯一 Run、候选自动严格集合相等、中间 baseline 合法推进、混合恢复正确、范围隔离与 GC 引用不丢失。
