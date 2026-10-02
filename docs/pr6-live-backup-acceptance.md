# PR 6a：真实站点与本地备份恢复验收

日期：2026-10-02。基于 `codex/pr5-dashboard-ui`。本次完成此前建议优先执行的两项：真实站点连续检查，以及独立数据库恢复验证。实施阶段 PR 6 尚未全部完成；容量、进程守护/运行配置、合并和线上部署仍未执行。

## 真实抓取与调度

`pr6-live-acceptance.ts` 使用严格限定的本地 QA 数据库与 http://localhost:31072，在新建专用账号下创建两站点。由正在运行的默认生产代码 Worker 处理真实公网请求，使用 cloudflare-doh，保留公网地址、连接 IP 和 TLS 校验，没有 mock fetcher、付费 API 或人工修改 retry 时间。

- supermaker.ai：两次完整手动扫描，当前 1,735 URL。首次建立基线，零事件；第二次正常采纳。另一次由常驻 daemon 的 scheduler 创建的 scheduled Run 也完整成功。
- happy-horse.art：两次完整手动扫描，198 URL，基线零事件。故意把 **QA 目标** 的根改为随机不存在的 XML 路径，真实收到 HTTP 404；该 scope 库存为空，原 scope 1 的 198 条仍可读。恢复自动发现后，scope 3 完整成功，建立零事件新基线，lastError 清除。
- 手动检查不改变 cadence。定时验证只将新 QA 目标的 nextCheckDueAt 调为到期，实际由默认 daemon 调度，完成后 nextCheckDueAt 推进到固定 6h 周期的未来时间；未声称等待完整六小时。
- 真实网络期间另一次 happy-horse 请求发生 NETWORK_ERROR；同一 Run 保持 queued + availableAt，实际等待 **304,191ms** 后 attempt 2 完整成功。客户端验收脚本已经超时退出，持久化任务仍继续完成。没有加速退避或伪造网络成功。
- ego-browser 专用账号验证列表的 1,735/198、失败 Run 的 HTTP 404、恢复后的 198、历史范围 1/2/3，以及 supermaker 的三条完整 Run 中可见 scheduled。

初版验收脚本对 result.urls=null 的统计缺少保护，随后修复 CASE；初版三分钟等待也短于五分钟退避，现等待上限为十五分钟、允许 1–4 attempt。`live-initial-timeout.txt` 与 `live-retry.json` 保留实际等待和恢复证据。十五分钟验收等待不是整个 Run 生命周期上限；更长退避仍按冻结策略执行，脚本超时不取消后台任务。失败试验账号的历史保留，不删除已有数据。

用户原来的 supermaker.ai 目标保持 enabled=true、scope 1、当前 1,735，未修改它的设置。新 QA 目标验收后均暂停；用户 Web 与 Worker 未被停止。

## 快照备份与恢复

`pr6-backup-restore.ts` 只接受 127.0.0.1:55471/sitemap_radar_pr1、postgres 用户、PostgreSQL 16，并核对 `codex-sitemap-radar-pr1` 容器端口映射。使用容器内 pg_dump/pg_restore 16.15；密码和连接串不传到 shell 命令行或日志。

1. 在 REPEATABLE READ READ ONLY 事务导出 snapshot，pg_dump --snapshot 与逐表原始行摘要使用同一快照。源站点继续运行，备份一致性不依赖停机。
2. 保存 PostgreSQL custom archive 到 Git 仓库之外的 private 目录（0700），文件 0600。备份包含认证资料，不复制到 Git、报告输出目录或公共附件。
3. 新建随机 `radar_restore_<uuid>` 数据库，以 template0 和单事务 pg_restore 恢复；只清理本脚本创建的数据库，永不 DROP 源库。
4. 对所有应用/迁移表，按 PostgreSQL 规范化 JSON 文本排序，以 cursor 每批 100 行计算完整 SHA-256 和行数；没有截断 URL、事件、账号、session 或 Run。共 **22 张表、12,747 条记录**逐表一致。
5. 核对字段、默认值、索引与约束定义。发现 pg_dump/restore 把 crawl_run_attempt_check 的 `(A AND B) AND C` 展开为 `A AND B AND C`，仅对这一条确切、等价的纯比较表达式规范化。其他定义仍严格比较；新增测试确认修改上界、下界、AND→OR 或 lease 条件不能被忽略。恢复库实际 UPDATE 的 attempt=5、attempt=-1、attempt=2/lease_epoch=1 均被同一 CHECK 拒绝。
6. 将同一个已构建 Web 应用启动在 **仅绑定 127.0.0.1 的临时端口**，DATABASE_URL 只指向恢复库。原 QA 账号密码可以登录，原两站 scope 1 库存数量正确；再在恢复库注册新账号、建站并提交队列，默认真实 crawler 完成 1,735 URL 的零事件基线。源库中不存在这个恢复试验账号，证明写入没有回到源库。
7. 停止临时 Web、关闭连接、删除本脚本创建的恢复库；保留已验证备份。恢复快照中若含 queued/running Run，先验证精确内容，再只在临时恢复库归档相关目标，防止冒烟检查执行复制来的任务。源库不受影响；本次复制的 active Run 数为 0。

最终备份为 **834,745 bytes**。本地 pg_restore 315ms，完整备份/核对/登录/真实抓取验证约 4.3s；这是小规模本地样本，不是生产 RTO/RPO 承诺。备份摘要、逐表行数及摘要在 `evidence/pr6/backup-restore.json`，原始数据路径不进入公共报告。

验证覆盖此本地数据库的数据与应用 schema。`--no-owner --no-acl` 不备份集群角色/授权；当前使用本地 postgres 角色，未验证未来线上受限角色、外部存储或独立密钥的恢复。线上备份策略需随正式部署环境补齐。

## 本地检查

- typecheck、lint 通过；lint 0 errors，8 条既有上游 warning。
- `PR3_QUEUE_ACCEPTANCE=1 PR4_INVENTORY_ACCEPTANCE=1 npm test`：89/89 通过，0 skipped。
- 没有修改应用运行行为、DB schema 或迁移；沿用 PR 5 已运行的构建，本轮不重复构建。
- GitHub 仓库未配置 CI；以上均为本地证据。

证据：[evidence/pr6](evidence/pr6)，截图为真实网络抓取的 QA 站点，不是 XML fixture。

## 复现

先确保专用本地 Web/daemon 正在运行，.env 已配置此 QA DATABASE_URL 和 cloudflare-doh。路径必须为绝对路径，private 文件留在仓库之外。

```sh
PR6_AUTH_FILE=/absolute/private/pr6-auth.json \
PR6_LIVE_OUTPUT=/absolute/evidence/live.json \
npx tsx scripts/pr6-live-acceptance.ts

PR6_AUTH_FILE=/absolute/private/pr6-auth.json \
PR6_BACKUP_DIR=/absolute/private/backups \
PR6_BACKUP_OUTPUT=/absolute/evidence/backup-restore.json \
npx tsx scripts/pr6-backup-restore.ts
```

脚本会新增自己的 QA 账号及站点，实际访问公网。完成浏览器/恢复检查后删除临时 auth 文件，保留已验证且权限正确的备份。不要把该本地专用脚本直接指向线上数据库；它会拒绝不匹配的地址。本次没有合并 PR、部署线上或触碰其他 SaaS 数据库。
