# Worker DoH 接入与本地网络验收

本机系统 DNS 为监控域名返回 198.18.* fake-IP，原抓取器按公网地址校验拒绝，因此 Run 失败。本次为原生抓取器增加可选 DoH 解析；目标 HTTP/TLS 连接仍使用原来的公网 IP 校验、连接 pin、实际 peer 与证书校验。

## 配置与运行

`SITEMAP_DNS_RESOLVER=system` 是默认值，适用于正常解析的服务器。`SITEMAP_DNS_RESOLVER=cloudflare-doh` 使用固定 Cloudflare HTTPS DNS endpoint，同时查询 A/AAAA。未知配置会以 INVALID_DNS_RESOLVER 明确失败，不回退到其他解析器。

本地 ignored `.env` 已设置 cloudflare-doh。重启 Worker 生效；Worker 启动日志打印解析模式。Clash、系统 DNS、代理配置及其他 SaaS 项目没有修改。恢复原设置只需将本项目变量改回 system 并重启 Worker。

DoH 只查询地址，网站内容仍由安全的原生 fetcher 抓取。控制端点固定为 `https://cloudflare-dns.com/dns-query`，通过 HTTPS 验证证书；拒绝 HTTP redirect，不允许监控用户指定解析服务 URL。每次查询两种地址类型的总时限 8 秒，响应各最多 64 KiB / 128 条记录。两种地址族都必须得到成功响应；任一私网、fake-IP 或非法 IP 都拒绝。按最短记录 TTL（包含 CNAME）缓存，最长五分钟、最多 256 个 host；零 TTL 不缓存，失败不缓存。

外层 request/attempt/shutdown 的取消信号传播到两个 DNS HTTP 请求。查询失败以可重试 DNS_RESPONSE_ERROR / DNS_HTTP_ERROR / DNS_TIMEOUT 保存，HTTPS 429 等 Retry-After 交给已有 Run 退避处理；UNSAFE_ADDRESS 不重试。目标连接的 request/attempt 时限不变。

旧失败 Run 保留历史，不自动修改状态。用户点击 Run now 会提交新的 Run，使用新配置进行抓取。

## 验证

- `PR3_QUEUE_ACCEPTANCE=1 PR4_INVENTORY_ACCEPTANCE=1 npm test`：86 项测试全部通过，0 skipped；包含队列/库存 Postgres 回归与新增 DoH 安全测试。
- DoH 测试覆盖 IPv4/IPv6、TTL、混合私网答案、fake-IP、非法回复、响应预算、NXDOMAIN、不完整查询、HTTP redirect/Retry-After、无错误缓存、请求/attempt/独立 DNS 时限及实际私网 peer 拒绝。
- typecheck、production build 通过；lint 无 error，保留 8 条既有上游 warning。
- `sitemap:compatibility -- --doh` 改为使用与 Worker 相同的解析器，不再使用 curl 测试专用解析适配器。happy-horse.art 两次 complete，每次 198 URL；www.sitemaps.org 两次 complete，每次 84 URL。
- `scripts/doh-acceptance.ts` 通过真实 HTTP 注册 QA 账号、添加网站并手动提交任务，然后启动未注入 fetcher 的默认原生 Worker。happy-horse.art 两次 complete / succeeded，每次 198 URL，首次 adoption=baseline 且零事件，第二次 adoption=applied，库存为 198，基线 CAS 正常推进。
- 实际 Worker 验收的数据库保护固定为 127.0.0.1:55471 / sitemap_radar_pr1，本地 HTTP 端口 31072。验收目标暂停自动周期，只测试手动 Run；不触及其他项目或 Production。

证据：`docs/evidence/network-doh/`。DNS 模式变化不改变 URL scope、根来源、归一化或过滤策略，因此不增加 scopeVersion。

部署环境保留 system 默认值；如确需 DoH，可单独设置服务器环境变量。此修复不代替 PR 5 界面或 PR 6 的容量、备份恢复与部署验收。

官方接口说明：[Cloudflare DoH API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/)。
