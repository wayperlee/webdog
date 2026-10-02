# 主 Issue 草稿：Sitemap Radar P0

目标：基于固定 webdog 上游，实现单站 sitemap 变化监控。权威规格：[p0-contract-v1.md](p0-contract-v1.md)。

## 交付阶段

- [x] PR 1：本地上游复现、主流程解耦、旧入口收口和基线证据。
- [ ] PR 2：原生安全 fetch、发现、XML/index/gzip、304 缓存、完整来源图。
- [ ] PR 3：持久化任务、execution_status 唯一约束、availableAt、leaseToken、重试及恢复。
- [ ] PR 4：scope inventory、逐 URL 缺失证据、Candidate、原子采纳/CAS、引用驱动 GC。
- [ ] PR 5：网站列表、详情 Tabs、筛选、错误恢复、暂停与归档/恢复。
- [ ] PR 6：部署、备份恢复、容量与真实站点兼容性验收。

PR 1 的完成勾选指本地代码与验证，不代表 GitHub PR 已创建或已合并。

## Definition of Done

1. 无 Context.dev/AI/邮件 key 可完成账号及监控主流程。
2. 首次完整扫描不产生新增事件；全量事件可分页查询。
3. partial/资源超限不能污染库存；来源退出与分片移动判断正确。
4. 同 target 一个活动任务；旧租约、旧范围和旧基线结果不能提交。
5. 缺失二次独立完整观察且至少间隔一小时；retry 不计新观察。
6. pending 严格集合确认、adopted 逐 URL 推进、混合恢复统计一致。
7. 源缓存长期 304 与历史事件在 GC 后仍可使用。
8. 通过 fixture 异常矩阵，再做真实站点兼容性和部署验收。

暂不扩大到竞品 Team、正文/价格、AI、截图、通知、收费或浏览器绕过。
