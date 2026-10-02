# Sitemap Radar Web / Worker 运行配置

推荐入口为 Dockerfile + compose.runtime.yml：Web 与 Worker 使用同一镜像，分别运行；迁移是一次性服务，成功后才启动两个常驻服务。配置已经在独立本地数据库验收，不代表已经部署线上。

## 配置与启动

将 ops/runtime.env.example 复制到仓库外的私有路径，填入 DATABASE_URL、至少 32 字符的随机 BETTER_AUTH_SECRET、实际访问的 BETTER_AUTH_URL / NEXT_PUBLIC_APP_URL，权限设为 0600。镜像构建不需要这些秘密，.dockerignore 排除 .env 和验收证据。镜像以 node 用户运行，入口拒绝缺失/占位认证配置。

```sh
export RADAR_ENV_FILE=/absolute/private/radar.env
export RADAR_WEB_PORT=3000
docker compose -f compose.runtime.yml config --quiet
docker compose -f compose.runtime.yml build
docker compose -f compose.runtime.yml up -d
docker compose -f compose.runtime.yml ps
docker compose -f compose.runtime.yml logs --timestamps --tail=100 web worker
```

Web 默认仅发布 127.0.0.1:3000，正式环境使用提供 HTTPS 的反向代理。数据库由外部提供，不会沿用开发 Compose 的固定密码，也不在运行模板中新增或暴露数据库。新版本迁移应先完成备份恢复演练；只在启动新 Web/Worker 前执行一次迁移。本轮没有新增迁移。

默认 DNS 为 system；当前本机使用 cloudflare-doh。两种方式都保留公网地址、重定向、连接 IP 和 TLS 校验。换正式服务器后重新验证实际 resolver 与真实抓取。

每个 Worker 同时处理一个 Run；多 Worker 通过数据库 claim/lease 并发，不改变单 target 活动 Run 唯一约束：

```sh
docker compose -f compose.runtime.yml up -d --scale worker=4
```

## 连接预算与资源

Web 默认 DB_POOL_MAX=10，Worker 默认 2，独立 Worker 健康探针临时使用 1。模板可通过 RADAR_WEB_POOL_MAX / RADAR_WORKER_POOL_MAX 调整，边界为每进程 1–50。多个 Web/Worker 实例的预算要相加；例如 1 Web + 4 Worker，常驻池和同时执行的探针上限为 10 + 4×2 + 4×1 = 22，另给迁移、备份、管理连接及其他应用保留余量。Web 健康检查复用 Web 池。

连接等待默认 5s，空闲连接默认 30s；不会无期限等待新连接。队列事务仍使用既有 5s lock_timeout、10s statement_timeout；没有为了压测放宽事务、租约或单次 attempt 的十分钟上限。

模板暂设每个服务 1GiB 内存上限。容量报告中的 RSS 包括单进程测试程序、合成 XML 和四个并发执行循环，不是线上单 Worker 的独立测量；正式环境需要观察各容器内存、CPU、数据库 I/O 和队列等待，决定服务器规格。100 个站点和单站 20 万 URL 是已测样本，不能推导为任意站点规模的 SLA。

## 健康、日志与退出

- GET /api/health：验证数据库连接、P0 表、关键唯一索引和运行字段；无法连接或 schema 不完整返回 503。它不代表 Worker 或公网抓取健康。
- Worker 探针：npm run worker:health。WORKER_HEALTH_FILE 必须是进程独享的私有文件；容器内固定为 /tmp/sitemap-worker-health.json，不使用共享卷。检查进程存在、数据库/schema、最近完整 tick；有活动 Run 时检查数据库真实租约、heartbeat 和 attempt wall-time。临时文件通过 rename 原子替换，权限 0600。停止中的 Worker 不会报告健康。
- Worker 输出结构化 JSON，包含 started/tick/stopped、workerId、runId、attempt、outcome。错误日志不打印 DSN、秘密或原始数据库异常。容器日志每服务最多 3×10MB。
- SIGTERM/SIGINT 中止抓取并将同一个 Run 按既有策略写回 queued + availableAt；默认退出等待 15s，超过则退出失败，数据库租约恢复负责不确定结果。Worker 的 Compose 退出宽限为 25s。
- SIGKILL/进程退出由 unless-stopped 重启；手动 stop 的服务保持停止。仅变为 unhealthy 的容器不会因为 restart policy 自动重启，必须配置告警/人工处理或平台的健康故障处理。不要把健康标志当作持续完成抓取的证明。

Compose 的启动依赖与重启语义依据 [Docker 启动顺序](https://docs.docker.com/compose/how-tos/startup-order/) 和 [Docker 重启策略](https://docs.docker.com/engine/containers/start-containers-automatically/)。

## 备份、停止与回滚

保留数据库一致性备份，包含 auth、队列、库存、事件、Candidate 和迁移记录；备份文件私有保存。完整本地恢复证据见 pr6-live-backup-acceptance.md。正式环境还需确定保存周期、离机副本、角色/授权、独立密钥及恢复时间目标。

```sh
docker compose -f compose.runtime.yml stop worker
docker compose -f compose.runtime.yml stop web
```

若需要回滚，停止新 Worker/Web，确认数据库迁移兼容后选择先前已固定的 RADAR_IMAGE，再启动。使用不可变标签/镜像摘要，不以可变 local 标签作为正式回滚凭据。schema 不兼容时按经过演练的备份流程恢复到新库再切换。不要运行开发 db:reset 或 DROP 原库来回滚。

## Railway 入口

railway.json 已改为仅启动 Web，避免把后台 Worker 的死亡隐藏在仍健康的 Web 服务后面。Worker 需要独立服务，使用 ops/railway-worker.json 的配置路径，两者共享正确数据库与认证环境。先完成迁移再启动 Worker；Worker 没有 HTTP healthcheckPath，可通过平台监控/运行 worker:health 做独立探测。这是配置模板，本轮没有 Railway 部署验收；当前建议使用已实际测试的 Docker Compose 方案。

正式部署仍需确定服务器、域名、HTTPS、数据库身份与备份目标，并审查合并 PR。本轮保持原本 localhost:31072 的网页及原 Worker 运行，不切换它们的构建或进程。
