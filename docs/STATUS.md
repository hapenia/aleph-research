# 状态

## 结论

迁移已完成主体功能，运行在 `dsh-superagent` 组合上，旧插件已归档到
`archive/legacy-plugin`。真实案例的首个工单与 24 小时无人值守验证仍在进行，
它们是最终验收项；能力现状见下。

## 已完成

- **Phase 0 组合基线**：vendored 原型、独立 profile、常驻主 Session、重启后
  同一 Session 恢复。
- **Phase 1 Source 与执行**：`aleph` Source（Thread、request/result/timer/note
  Trigger、Policy、Channel）、prepare 生成工单仓库与数据副本、`AGENTS.md` 约定、
  bwrap 读取隔离、`aleph_submit_result` 端到端评分回链。
- **Phase 2 评测与预算**：Host 权威评测、结果日志与 best 追踪、预算分层准入
  （训练/设计需人工确认，小时上限）。
- **Phase 3 Watchdog**：常驻 Watchdog Session，停滞简报、停止与重试工具、变化
  驱动唤醒。
- **Phase 4 面板与热修改**：AlephResearch Web 面板、版本化配置与回滚、扩展代码
  热重载、`/aleph/api/reload`。
- **工程化**：所有变更走分支、PR、CI 与 squash merge；`main` 受保护。

## 验证证据

| 项 | 证据 |
| --- | --- |
| 组合基线 | `docs/superagent-migration.md` Phase 0；重启后同一主 Session |
| 评测提交链路 | 独立验证 lab `team-verify-2144`：score 80、提交 SHA、Channel 记录、0 激活告警 |
| 读取隔离 | lab `confinement-report`：`/home` 与源数据不可见，工单仓库与 git 提交正常 |
| 预算准入 | lab `budget-test`：训练请求 202、分析请求自动接单、上限 0 后转人工 |
| 热配置 | lab `cfg-test`：保存 v1 生效、保存 v2、回滚到 v1 |
| 热重载 | lab `reload-test4`：模块版本 /1 → /2 → /1，路由持续可用 |
| Watchdog | lab `wd-test8`：`aleph-watchdog` 会话、简报、状态无变化时跳过唤醒 |
| smoke 性能 | 264.9s → 163.8s（见 PR #59） |

## 测试

`cd superagent-extension && npm test`：108 项测试，覆盖 Source、评测、提交流程、
预算、Watchdog、结果追踪、配置存储、热配置、准入与热重载辅助函数。
`scripts/verify.sh` 另检查脚本语法与扩展模块语法。

## 待完成

- 真实案例从工单到评分的完整闭环与多轮改进。
- 24 小时无人值守 soak（脚本已就绪：`scripts/superagent-soak.sh`）。
- 文档、CHANGELOG 与版本号的最终收尾。
