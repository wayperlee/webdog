# PR 5：可操作的网站列表和监控详情

实现阶段 PR 5，基于 DoH 补丁分支 `codex/fix-worker-doh`。GitHub PR 编号与实施阶段编号不同。仍遵循 [冻结契约](p0-contract-v1.md)，不增加竞品分组、AI、页面正文或外部通知。

网站列表显示当前 URL、24h 新增/移除/重新出现、监控状态、上次完整扫描及下次检查；可搜索域名、查看已归档网站。当前 URL 包含 pending_removed。详情提供 URLs、Changes、Runs、Candidates 和 Settings，支持 50 条分页、状态/事件类型/URL 子串筛选以及旧 scope 历史。每 5 秒串行刷新当前详情数据，切换视图时取消旧请求；列表每 10 秒刷新。请求失败保留恢复入口。

首次完整扫描只建立基线。界面明确“首次观察”与上线日期不同、“从 sitemap 移除”与网页下线不同。Run 显示覆盖完整性与库存采纳状态，区分初次排队、重试等待、运行、完成和最终失败；重复 Run now 显示现有 Run 的 availableAt，不绕过退避。每 attempt 10 分钟上限与总 Run 生命周期仍分开。

Candidate 展示 original/pending/recovered/removed 数量、来源基线、观察/到期/确认时间和全量缺失 URL。Approve 标为 Adopt first observation，只采纳第一次证据；不会立即移除 URL。missing_set_changed 的 rejected 批次显示 Replaced，避免误称全部恢复。过期 pending 在界面显示 Expired 并禁用采纳，GC/后续抓取负责持久化终态。

## 设置与迁移

追加 `0008` 迁移，仅在 target 增加 include_paths/exclude_paths，默认为空数组；没有改写旧迁移。

- GET `/api/targets/:id`：当前配置、受筛选影响的库存及 24h 摘要、历史范围列表。
- PATCH `/api/targets/:id`：enabled、checkIntervalHours、archived、includePaths、excludePaths。严格请求体，沿用有效账号所有权；写事务先锁 target。读取保留原有账号成员可见性。
- PATCH `/api/targets/:id/scope`：roots、allowedPageHosts，两项都必须提供，null 表示自动默认。根和 host 通过原生公网/规范化校验；范围变化建立新基线并保留旧范围库存及事件。
- urls/events 新增 q（最大 200 字符 URL 子串），events 新增 kind；runs 增加有上限的分页和 scopeVersion，保留原 runs 返回字段兼容旧调用。

过滤规则固定为逐行、区分大小写的 pathname **字面前缀**。Include 为空表示全部，否则满足任一规则；Exclude 优先。规则必须以 / 开头，不带空白/query/fragment，每类最多 100 条；去重排序后语义相同不增版本。使用 URL 已编码 pathname；% 与 _ 没有 SQL 通配符含义。筛选作用于当前/历史 URL、事件查询与当前摘要，Candidates 仍展示完整缺失集合。全部值通过参数绑定查询。只增加 filterVersion，不改变 scopeVersion、基线、任何库存/事件/缺失证据。

修改周期只在值实际变化时重设下次时间，保存相同周期或修改过滤不移动 cadence。暂停允许手动检查。归档保留 enabled 与全部历史，取消 queued/running Run、结束 running attempt 审计并撤销 running lease，避免归档后立即恢复时旧执行重新采纳；历史不删除。恢复保留原周期与暂停状态。后续 scheduler 沿原固定 cadence 处理到期时间；恢复不会复活已取消的 Run。

## 验收证据与限制

专用本地 PostgreSQL：127.0.0.1:55471/sitemap_radar_pr1；网页 http://localhost:31072。没有迁移其他 SaaS 或 Production 数据库。仅专用 QA 账号/站点参与写验收，用户的 supermaker.ai 设置未修改；只读检查当前范围库存为 1,735。

- 88 项测试全通过、0 skipped，包含真实 PostgreSQL 队列、原子采纳、scope、过滤事实不变、字面 %/_、相同配置幂等、归档撤销 running lease、立即恢复仍拒绝旧执行以及暂停后手动检查。
- typecheck/build 通过；lint 0 errors，8 条既有上游 warning。
- `scripts/pr5-acceptance.ts`：真实 HTTP 鉴权、跨账号拒绝、严格 payload、非法路径/私有地址拒绝；123 条库存/121 个事件；筛选后 120 条库存/119 个事件与摘要一致，过滤前后库存事实摘要相同；Candidate 明细分页与归档/恢复。
- ego-browser 专用账号：列表/详情、库存与 Changes 分页、搜索空结果/清除、非法规则错误、周期与路径设置、Candidate 全量分页/第一次观察采纳、scope 2 基线提示/旧 scope 1 历史、归档隐藏/显示/恢复、暂停/恢复与手动检查、最终失败后重新提交、重试等待及重复提交退避提示、后台完成自动显示 attempt 2。
- 390px 移动视口正文宽度为 390px，无整页水平溢出；表格与导航允许局部横向滚动。截图是 QA fixture，不是假称真实竞品内容。
- XML、失败及 retry 为明确可控 fixture。QA retry 的 availableAt 被提前到当前时间，以验证同 Run attempt 2 的界面更新；没有声称真实等待退避或一小时。真实公网 DoH 兼容性证据见 [network-doh.md](network-doh.md)。

证据在 [evidence/pr5](evidence/pr5)。复现：先应用迁移、构建并启动 31072 网页，暂停本项目 Worker，再设置绝对路径 `PR5_ACCEPTANCE_AUTH_FILE` 并执行 `npx tsx scripts/pr5-acceptance.ts`。该文件仅保存新建 QA 登录信息，0600 权限，不进入 Git，用于浏览器后应删除。数据库单元矩阵使用随机独立 schema，完成只删除自己的 schema。HTTP/浏览器 QA 网站保留为暂停状态，以保留验收历史。

跨请求 offset 分页可能受并发新事件影响，不提供稳定导出；大量站点/200k URL 的生产容量尚未验收。GitHub 没有配置 CI，本地通过结果不等于远程 CI。当前 PR 未合并、未部署线上；部署、备份恢复及容量属于实施阶段 PR 6。
