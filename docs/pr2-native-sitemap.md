# PR 2：原生 sitemap 抓取引擎

本阶段基于 PR 1 分支实施，遵循 [冻结契约](p0-contract-v1.md)。交付 HTTP/解析/来源图引擎及独立 CLI。应用里的 Run now、cron 和 Worker 继续由 PR 3 接入持久化任务后开放；当前不能把网站 UI 当作已完成的监控系统。

## 引擎接口

`crawlSitemaps({ siteUrl, roots?, allowedPageHosts?, state?, limits?, signal? })` 返回本轮完整性、来源图、诊断和可序列化 checkpoint。库路径为 `src/lib/sitemap/index.ts`。

- `complete`：`urls` 为去重、排序后的完整集合，包括合法空集合。只有这种结果能交给 PR 4 的采纳流程。
- `partial/unusable`：`urls=null`。`observedUrlCount` 仅供诊断，禁止用它或成功分片构造库存。
- `sources`：所有实际访问来源及 parents、状态、finalUrl、revisionId；未展开的超限来源通过 issues 报告，不能宣称来源图完整。
- `retiredSources`：只在整张图 complete 时计算。任一其他根或父节点仍引用的来源不会退出。
- `state`：固定根、当前完整图的 liveSources、条件请求缓存和 revisions。失败扫描可以保存成功来源的缓存；liveSources 保持上一次完整图。
- `scopeFingerprint`：site origin、页面 host、normalization policy 和根集合的摘要。它不能代替数据库 scopeVersion、Run identity 或 baseline CAS。

根可手动配置，也可由 robots.txt 的多个 Sitemap directive 发现。robots 缺失或正常但未声明时探测 `/sitemap.xml` 和 `/sitemap_index.xml`。探测到一个有效根、另一个却失败时，不建立更小的完整基线。发现完成后根固定，后续失败不会重新发现并缩小根集合。根或页面 host 改变时返回 `SCOPE_CHANGE_REQUIRED`，调用方必须显式建立新 scope。

默认页面范围是网站 host 及其 www 对应 host；跨 host 的 sitemap 来源允许抓取，但它列出的范围外页面单独计数，不进入库存。范围外 URL 也计入 200,000 条资源上限。URL normalization 保留 path 大小写、末尾 slash 和 query 顺序，去掉 fragment，并使用 WHATWG URL 的 host/default port 标准化。未加入 include/exclude 过滤，避免影响完整库存。

## 抓取、缓存与安全

使用 Node 原生 HTTP/HTTPS。逐跳解析 DNS，拒绝任何非公网答案，包括 public/private 混合答案；连接到已经校验的 IP，并在发送 HTTP 请求前核实实际 peer。HTTPS 使用原 host 的 SNI、证书及 hostname 校验，不关闭 TLS 验证。没有 proxy、私网白名单或 fake-IP 绕过开关。

每个文件 HTTP 请求独立超时 30 秒，整个 attempt 最多 10 分钟。默认冻结预算保持不变，调用方只能降低。gzip 逐块解压，单文件与累计预算在缓冲完整 XML 前检查；HTTP gzip 加 gzip 文件可解两层，各解压层的输出均计入累计预算，普通 XML 计一次。错误 gzip、DTD/实体、HTML、损坏 XML、资源超限分别返回错误码。XML 接受标准 namespace 和常见的无 namespace 格式，支持 CDATA、转义及扩展元数据，每文件最多 50,000 个 loc。

ETag/Last-Modified 只发送到缓存所记录的 finalUrl。304 只能复用具有有效内容摘要的 revision；缺失、损坏或 finalUrl 不匹配则失败，不能当作空 sitemap。index 返回 304 后仍访问 children。revisions 没有按年龄清理逻辑，长期 304 的缓存可以继续使用；PR 4 接入引用驱动 GC。

网络失败、请求/attempt 超时、429/5xx 携带 retryable 诊断，Retry-After 被保留。引擎不执行 HTTP 层重试或 sleep，PR 3 负责同 Run 的 attempt 与退避。

## 本地使用

```sh
npm run sitemap:scan -- --site https://example.com \
  --state work/example-state.json --output work/example-run.json

npm run sitemap:scan -- --site https://example.com \
  --root https://example.com/sitemap.xml \
  --root https://static.example.com/index.xml \
  --host example.com --host www.example.com \
  --state work/manual-state.json --output work/manual-run.json
```

CLI 不依赖数据库或付费 API key。`--state` 可选，提供后读取并原子替换 checkpoint；`--output` 保存去掉 checkpoint 的本轮报告。退出码 complete=0、partial/unusable=1、参数/配置错误=2。两个输出路径必须不同。CLI 不是并发任务系统，同一 checkpoint 的并发使用要等 PR 3 的租约与持久化接入。

真实站点验收脚本：

```sh
npm run sitemap:compatibility -- --doh \
  --site https://happy-horse.art --site https://kling3.io \
  --site https://www.sitemaps.org \
  --output work/compatibility.json
```

`--doh` 仅为验收 harness 注入 Cloudflare DoH 的 A 记录解析，需要 curl；抓取使用同一安全连接实现，继续校验公网 IP、实际 peer 和 TLS。省略它使用系统 DNS。生产 CLI 和引擎默认没有这个 DNS 替换。当前本机系统 DNS 返回 `198.18.x.x`，默认路径正确拒绝；未修改主机网络设置。部署环境应提供真实公网解析。

## 验收与边界

自动化 fixtures 覆盖 XML/HTML/DTD/编码/50,001 entries、单/双层 gzip、损坏/炸弹、DAG/共享子来源、304 children 更新、缺失/损坏缓存、长期 304、部分失败保护、退休来源、分片移动、固定根、scope 变更、循环/深度/文件/URL/字节/时间上限、取消、DNS 混合答案、私网重定向、实际 peer 私网及公网不匹配、条件请求 hop 隔离、Retry-After 和挂起请求。

最终本地检查：37 项测试通过（原有 14 项 + 新增 23 项）、typecheck 与 production build 通过；lint 0 error，8 条既有 warning。日志分别见 [tests](evidence/pr2/tests.txt)、[typecheck](evidence/pr2/typecheck.txt)、[lint](evidence/pr2/lint.txt)、[build](evidence/pr2/build.txt)。复审另覆盖网络中断 gzip 的分类：连接中断可重试，内容损坏的 gzip 不按网络故障重试。

2026-10-02 实际兼容性：

| 站点 | 首次 / 第二次 URL | 完整性 | 真实 304 |
|---|---:|---|---:|
| happy-horse.art | 198 / 198 | 两次 complete | 0 |
| kling3.io | 429 / 429 | 两次 complete | 0 |
| www.sitemaps.org | 84 / 84 | 两次 complete | 0 |

上述是 live HTTP/TLS/gzip 兼容性与缓存状态重用验收，使用独立公共 DNS。真实站点没有返回 304；304 和 index 递归故障证据来自自动化 fixtures。详细时间、来源、计数和 URL 集合摘要见 [live-public-dns.json](evidence/pr2/live-public-dns.json)，系统 DNS 拒绝证据见 [live-system-dns.json](evidence/pr2/live-system-dns.json)。没有真实变更事件或部署验收。

依赖只新增固定版本 `saxes@6.0.0`、`ipaddr.js@2.5.0` 及 saxes 的 xmlchars；既有依赖未升级。解析依据 [Sitemaps protocol](https://www.sitemaps.org/protocol.html)，传输使用 [Node HTTP](https://nodejs.org/api/http.html) 与 [zlib](https://nodejs.org/api/zlib.html)。认证、网站/target 接口、数据库 schema 和 migrations 没有改动。

PR 3 应持久化根、来源缓存/revision 和 Run 诊断，创建持久化任务并传入租约丢失时的 AbortSignal；PR 4 负责 scope inventory、Candidate、原子采纳与 GC。`complete` 是采纳的必要条件，不能绕过 lease、scope 或 baseline CAS。
