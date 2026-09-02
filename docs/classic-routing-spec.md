# 经典路由（Classic Routing）— SDD

## 1. 背景

现有路由模式：
- **策略路由**：每层 6 列任务矩阵（vision/debug/code/long_context/writing/general）
- **OPC 智能体路由**：每层 6 列 Agent 阶段矩阵

普通用户与简单场景更需要 **经典路由**：每层只选一个模型，L1→L2→L3 漏斗降级不变，无意图分类。

## 2. 目标

| 需求 | 说明 |
|------|------|
| 第三 Tab | 策略 / OPC 之外增加「经典路由」 |
| 单层单模型 | 每层仅 `providerId` + `modelId`，`strategyRoutingEnabled=false` |
| 降级不变 | 网关仍按 targets 顺序漏斗降级 |
| 新建默认 | 新建路由 `routingMode=classic` |
| 普通用户 | 用户路由页仅提供默认/固定/客户端覆盖，隐藏策略矩阵 |

## 3. 数据模型

```typescript
routingMode: "classic" | "strategy"

// classic 每层 target
{
  providerId: string
  modelId: string
  providerProtocol: "openai" | "anthropic"
  strategyRoutingEnabled: false
  strategyRoutingRules: []   // 可选空数组，不参与决策
  bestEffort?: boolean
  promptPolicyId?: string | null
}
```

- DB `endpoint_routes.routingMode` 存量默认 `"strategy"` 不变；新建由 API/前端写入 `"classic"`。
- 存量 `opc_agent` **向下兼容**：读取/展示/网关均视为 `classic`；编辑保存后持久化为 `classic`。
- 经典模式 **禁止** 用户提交 `strategyRoutingRules` override。

## 4. 网关行为

```
resolveRouteRoutingMode(route) === "classic"
  → strategyRoutingEnabledForLayer() 恒为 false
  → resolveStrategyRoutingDecision() 返回 null
  → 使用当前层 providerId/modelId
  → 失败/超时仍按 targets 索引降级
  → 不触发 long_context 列内跳转（无策略矩阵）
```

开闭原则：`RoutingMode` 扩展在 `opcAgentRouting.ts`；UI 通过 `tasksForRoutingMode` / `ROUTING_MODES` 注册。OPC 路由已移除，存量 `opc_agent` 自动映射为经典路由。

## 5. API

- `POST /api/admin/routes`：`routingMode` 缺省 → `"classic"`
- `PATCH /api/admin/routes/:id`：未传则保留原值
- `GET /api/user/routes`：返回 `routingMode` 供前端隐藏策略覆盖

## 6. UI/UX

- Admin：`RouteTargetsTable` 经典模式显示「优先级 | 模型 | 操作」三列
- 模式 Tab 顺序：经典 | 策略 | OPC
- User：经典路由显示「经典路由」标签；覆盖模式无「自定义策略映射」

## 7. 测试策略

- **TDD**：`classicRouting.test.ts` — mode 解析、层 enablement、校验、用户 override 拒绝
- **E2E**：`docs/classic-routing-e2e.js` — 创建 classic 路由并断言 targets 结构
- **Robustness**：模式切换时 seed 模型不丢失；非法 routingMode 回退 strategy

## 8. 验收

- Vitest 通过
- 中文 PDF：`docs/classic-routing-验收报告.pdf`
