# Cloudflare + Supabase 运行配置

目标域名 `sitemap.lipeiwei.com`，Cloudflare 账号 `b54b5ffc6bfe3178cf2e09d1bce9ab75`。
Supabase 组织 `pixsucmvxarljcxvunpq`，用户已创建项目 `common`（`ownplpujolitkipihvlr`），新加坡 / Free。
这些是资源标识，不是凭据。数据库当前有 10 个迁移、23 张私有表，全部启用 RLS；应用角色与 TLS 已验证。
Worker、两个容器应用、custom domain 和每分钟 Cron 已发布，云上功能验收记录单独保存。

## 代码与工具

应用仍使用 Node.js / PostgreSQL；Web 和抓取进程分别进入一个 `basic` 容器，上限各一个实例。
控制层位于 `ops/cloudflare`，固定 Wrangler 4.146.0 和独立 lockfile，不修改全局 CLI。
原本的本地 `.env` 和监听端口不变。

```sh
cd ops/cloudflare
npm ci
npm run typecheck
npm run dry-run
```

dry-run 会构建 amd64 Docker 镜像并验证 Worker 配置，不上传镜像、不部署、不注册域名。
普通 app TypeScript 配置排除 Cloudflare 控制层，由后者自己的配置检查；控制逻辑测试仍进入应用测试套件。

## 数据库与 schema

业务数据放在 `sitemap_radar`，包括 Better Auth 表、网站、target、队列、库存和变化历史。
使用 PostgreSQL 连接，不依赖 Supabase Auth 或 Data API。创建表单已关闭 Data API。
迁移脚本只处理项目内的私有 schema，不移动、覆盖或删除其他 schema 的表。

从 Supabase Connect 取得 **Session pooler / port 5432** 连接串，保存到私有文件（0600）。
管理连接使用 `postgres.<projectRef>`，密码中的符号要 URL encode，不在 shell 命令里展开连接串。
迁移前通过主机、用户名、端口和 database 检查项目身份。TLS 强制 `verify-full`。
Supabase pooler 使用私有 CA；根证书从目标项目 Database Settings 的 Download certificate 官方链接下载，
保存在 `ops/cloudflare/certs/supabase-prod-ca-2021.crt`，不是秘密。运行容器通过 `NODE_EXTRA_CA_CERTS` 加载。
本地迁移也需在启动 Node 前设置该变量；不关闭证书或主机名验证。

```sh
# 在仓库根目录执行。文件路径只包含路径，不包含连接密码。
NODE_EXTRA_CA_CERTS=ops/cloudflare/certs/supabase-prod-ca-2021.crt npm run db:prepare:supabase -- \
  --project-ref ownplpujolitkipihvlr \
  --env-file /absolute/private/admin.env \
  --output /absolute/private/runtime.env
```

脚本会初始化 schema 默认权限、在私有 schema 内执行仓库当前的 Drizzle 迁移、创建专用 `sitemap_radar_app` 登录角色，
授予业务 DML 权限并启用 RLS。RLS 仅允许服务端专用角色；账号和网站的所有权继续由现有 API 鉴权执行。
应用角色没有 schema CREATE 权限、没有超级用户或 BYPASSRLS 权限，也不能修改迁移记录。

生成的 runtime.env 含新的 app 连接和 auth secret，禁止提交 Git、写入日志或作为报告附件。
如果角色提交结果不确定，或提交后连通性验证失败，保留这个文件，再检查数据库状态；不要直接重跑或重置角色。
原管理文件只供迁移使用，不放到运行容器里。

以后新增迁移用管理连接运行 `npm run db:migrate:scoped`。脚本保存原迁移 hash，将生成 DDL 的 public 外键引用映射到私有 schema。
若历史 hash 或顺序不一致，事务回滚并报错。新增表上线前仍需补齐 app 权限和 RLS policy。
当前未修改原本 public 环境的 Drizzle 迁移文件，因此本地已有数据库可以继续使用原迁移命令。

## 启动、健康与恢复

公开请求只转发给稳定命名的 `web` Durable Object；外部使用 HTTPS，内部容器桥接使用 HTTP，
保持 canonical Host、X-Forwarded-Proto、路径、query、method、cookie、body，失败的 POST 不重放。
健康探针使用 `redirect: manual` 并仅接受 200 / ok=true；Workers 不支持 `redirect: error`。
首次访问先等待 Web `/api/health` 就绪；运行中的请求也检查 readiness。Web 空闲十分钟后可休眠。
抓取容器用稳定命名的 `crawler`，由每分钟 Cron 唤醒/检查，空闲超时十五分钟。首次 Web 访问还会通过独立 RPC 启动抓取 daemon，以覆盖新 Cron 配置的传播等待；抓取任务不在 HTTP 请求中执行。抓取进程仍每五秒轮询数据库。
因此初版后台容器通常常驻并持续计费；Cron 间隔不改变 target 自己的扫描周期和 Run retry availableAt。

抓取容器开启内部 `3001 /health` 端口，检查数据库 schema、tick、当前 lease 和 heartbeat。
该端口不在公开 Worker 路由中。连续三次失败才恢复容器，失败次数保存在 Durable Object storage，防止对象被回收后计数丢失。
恢复先 SIGTERM，等待二十秒后仍未退出才 destroy；队列按既有租约和重试契约恢复，不直接修改执行状态。

`RADAR_ENABLED=false` 时请求返回 503，Cron 不启动新容器；已运行容器最多等待空闲期限再停止。
没有有效的数据库连接、私有 schema 配置和 auth secret 时也不会启动计算实例。

## 发布与验收

先验证 Supabase app 连接返回 `current_schema() = sitemap_radar`、权限、RLS、完整迁移和健康检查。
将 **仅 DATABASE_URL 和 BETTER_AUTH_SECRET** 写入私有 secrets JSON，部署时使用 `--secrets-file`。
其他非秘密变量在 wrangler.jsonc 中；默认 RADAR_ENABLED=false，正式启动显式使用 `--var RADAR_ENABLED:true`。
使用项目内的 Wrangler 发布，注册 `sitemap.lipeiwei.com` custom domain。

```sh
npx wrangler deploy --secrets-file /absolute/private/secrets.json --var RADAR_ENABLED:true
```

只有 Worker 控制逻辑变化时，可以加 `--containers-rollout none`；应用代码或镜像依赖变化时必须完整发布镜像。

上线验收包括真实登录/建站/Run now、无人访问时定时抓取、进程停止后的恢复、同 Run retry、partial 抓取库存保护、
Candidate 操作、数据库 TLS 和角色权限、backup/restore、云上容量和容器规格验证。
本地压测不等于 Free Nano / Cloudflare basic 的容量证明。2026-10-02 云上已通过注册、登录、建站、定时 baseline 和 Run now：supermaker.ai 两次均观察到 1,735 URLs；另一个登录账号访问网站、库存、事件、Runs、Candidates 均被拒绝。私有 schema 的 22 张表已备份并恢复到隔离的本地 PostgreSQL 17，数据 hash 全部一致，未在生产库执行恢复。

尚未完成：长期 Cron 保活观察、云上故障注入、真实远端容量压测，以及云上 partial/Candidate 的完整场景。这些行为已有本地测试，不能据此宣称云上容量或全部故障场景已验收。新生产数据库不自动迁移本地账号和网站。

回退应用用已验证的旧镜像/Worker 版本，保持数据库迁移向前兼容；不要以删项目、drop schema 或重建数据库作为应用回退。

## 竞品分组正式发布记录（2026-10-02）

[生产验收证据](acceptance/competitor-groups/production.json)与[功能说明](competitor-groups.md)记录本次已执行的范围。
应用源代码为 `a99447ccfe7dedc62310cb865c656f3b8021aa77`；当前 Worker 为
`1a63b773-e10e-470f-bcbd-4db984056c72`，流量 100%。Web 与 Crawler 完整 rollout 已完成，
两者镜像 digest 均为 `sha256:401b925a4f455c64c96124d0a68dc86d7ca5c1ff013e74d8c01f1e8a9a147058`。
后续文档提交不改变这一已部署应用版本。

既有部署已经执行 Drizzle 0009 与独立权限迁移
`supabase/migrations/20261002094037_competitor_groups_access.sql`，不可盲目重复创建同名 policy。
迁移记录 9 → 10，表数 22 → 23；新表 RLS、app CRUD、跨 owner 外键与非应用角色隔离均通过。
迁移前抓取事实 hash 保持一致。Data API 本次在项目控制台确认仍为 disabled，客户端 TLS 证书校验通过。
迁移前 22 表和发布后 23 表备份均恢复到隔离的本地 PostgreSQL 17，数据与结构、RLS、权限比对通过，
应用角色真实读写通过；没有在生产数据库执行恢复。

发布时修复了一个启动阻塞：production prune 删除 TypeScript 后，Next.js 加载 `next.config.ts`
尝试联网安装编译器。配置改为 `next.config.mjs`，行为保持一致；实际 amd64 精简镜像在无网络、
无 TypeScript 条件下可响应。后续发布不要重新引入启动时必须安装的编译器依赖。
最终 Worker 已去除临时容器诊断，错误日志隐藏凭据和 URL。

认证后的生产 health 和 groups API 为 200。真实浏览器通过分组创建、备注修改、批量归组、
预选分组建站、暂停/归档统计；跨账号为 404，旧成员状态冲突为 409。
短时间离开应用页面时，后台 scheduled Run succeeded/complete；恢复既有 QA 站点后，
手动 Run 也 succeeded/complete，分别观察到 1,735 URLs。两条监控记录均是 supermaker.ai，
汇总 3,470 不表示两个不同站点的规模验收。QA 已暂停或归档，旧记录与库存保留。

本机 Docker 虚拟机空间不足曾导致备份恢复启动失败及本地 PostgreSQL 暂时不可写。
已仅清理本项目未使用的旧镜像引用和精确匹配的可回收 runtime 缓存，保留当前镜像与全部数据库卷，
本地 localhost:31072 health 恢复 200。备份恢复使用网络隔离的 tmpfs 临时数据库并在结束后销毁。

长期保活、云上故障注入/恢复、生产大规模压测及完整 partial/Candidate 场景仍为 NOT RUN。
本次短期 Cron 与真实小规模扫描证据不替代这些场景。

## 官方参考

- [Containers 生命周期与 amd64 要求](https://developers.cloudflare.com/containers/concepts/architecture/)
- [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [实例规格](https://developers.cloudflare.com/containers/platform/limits/)
- [计费](https://developers.cloudflare.com/containers/platform/pricing/)
- [Supabase PostgreSQL 连接模式](https://supabase.com/docs/guides/database/connecting-to-postgres)
