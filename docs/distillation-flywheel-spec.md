# Yutrix 蒸馏飞轮 — SDD v1.0

| 项 | 内容 |
|---|---|
| 状态 | 已实施 |
| 方法 | SDD + TDD + E2E + Robustness |

## 1. 目标

从 LLM 审计日志逐条学习，**单一入口、每条一次 LLM**，同时产出：

1. **路由飞轮** — 抽象 signal/weight/boundary 提案 → **一键使用**（热加载）
2. **员工 Skill** — 按成员抽象工程习惯 → **一键下载** ZIP

硬约束：不写业务 case；Skill 用法不在 Yutrix 范围。

## 2. API 契约

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/admin/distillation/settings` | 飞轮设置 |
| PATCH | `/api/admin/distillation/settings` | 更新设置 |
| GET | `/api/admin/distillation/jobs` | 作业列表 |
| POST | `/api/admin/distillation/jobs` | 创建作业 |
| GET | `/api/admin/distillation/jobs/:id` | 作业详情+进度 |
| POST | `/api/admin/distillation/jobs/:id/cancel` | 取消 |
| GET | `/api/admin/distillation/proposals` | 路由提案 |
| POST | `/api/admin/distillation/proposals/validate` | 预校验 regression |
| POST | `/api/admin/distillation/proposals/apply` | 一键使用 |
| POST | `/api/admin/distillation/routing/rollback` | 回滚路由版本 |
| GET | `/api/admin/distillation/skills` | Skill 包列表 |
| GET | `/api/admin/distillation/skills/:userId` | 成员 Skill 详情 |
| GET | `/api/admin/distillation/skills/:userId/download` | 一键下载 ZIP |

## 3. 数据模型

- `distillation_jobs` — 作业
- `distillation_job_items` — 逐条 record 状态
- `distillation_routing_proposals` — 路由提案
- `distillation_signal_versions` — 已发布 signal 版本链
- `distillation_skill_packages` — 员工 Skill 版本
- `distillation_learned_records` — record 学习标记

## 4. Worker

- 后台 async loop，不阻塞网关
- 并发上限可配置（默认 2）
- Cron：`distillationCronEnabled` + `distillationCron`（默认 `0 3 * * *`）

## 5. 输出校验

禁止：路径、URL、@、具体产品名模式、verbatim 用户原文。
允许：抽象 signal 调整、trait/heuristic/workflow 模板。

## 6. 测试

- Unit: `apps/server/tests/distillation*.test.ts`
- E2E: `docs/distillation-flywheel-e2e.js`
