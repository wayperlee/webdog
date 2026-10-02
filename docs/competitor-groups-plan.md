# Sitemap Radar 竞品分组实施方案 v1

日期：2026-10-02。状态：待确认的实现方案，尚未实现或迁移。基于当前仓库源码梳理。

## 1. 要实现的结果

把同一个竞品团队经营的网站放进一个分组，在一个页面查看站群的 URL 规模、近期 sitemap 变化、各网站监控状态和变化明细。

示例：创建“小羊团队” → 把已有网站归入该组 → 查看近 7 天哪个网站动作最多 → 点击一条变化进入对应的网站记录。

产品称“竞品分组”，现有英文界面使用 `Competitor groups`。代码使用 `competitor_group`，避免与 webdog 既有账号成员、邀请和权限模型混淆。

## 2. 第一版范围

包含：

- 创建、重命名、编辑备注、删除分组。
- 每个网站最多属于一个分组，也可以未分组。
- 添加网站时选择分组；网站详情修改归属；列表选择多个网站进行一次批量归组或移出。
- 所有网站列表增加分组筛选与分组列。
- 分组列表显示网站数、当前 URL、24h 或 7d 的 added / removed / reappeared 和待处理状态。
- 分组详情提供 Websites、Changes 两个视图，支持时间窗口、网站和事件类型筛选，以及变化数量排序。
- 分组删除后，网站变为未分组，网站、库存、事件和扫描记录保留。

后续再做：一个网站多个标签/分组、自动识别背后团队、外部通知、AI 分析、组织协作改造、分组统一抓取范围、全组一键 Run now/暂停/改周期、归属变更审计和全组 URL 导出。

现有抓取器、队列、租约、重试、逐 URL 状态机、Candidate、scopeVersion 和 filterVersion 的契约继续沿用。竞品分组本身不作为抓取 Target。

## 3. 必须先固定的产品语义

### 3.1 当前归属决定聚合范围

分组统计的是“目前属于该组的网站，在所选时间范围内的事件”。它不表达“事件发生时网站属于这个组”。

- 新建分组并加入一个已监控的网站：它过去 24h / 7d 的现有事件立即参与汇总。
- 网站从 A 移到 B：A 不再汇总它，B 汇总它在所选窗口内的已有事件。
- 重命名分组：只改变名称。
- 删除分组：网站变为未分组，原有事实记录完整保留。
- 加入、换组、移出分组不会建立新基线、创建新 Run 或产生 URL 变化事件。

页面显示提示：“变化按当前分组成员汇总，网站换组会改变分组历史视图。”未来如果需要事件发生时的归属审计，应单独增加归属历史模型；不要提前向 url_event 写入冗余 groupId。

### 3.2 未分组是一个视图

`competitorGroupId=null` 表示未分组，不创建特殊数据库分组行。筛选器提供 All groups、Ungrouped 和真实分组。未分组视图不能重命名或删除。

### 3.3 归档和暂停

默认分组网站表、统计和 Changes 排除已归档 monitor；提供 Show archived 统一纳入。网站仍保留分组归属，恢复归档后自动重新参与默认视图。

暂停的网站仍参与库存与历史统计，状态明确显示 Paused。暂停不等于没有库存，归档不等于移出分组。

没有 monitor 或当前 scope 尚未建立 baseline 的网站计入网站数量，显示“待建立基线”，不把缺少观测解释为真实零 URL。分组摘要显示已建立基线的网站数，例如 4/6；完全无有效基线时当前 URL 显示“—”，而不是权威的 0。

## 4. 数据模型和数据库约束

### competitor_group

| 字段 | 说明 |
|---|---|
| id | text 主键，沿用 newId，例如 grp_* |
| owner_user_id | 所属账号 owner，关联 user.id |
| name | trim 后 1–80 个字符；纯文本 |
| description | 可空，最多 2,000 个字符；纯文本 |
| membership_version | integer，默认 1，成员实际变化时增加 |
| created_at / updated_at | timestamptz |

同一个 owner 内使用唯一索引 `(owner_user_id, lower(btrim(name)))` 防止重名；不同 owner 可使用同名分组。大小写按数据库 lower 的规则比较；不额外合并名称内部空格。API 校验和冲突判断使用同一规则，不把不同形式的名字交给前端自行决定。

增加 `(id, owner_user_id)` unique constraint，供同账号复合外键引用。membership_version 只用于成员变化和分页失效判断，不是抓取范围版本。

### website

追加 nullable `competitor_group_id`，应用字段 `competitorGroupId`。历史网站默认为 null。

建立复合外键：

```text
website(competitor_group_id, userId)
    → competitor_group(id, owner_user_id)
```

数据库保证网站与分组属于同一 owner；仅有 groupId 的普通外键不能保证这一点。采用默认 MATCH SIMPLE，groupId=null 时原网站 owner 仍保持 NOT NULL。删除动作采用 NO ACTION；API 在同一个事务里先解除归属，再删除分组。不使用会误删网站的级联删除，也不把复合外键两列一起 SET NULL。

追加 website `(userId, competitor_group_id, id)` 索引；事件先评估现有 `url_event_history_idx(website_id, scope_version, observed_at, id)` 是否满足分组查询，不预先增加大型冗余索引。

PostgreSQL 对跨表一致性推荐使用外键等约束，而不是跨表 CHECK。[官方约束说明](https://www.postgresql.org/docs/current/ddl-constraints.html)

## 5. 权限与并发契约

读权限沿用 `accountOwnerColumnAccessible` 和 `websiteOwnerAccessible`：owner 和已有合法成员可见；不得因新增分组而引入新的成员、邀请或公开分享。

写权限沿用 `requireApiUserWithWriteOwner`：目标分组和所有网站必须属于当前有效 owner。客户端不能传 owner_user_id 修改所有权；owner 在服务端解析。用户属于多个账号时，沿用现有账号选择逻辑，不能偷偷选择某个账号。

分组列表可以返回所有可访问 owner 的分组，携带 ownerId 供 UI 区分；具体详情始终限定一个分组的 owner。归组选择器只提供当前写入 owner 下的分组，不能把不同账号的网站混合分组。

无登录返回 401；不存在或无权访问的资源返回 404；非法请求返回 400；重名、已变动的归属和失效分页返回 409，不泄露其他账号的存在。

分组成员变更使用短事务，在数据库中按 owner 取得统一事务级 advisory lock；分组创建、删除、批量换组和带分组建站复用同一个服务函数/锁规则。事务内重新验证归属、权限和资源状态，锁定受影响的网站行并统一按 ID 排序。不得在事务内发网络请求。

批量操作最多 100 个网站，去重并严格验证，每个网站携带 expectedGroupId。任意一个冲突或不属于有效账号则全量回滚。当前状态已经等于目标时幂等成功；否则 expectedGroupId 与数据库不符时返回 409，避免旧页面把另一个操作的结果覆盖。

成员实际变更时，源组和目标组 membership_version 分别增加一次；相同归属的重复提交不增加。批量删除分组的事务先解除网站归属再删组，不能出现网站仍引用已删除分组。与抓取并发时只改分组字段，不写 target、库存或事件；用真实 PostgreSQL 测试证明抓取事实不变。

## 6. 指标口径

| 指标 | 固定定义 |
|---|---|
| websiteCount | 当前成员、当前归档筛选下的网站数 |
| baselineWebsiteCount | 当前 scope 已有 baseline 的网站数 |
| currentUrlCount | 有 baseline 的成员网站、当前 scope、当前路径过滤下，active + pending_removed 的总和 |
| pendingRemovalCount | 同一范围内 pending_removed URL 数 |
| removedUrlCount | 同一范围内状态为 removed 的 URL 库存数，与时间窗口内的 removed 事件数区分 |
| added / removed / reappeared | 窗口内 url_event 按 kind 计数，三个数独立展示 |
| changesCount | added + removed + reappeared，用于网站活动排行 |
| pendingCandidates | 当前 scope 的有效 pending/adopted 批次数；沿用现有完整 Candidate 语义，不按路径裁剪缺失集合 |
| running / queued / paused / failed / awaiting baseline | 展示各状态网站数量和明细，不强行合成单个“全组健康”状态 |

时间窗口默认 24h，可切 7d；使用数据库生成的统一 asOf，窗口 `[asOf-window, asOf]`。按 UTC 比较、浏览器本地时间展示，不按“今天零点”计算。

事件按事件条数计，不按 distinct URL 去重；同一 URL 在窗口内移除再重新出现，分别计数。不同网站重复监控同一 URL 时按各自 website 事实计数，不宣称跨站全局唯一 URL 数。首次 baseline 仍零事件。

当前 scope 和当前 Include/Exclude 规则参与汇总，与现有单站摘要保持一致。旧 scope 不混入默认统计；改变过滤规则会改变历史查询视图，不改变底层事件。分组 Changes 顶部明确这个口径，历史 scope 的专门审计仍使用单站详情。

“最近一次站点扫描”可以取成员网站 lastSuccessAt 的最大值；不得命名为“全组已扫描”。失败或很久未成功的网站保留其库存，但显示扫描时间和错误，避免总数掩盖缺失观测。

所有金额、流量、关键词、搜索收录等都不从 sitemap 事件推导。新增 sitemap URL 不等于刚上线，从 sitemap 移除不等于网页下线。

## 7. 页面与操作

### 网站列表

保留 `/dashboard`。增加分组筛选、分组列、选中网站数量与“移动到分组 / 移出分组”。搜索与归档筛选继续生效；批量操作只针对明确选中的网站，默认不跨分页隐式全选。账号不一致的选择不能提交为同一次换组。

Add website 增加可选分组，缺省未分组；从分组详情点击添加网站时预选当前组。保存成功后沿用现有网站详情导航。

### 分组列表

新增 `/dashboard/groups`，顶部入口纳入桌面和移动导航。提供分组名称搜索、24h/7d、创建分组、Show archived。

表格列：分组名称、网站数/基线覆盖、当前 URLs、Added、Removed、Reappeared、待处理状态。点击进入详情。空分组显示“添加已有网站或新网站”；加载失败保留错误与重试入口。

### 分组详情

新增 `/dashboard/groups/[id]`。

顶部：名称、备注、编辑、删除分组、添加网站/归入已有网站；摘要展示网站数、基线覆盖、当前 URL 和三类变化。下方两个 Tabs：

- Websites：成员站点表，支持按变化数量降序和站点名称排序，显示 paused/archived/error、上次完整扫描、单站入口。
- Changes：合并成员事件，列为观察时间、网站、事件类型、URL；筛选 24h/7d、网站和 added/removed/reappeared；链接到单站详情。

删除确认文案直接说明：“删除这个分组？其中的 N 个网站将变为未分组，监控和历史保留。”需要标准界面确认以避免误操作，方案阶段不要求额外授权步骤。

网站详情标题附近显示当前分组，可更换或清空，提供返回分组入口。原有 URLs / Changes / Runs / Candidates / Settings 保持各自操作。

## 8. API 契约

| 接口 | 行为 |
|---|---|
| GET `/api/competitor-groups` | 可访问分组列表，q/limit/offset；返回 ownerId 与元数据 |
| POST `/api/competitor-groups` | 当前 owner 下创建，body `{name, description?}` |
| GET `/api/competitor-groups/:id` | 分组元数据 |
| PATCH `/api/competitor-groups/:id` | 修改 name/description，严格请求体 |
| DELETE `/api/competitor-groups/:id` | 同事务解除归属并删除组，返回 detachedWebsiteCount |
| POST `/api/competitor-groups/assign-websites` | `{groupId: string \| null, assignments:[{websiteId, expectedGroupId}]}`，统一单个/批量归组服务 |
| GET `/api/competitor-groups/overview` | 可访问组的批量摘要，window=24h/7d、includeArchived；返回 asOf |
| GET `/api/competitor-groups/:id/websites` | 成员网站和单站摘要，window/归档/分页/排序 |
| GET `/api/competitor-groups/:id/events` | 聚合 Changes，window/siteId/kind/limit/cursor |
| POST `/api/websites` | 在现有严格 domain body 上增加可选 competitorGroupId；省略仍未分组 |

普通分页默认 50、最多 100，offset 设合理上限；批量 assignment 最多 100。static route `overview`、`assign-websites` 与动态 `:id` 清晰区分。

Changes 使用 `(observed_at DESC, id DESC)` keyset，cursor 带组 ID、筛选参数、asOf 和 membership_version，以及参与查询的网站/current scope/filter version 指纹。组成员、范围或过滤配置改变后返回 CURSOR_STALE / 409，前端清空游标刷新，不继续混合旧视图。

客户端传来的 cursor 不是授权依据；每次请求仍验证用户、分组、siteId 与真实成员。不得把 cookie、SQL 或原始私有数据放在 cursor 内。可使用当前 auth secret 派生专用 HMAC key 签名，轮换时旧 cursor 自动失效。

keyset 和 asOf 减少新事件插入造成的重复或偏移，但不提供跨 HTTP 请求的数据库快照；并发提交、较晚落库的观测不能据此宣称稳定导出。第一版不做历史导出。

## 9. 查询与实现位置

新增 `src/lib/competitor-groups.ts` 承载归属事务，`src/lib/competitor-group-summary.ts` 承载批量统计。权限沿用既有 helpers，过滤复用 `pathFilterSql`。

分组摘要与网站数据在一次 SQL snapshot 中按组集合批量查询，inventory 和 events 分别预聚合后再 join，防止一对多连接导致重复计数。不要在浏览器逐个请求每个 target 的所有 URLs/Events，也不要每个分组各做一次 N+1 查询。

读取 summary 时把同一 asOf 传给 24h/7d 统计与响应；同一请求内 page/total 使用同一个 SQL snapshot，或短只读 REPEATABLE READ。不要保留跨分页请求的数据库事务。

新增组件：分组表、分组编辑对话框、GroupSelector、批量归组对话框、聚合 Changes 表。接入 `website-list-view.tsx`、`add-website-dialog.tsx`、网站详情、TopNav/MobileNav。复用现有样式与事件/状态显示组件。

## 10. 迁移和发布

当前仓库基线为 `64043a79216f86df3daad8876f9fb47573ee4b2d`，分支 `codex/pr7-cloudflare-runtime` 还有上一轮已部署但未 commit/push 的 Cloudflare/Supabase 改动。实施前先把这部分归档为明确可审查的代码基线，再开始竞品分组增量；不能从旧 main 开始丢掉私有 schema 和容器修复。

迁移必须追加，不改写既有九个 Drizzle 迁移。新增表和 website 字段均位于现有 `sitemap_radar`，现有网站保持未分组，业务事实无回填。生产新表还必须启用 RLS、授予专用 app role 所需 DML、撤销 PUBLIC/anon/authenticated/service_role 的直接访问，不能认为初次 prepare 脚本会替以后新表自动补齐授权。

数据库权限脚本仅作用于目标私有 schema；不要把生产专用角色写成普通本地环境的硬前提。Supabase 权限迁移文件按 CLI 生成实际时间戳，Drizzle DDL 从 schema 生成后审查。DDL 与授权在上线开放入口前全部检查完成。

发布前备份私有 schema。先上向后兼容的 nullable 字段/新表/权限，再发布新镜像。旧应用可继续忽略新字段；发现应用问题时回退镜像，保留向前兼容数据库变更，不通过 drop schema 回退。保留当前 Cloudflare Access 策略，验收从已授权浏览器执行，不能把 Access 302 当业务成功。

实施和上线继续按既有授权边界执行；此文档本身不触发生产迁移或部署。

## 11. 建议拆成三个实现 PR

实施阶段编号与 GitHub PR 号分开，实际编号在创建时确定。

1. **Groups A：模型、约束、权限和归属 API。** 建组/编辑/删除、单个和批量换组、建站预选；真实 PG 验证同 owner、并发事务和事实不变。
2. **Groups B：批量统计、聚合 Changes API。** 完成窗口、scope/filter/归档口径、游标和 SQL 查询计划验证。
3. **Groups C：页面和端到端验收。** 所有网站筛选、分组页、网站详情入口、移动布局、冲突/空态/加载错误，最后准备生产迁移与发布证据。

A/B 可以作为分开的审查单元，C 完成后形成可使用的完整功能。每个阶段提交可复现证据，不能仅做字段和占位页就报功能完成。

## 12. 验收标准

| 场景 | 预期 |
|---|---|
| 历史网站升级 | 全部未分组，库存/事件/Run hash 不变 |
| 同 owner 创建大小写重名组 | 409；跨 owner 同名允许 |
| 加入已有网站 | 当前成员过去 24h/7d 事件参与统计，不新增 Run/事件 |
| A 换 B，或移出 | 两组汇总变化；网站历史、scope/filter/基线/缺失证据不变 |
| 两个旧页面同时换组 | 一个成功，另一个冲突或同目标幂等；不静默覆盖 |
| 100 个网站批量归组中有一个非法 owner | 全量失败，无部分成功 |
| 删除有成员的分组 | 全部变未分组，继续保持原监控状态，业务历史保留 |
| 换组与删除同时发生 | 串行完成或明确冲突，无悬空归属 |
| 跨账号猜 ID、cursor 或 siteId | 404/非法 cursor；不返回名称、事件或统计 |
| 合法账号成员 / 多账号选择 | 既有可见性保留，写入限定当前有效 owner |
| active/pending_removed/removed 混合 | current 包含 pending，removed 库存与 removed 事件分开 |
| baseline / 多 scope / 路径过滤 | 首次零事件；默认不混旧 scope；过滤与单站一致 |
| paused / archived / 无 baseline | 暂停数据保留；归档默认排除；无基线不当权威零 |
| UTC 窗口边界、事件重复 URL | 边界一致；按事件条数计数，不误去重或连接放大 |
| 组成员/scope/filter 改变后继续分页 | 409 + 提示刷新；不混新旧查询范围 |
| 原有 98 项测试 | 全部继续通过；新测试集中在权限、聚合和并发契约 |
| 浏览器使用 | 创建→添加/归组→排行→查看变化→换组→删除闭环通过 |
| 生产权限 | app role 可用；未授权角色不能读新表；Data API 不暴露业务 schema |
| 新版备份恢复 | 包含新表、字段、外键和权限策略的恢复验证 |

查询性能用真实 PostgreSQL fixture 验证：建议至少 10 组、50 站、20 万条事件，并保留 EXPLAIN (ANALYZE, BUFFERS) 与请求时间。生产容量上限须在实际 Cloudflare basic / Supabase Free Nano 上另行确认，不能把本地 fixture 当远端容量承诺。

## 13. 可以按此默认开始的决策

第一版：一个网站最多一个分组；允许未分组；当前成员历史聚合；24h/7d；删除组解除归属；默认排除归档；复用账号权限；不增加全组批量抓取或自动归属识别。

这是新增能力的方案草案，不修改 P0 冻结规格。下一步实现从明确现有已部署代码基线和 Groups A 开始。
