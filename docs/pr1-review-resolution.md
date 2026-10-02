# PR 1 修复与复审结果

日期：2026-10-02。分支：codex/pr1-foundation。固定上游：426158f543fbaf591f7248f1be62ebfa8b4d695c。

此前 1 项 P2 和 2 项验收补强已处理；本轮复审未发现新的阻塞问题。

- 网站 grid/list 均显示 Checks unavailable，旧 N new / all clear 已隐藏。保留数据库历史，不修改旧 Alert.read。
- 对零 target 的旧网站同时发起 5 个首次创建请求，结果为一个 201、四个 400；数据库最终只有一个 SITEMAP_LINKS target。
- 验收在同一数据库快照内按稳定顺序读取当前 QA owner 的网站、target、snapshot、alert、通知目的地、邀请、成员和设置完整记录，并比较 SHA-256 摘要。错误输出只含数量和摘要。
- 以 payload、read、publicShareToken 三类单独修改作为负向对照：数量保持不变，内容摘要均变化。每次在 finally 中 ROLLBACK，随后确认原摘要恢复。
- 使用 ego-browser 对既有未读历史与从未检查两类网站验证 grid/list；两种视图都没有旧通知或健康 badge。浏览前后网站、target、snapshot 和 alert 的完整摘要一致。
- 所有 API 和数据库 fixture 仅在 localhost:31072 与隔离数据库 sitemap_radar_pr1 中执行；没有生产或外部 provider 调用。

本轮 lint（0 error、8 条保留的上游 warning）、typecheck、14 个单元测试、build、9 组 API 验收与 git diff --check 均通过。Browser TaskSpace 已完成关闭。

截图：[grid](evidence/pr1/status-grid.png)、[list](evidence/pr1/status-list.png)。机器可读验收：[api-acceptance.json](evidence/pr1/api-acceptance.json)、[browser-acceptance.json](evidence/pr1/browser-acceptance.json)。

PR 1 仅是基础检查点，抓取引擎、持久化队列、库存和 Candidate 尚未实现。认证配置、数据库 schema、原迁移、package-lock.json 和 LICENSE 保持上游版本；未部署、未合并。
