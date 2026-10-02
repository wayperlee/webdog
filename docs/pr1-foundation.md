# PR 1：上游复现与功能收口

日期：2026-10-02。Fork：[wayperlee/webdog](https://github.com/wayperlee/webdog)。上游固定 commit：`426158f543fbaf591f7248f1be62ebfa8b4d695c`。本地分支：`codex/pr1-foundation`。

## 已交付

- 使用固定上游的 package-lock.json，依赖版本未升级。
- 注册、登录和 Dashboard 不再进入 Context.dev key onboarding；旧 onboarding URL 登录后重定向到 Dashboard。
- 建站不调用 SDK、品牌、截图或外部 HTTP；网站与唯一初始 sitemap target 在一个事务中保存。默认周期 6 小时，外部通知和 AI 关闭。
- 禁止 initialPagePath 自动创建正文 target；target POST/PATCH 严格限制 sitemap 类型、周期与启停，不接受旧 AI/通知字段。
- 单站 sitemap target 的创建通过网站行锁串行化；PR 3 再落正式唯一索引。
- 网站/target 永久删除返回 405，旧同步 cron 返回 503。原生抓取/队列尚未实施，不把它包装成可用监控。
- middleware 的固定 allowlist 关闭公开分享、旧 token、邀请/成员变更、通知配置/测试与 AI 配置等入口。现有账号 ownership 与账号选择逻辑保留。
- Legacy SDK、scraper 函数自身拒绝执行；worker/worker:once 明确退出 CHECKS_NOT_AVAILABLE。
- 去掉上游绑定的 analytics script；主 UI 只暴露账号、网站和 sitemap 配置。旧 Alerts 导航已隐藏，旧 Alerts URL 登录后重定向到 Dashboard；旧页面保存在 src/legacy，SDK/组件/认证表保留，不作大规模物理清理。
- 冻结 P0 契约和后续 PR 边界。没有实施 crawler、queue、inventory、Candidate、archive/restore 或新 schema。
- LICENSE、认证配置、schema 和原迁移未改变。
- grid/list 状态统一为 Checks unavailable，隐藏旧 N new / all clear，不改变旧 Alert.read 或历史记录。

## 检查结果

| 检查 | 上游 | PR 1 |
|---|---|---|
| npm ci | 通过 | 通过 |
| lint | 通过，10 条 warning | 通过，8 条来自保留的上游代码的 warning |
| typecheck | 通过 | 通过 |
| test | 12/12 | 14/14 |
| build | 通过 | 通过 |
| Drizzle migrate，独立 PostgreSQL 16 | 通过 | 沿用原迁移 |
| 浏览器注册/登录/建站 | 通过；首次有 key onboarding，可两步跳过 | 通过；直接进入 Dashboard |
| API 集成验收 | 不对上游执行禁用能力断言 | 9 组通过，含零 target 的 5 个并发首次创建、15 个旧入口、权限隔离和完整记录内容不变 |
| 配置非空占位 key 后调用 legacy 函数 | 未执行 | 两个入口均被 guard 拒绝 |

详细结果在 [evidence/pr1](evidence/pr1)。warning 没有当作新增错误或人为忽略。

浏览器使用 ego-browser，实际完成注册、粘贴完整页面 URL 建站、退出和重新登录。界面显示 Website saved / Sitemap checks are not available yet；建站只产生 SITEMAP_LINKS target。修复后使用有旧未读历史与从未检查两类 fixture 验证 grid/list，状态均为 Checks unavailable；浏览前后完整历史摘要一致。

## 本地验收环境

独立 Docker 容器 codex-sitemap-radar-pr1；PostgreSQL 16；仅监听 127.0.0.1:55471；数据库 sitemap_radar_pr1；Web 31072。上游基线使用 Web 31071，验收后已停止；PR 1 的最新 production build 在本地 31072 运行供预览。未连接现有产品数据库或 Production。QA 创建了隔离数据库中的测试账号、网站及历史 fixture。

实际 .env 被 Git 忽略，包含随机本地 Better Auth secret。所有 Context.dev/AI/邮件 provider keys 为空。node_modules 是该项目自己的安装，不依赖 scratch 目录的 symlink。

若使用已准备的 QA 环境：

```sh
docker start codex-sitemap-radar-pr1
npm run dev -- --hostname 127.0.0.1 --port 31072
```

另一个终端：

```sh
npx tsx scripts/pr1-acceptance.ts
```

脚本只接受 localhost/127.0.0.1 和数据库名 sitemap_radar_pr1；它创建本地测试记录。不要改成 Production 地址执行。

如使用全新开发环境：按 .env.example 配置自己的本地数据库和 Better Auth origin，执行 npm ci、npm run db:migrate 和 npm run dev。当前 worker 明确关闭；不要按照旧 README 把 PR 1 当作完整监控部署。

## 服务端入口清单

- auth、health：保留。
- websites GET/POST、website GET：保留鉴权。
- target POST/PATCH：仅 sitemap 与基本配置。
- website/target DELETE：405。
- website PATCH（旧通知路由）：405。
- cron/run：503；PR 3 替换为 enqueueRun。
- share 页面和 API、invite 页面和 API、成员变更、AI/provider key、通知配置与发送测试：404。
- account/active：保留既有 owner 选择权限校验。
- 旧 /dashboard/alerts：登录后重定向到 /dashboard，桌面与移动导航均隐藏。
- 未明确开放的新 API 默认 404。

## 验收边界

本轮验证的是本地 PR 1 底座。未执行真实 sitemap 变化检测、持久化任务恢复、Candidate、容量压测、Preview/Production 部署或真实 provider 内容验证。它们由后续 PR 负责。

本检查点已完成 PR 1 实现与本地验收；提交至 codex/pr1-foundation 分支供 GitHub PR review。实际远程 PR 与 commit 标识见交付记录。未部署、未合并，原生检查由 PR 2/3 实施。

复审记录：[pr1-review-resolution.md](pr1-review-resolution.md)。
