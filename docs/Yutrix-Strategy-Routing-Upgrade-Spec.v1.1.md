# Yutrix 策略路由升级说明 v1.1（可实施版）

| 项       | 内容                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------- |
| 文档版本 | 1.1                                                                                                  |
| 基线日期 | 2026-08-03                                                                                           |
| 仓库基线 | `main@9a604da`                                                                                       |
| 范围     | **仅策略路由（Strategy Routing），与 v1.0 §0 完全一致**                                              |
| 状态     | **方案与数据已就绪；尚未获得执行/代码修改授权**                                                      |
| 数据     | `docs/strategy-routing/strategy-routing-init-utterances.zh-en.v1.1.json`（450 条）                   |
| 信号规则 | `docs/strategy-routing/strategy-routing-signal-rules.zh-en.v1.1.json`                                |
| 验收语料 | `docs/strategy-routing/strategy-routing-eval-cases.zh-en.v1.1.json`（225 条记录 / 266 个可执行断言） |

---

## 0. 范围与硬约束（保持原计划，不扩展）

### 0.1 在范围内

1. 策略分类引擎（任务/场景判定、优先级、硬门）
2. 策略规则数据（utterances / 规则 JSON）与出厂种子
3. `strategyRoutingRules` 等与策略路由直接相关的数据结构
4. **管理员**配置「策略路由」时的 UI/UX（模板、节点、None、下拉按供应商分组）
5. 策略决策的可观测落库字段（仅路由决策相关，如 taskType / template / reasons）
6. 与策略路由直接相关的单测 / 回归样例

### 0.2 明确不在范围内（未经书面确认不得改）

- 网关鉴权、计费、限流、缓存、协议转换、漏斗负载均衡本身（除策略命中后的目标选择衔接外）
- Chat Logs / Dashboard / 用户侧任意页面
- 终端用户（Claude Code / Cursor / API 调用方）可见 UI
- 「从日志全量审计 / LLM 改进策略」产品化流程（可作为后续独立需求）
- 决策预览大面板（本版确定不做）
- 任何与策略路由无关的 bugfix、文案、重构

### 0.3 变更纪律

- PR / 提交信息标注：`scope: strategy-routing-only`。
- 发现必须改动范围外行为时停止实施并确认，不顺手修复。
- `ChatLogs`、`Dashboard`、`UserRoutes` 的渲染输出必须保持不变；仅为维持编译而做的类型拆分也必须有快照/回归证明。
- 本文评审和数据准备不代表授权执行。只有收到单独执行授权后才可修改运行时代码、数据库或部署状态。

---

## 1. 评估结论与 v1.0 修正

v1.0 的产品方向成立，但不能直接执行。以下问题已在本版形成唯一决策：

| 等级 | v1.0 问题                                                                                                                       | v1.1 决策                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| P0   | 初始化 JSON 是 `{_meta, utterances, counts}`，现加载器却读取根级 `RAW.vision`；直接替换会让全部六类词表为空                     | 改为根级扁平 v2 文件，元数据使用 `_meta` / `_counts`；旧 201 条文件保持不动，加载器按模式读取声明过的 task key |
| P0   | 文档把 `strategyRoutingRules` 写成 `LayerRules[]`；仓库实际是 `endpoint_routes.targets[i]` 表示漏斗层，每层内部才是平铺规则数组 | 保留 `targets[]` 为层级真源；每层规则仍是平铺数组，不引入第二套层结构                                          |
| P0   | 缺省 `coding` 会令旧版 `writing` 规则不可达；缺省 `media` 又会令 `code/debug` 不可达                                            | 旧路由以 `strategyRoutingTemplate = NULL` 进入内部 `legacy` 兼容模式，绝不自动改行为；新路由默认 `coding`      |
| P0   | 现 UI 把 General 同步为层顶级模型，清空 General 会令保存校验失败；无法实现“所有节点可 None”                                     | None 使用显式禁用规则；策略选择在发起上游请求前跨层解析。层顶级模型只保留旧数据兼容，不作为 v2 策略兜底        |
| P0   | 前后端共享的 `STRATEGY_TASKS` 同时驱动用户页；直接扩展会改变用户 UI                                                             | 拆分 `LEGACY_STRATEGY_TASKS` 与 `ADMIN_TEMPLATE_TASKS`；用户页继续固定六类、DOM 与交互不变                     |
| P1   | `long_context` 的“超阈值”未定义，且文字命中可能在容量尚足时切换                                                                 | 仅当 `estimatedTotalTokens > 1_000_000` 且当前候选模型容量不足时触发；阈值严格大于，容量未知时不预切           |
| P1   | Vision 文字关键字与真实图片硬门混用，代码中的 `image/png` 也可能误命中                                                          | 真实结构化图片是硬门；无图片时仅允许精确/受控 vision 话术软命中，禁止裸关键词硬切                              |
| P1   | None、无效模型、下一层、General 和 best-effort 的先后关系未闭合                                                                 | §6 给出单一纯函数算法；None 跳层不消耗请求/重试次数，best-effort 不得覆盖已解析的策略目标                      |
| P1   | 现 `routeValidator` 不完整校验层内策略规则，重复 taskType 还会被静默丢弃                                                        | 显式模板保存时严格拒绝未知类型、重复类型、无目标的启用规则及无最终 General 的配置                              |
| P1   | 只在模型真的切换时才有 `routingTrace`，无法审计“同模型、None、跳层”                                                             | 新增独立 `strategyRoutingTrace` JSON 字段，不改变 Chat Logs 的现有 `routingTrace` 渲染                         |
| P1   | §3、§9 的示例路径/测试名与仓库不一致，且仓库没有 `artifacts/`                                                                   | 本版列出真实触点；评审数据放入可版本化的 `docs/strategy-routing/`，实施时投影到运行时词表                      |
| P2   | media 是否一期启用、试跑是否实现、缺省模板等仍留待二选一                                                                        | 本版锁定：一期完整枚举和 media；不做试跑；新建路由默认 coding；background 仅保留内部能力                       |

当前基线专项测试：`strategyRouting.test.ts` 与 `strategyRoutingRegression.test.ts` 合计 501 项，v1.1 评审时全部通过。该结果只是现状基线，不代表升级实现已验证。

---

## 2. 目标与确定的产品形态

### 2.1 目标

在不引入 LLM/向量检索等智能路由算力依赖的前提下：

1. 出厂即可使用稳定的本地规则分类。
2. 管理员按业务模板配置各漏斗层的场景模型，任一场景可选 None。
3. 每次策略判断均结构化留痕，包括未切换、None 和跨层结果。
4. 旧路由部署后行为不变，只有管理员显式选择新模板后才进入 v2 行为。

非目标：训练分类模型、改变协议/计费/负载均衡、改变终端或用户侧 UI、建立日志学习闭环。

### 2.2 模板与节点

| 模板          | 可见业务节点                                            | 固定硬门                 | 说明                                         |
| ------------- | ------------------------------------------------------- | ------------------------ | -------------------------------------------- |
| `coding`      | `plan`, `code`, `debug`, `test`, `general`              | `vision`, `long_context` | 新路由默认                                   |
| `media`       | `topic`, `script`, `writing`, `rewrite`, `general`      | `vision`, `long_context` | 一期启用全部 media 场景                      |
| `general`     | `general`                                               | `vision`, `long_context` | 最简配置                                     |
| 内部 `legacy` | 原六类 `vision/debug/code/long_context/writing/general` | 沿用旧逻辑               | 仅用于未显式迁移的旧路由，不出现在新建选项中 |

`background` 加入服务端枚举和种子，但一期不显示管理员节点；只允许带可信内部用途标记的后台请求参与匹配，普通用户文本不能仅凭话术进入 `background`。未配置时回落 `general`。

### 2.3 本期锁定项

- 完整增加 `plan/test/topic/script/rewrite/background` 枚举，不做临时映射写回旧 taskType。
- media 模板一期可用。
- 不做“试跑一条”和大块决策预览。
- 漏斗层数继续沿用现状的 `1..N`，不新增三层上限；验收至少覆盖 L1/L2/L3。
- 新建路由默认 `coding`；旧路由不自动选择模板。

---

## 3. 现状模型与目标数据契约

### 3.1 层级真源

漏斗层继续由现有 `endpoint_routes.targets` JSON 数组表达：

```ts
type StrategyTemplate = "coding" | "media" | "general";

type RouteTargetLayer = {
  providerId: string; // legacy/base compatibility target
  providerProtocol: "openai" | "anthropic";
  modelId: string; // legacy/base compatibility target
  promptPolicyId?: string | null;
  bestEffort?: boolean;
  strategyRoutingEnabled?: boolean;
  strategyRoutingRules?: StrategyRoutingRule[];
};
```

不得把 `strategyRoutingRules` 再嵌套为 `LayerRules[]`。`targets[0]` 是 L1，`targets[1]` 是 L2，以此类推。

显式 v2 模板 route 的每个参与层都规范化为 `strategyRoutingEnabled:true`，route-level 同名字段只作旧结构镜像；固定模型 route 和混合 legacy 配置继续保持模板为空，不被本期自动转换。模板字段本身不绕过现有启用开关。

### 3.2 模板字段

在 `endpoint_routes` 增加：

```ts
strategyRoutingTemplate: "coding" | "media" | "general" | null;
```

- `NULL`：内部 `legacy` 模式，严格沿用旧六类行为。
- 新建路由：前端显式提交 `coding`；服务端 create API 在字段省略时同样写入 `coding`，显式提交 `null` 返回 400，禁止创建新的 legacy route。
- 编辑旧路由：显示“兼容模式”提示；只有管理员主动选择模板并保存时才写入非空值。
- update/patch API 省略字段时保留原值；旧 route 的显式 `null` 只表示保持 legacy，不可把已是 v2 的 route 直接改回 null，回滚须恢复迁移前完整快照。
- 不以启动迁移批量回填模板。

### 3.3 单层规则（判别联合）

```ts
type StrategyTaskType =
  | "vision"
  | "long_context"
  | "plan"
  | "code"
  | "debug"
  | "test"
  | "topic"
  | "script"
  | "writing"
  | "rewrite"
  | "background"
  | "general";

type StrategyRoutingRule =
  | {
      taskType: StrategyTaskType;
      enabled: false; // None
    }
  | {
      taskType: StrategyTaskType;
      enabled: true;
      providerId: string;
      providerProtocol: "openai" | "anthropic";
      modelId: string;
    };
```

约束：

1. `enabled:false` 是唯一 None 表示；目标字段若存在也必须在序列化时删除，避免旧值复活。
2. 缺失 key 与 `enabled:false` 在**运行时解析**上等价；管理员保存时应补齐当前模板的可见节点，便于审计。
3. 当前模板参与集合内的 `enabled:true` 必须具有可用供应商、可用模型和可解析协议。参与集合就是 §3.3 的对应固定顺序；其他模板的 hidden rules 只保留、不参与本次运行时、计数、mirror 或校验，切换到其模板保存时再完整校验。
4. 同层同一 `taskType` 最多一条。显式模板保存遇到重复/未知类型直接返回 400，不得 first-wins 静默修复。
5. 非当前模板的旧规则原样保留但运行时忽略，切换模板时可恢复；不得因隐藏列而丢数据。
6. 每个持久化层在当前模板参与集合内至少有一条启用规则；只有 hidden rules 启用仍视为全 None 空层并拒绝保存（应直接删除该层）。
7. 至少一个漏斗层必须配置启用的 `general`。否则拒绝保存。
8. 为满足旧表的非空约束，层顶级 `providerId/providerProtocol/modelId` 镜像为该层当前模板参与集合内启用的 General；若 General=None，则按下列固定顺序镜像第一条启用规则。hidden rules 不得成为 mirror。该镜像不得参与 v2 运行时兜底。

```text
coding: vision, long_context, plan, code, debug, test, background, general
media: vision, long_context, topic, script, writing, rewrite, background, general
general: vision, long_context, background, general
```

显式模板保存校验统一返回 HTTP 400，并使用以下稳定 reason code：新建 route 显式 null 模板 `strategy_template_null_forbidden`、重复任务 `strategy_duplicate_task_type`、未知任务 `strategy_unknown_task_type`、启用规则缺目标 `strategy_enabled_target_required`、全 None 层 `strategy_empty_layer`、全路由无 General `strategy_general_required`、prompt policy 与任一启用规则协议不兼容 `strategy_prompt_policy_protocol_mismatch`。供应商/模型不存在或停用继续使用现有 validator 的稳定错误封装。

同一 payload 有多个问题时按固定顺序返回首错：模板/schema → 未知或重复 task → 启用目标完整性/可用性 → 当前模板空层 → route General → prompt policy 协议。eval 的 `validation-all-none-layer` 因此必须返回 `strategy_empty_layer`，而不是后续的 General 错误。

### 3.4 旧数据兼容

- 旧 route-level `strategyRoutingRules`、`fallbackStrategyRoutingRules` 和 `targets[].strategyRoutingRules` 都继续可读。
- `strategyRoutingTemplate IS NULL` 时使用原六类解析、原 201 条 ruleset、原 General 兜底和原用户覆盖语义；不得加载 v2 新 seed，也不得套用 v2 仲裁优先级。
- 旧规则不做破坏性重写；v2 保存只更新被编辑的 route。
- 固定模型用户覆盖继续关闭策略路由，行为不变。
- 用户的六类策略覆盖继续使用原 UI。v2 场景按别名链落到共享六类后应用覆盖：`plan/test→code`，`topic/script/rewrite→writing`，其余同名；无对应项再用 `general`。该兼容只改服务端合并，不新增用户页面节点。

用户覆盖在 v2 中是位于管理员 L1 之前的单一合成层 `U0`，不写入 `targets[]`：

1. 有效固定模型覆盖仍最先返回并关闭策略路由，保持现状。
2. 六类策略覆盖的完整别名为：`vision→vision`、`long_context→long_context`、`debug→debug`、`plan/code/test→code`、`topic/script/writing/rewrite→writing`、`background/general→general`。
3. 普通/soft-vision 场景先尝试别名规则，再尝试 user `general`（去重）；hard gate 只允许同名 `vision` 或 `long_context`，不得用 user `general`。
4. U0 固定继承管理员 L1 的 `promptPolicyId`（可为 null），不得从 hidden layer 或其他层猜测；user 目标的 provider/model/protocol、可用性、容量及该最终 policy 在进入纯函数前解析到 `userOverrideSnapshot`。policy 与 user 协议不兼容时该槽视为失效；无规则或失效时记录原因并继续管理员 L1，不阻断请求。
5. U0 上游真正失败后设置 `userOverrideAttempted=true`，从管理员 L1 开始；管理员层失败后沿用 scene 从下一管理员层开始，任何回落都不得再次尝试 U0。
6. continuation 若来自 U0，只能在当前 `userOverrideSnapshot` 中同别名槽位、同 provider/protocol/model/prompt policy 仍有效时继承；否则按上述 U0→L1…LN 顺序重新解析。

---

## 4. 分类契约

### 4.1 输入与输出

分类纯函数必须接收：

```ts
type ClassificationInput = {
  text: string; // 仅当前真实用户轮
  currentUserTurnHasImage: boolean;
  outboundPayloadHasImage: boolean; // 能力硬门使用此字段
  estimatedTotalTokens: number; // 历史字段名；语义固定为本次 outbound input tokens
  requestedOutputTokens: number;
  activeContextKind: "max_input" | "total_context" | null;
  activeContextLimit: number | null;
  template: StrategyTemplate | "legacy";
  internalPurpose?: "background"; // 仅可信服务端上下文可设置
  isAgenticContinuation: boolean; // 仅可信服务端 turn detector 可设置
  previousDecision?: {
    template: StrategyTemplate;
    classifiedTaskType: StrategyTaskType;
    resolvedTaskType: StrategyTaskType;
    source: "user_override" | "admin_layer";
    layerIndex: number | null; // admin 为 0-based；user override 为 null
    providerId: string;
    providerProtocol: "openai" | "anthropic";
    modelId: string;
    promptPolicyId: string | null;
  } | null; // 仅同一可信会话可传入
};

type ClassificationResult = {
  taskType: StrategyTaskType;
  reasons: string[]; // 稳定 reason code，不写原始输入
  hardGate: "vision" | "long_context" | null; // 主硬门；vision 优先
  requiresLongContext: boolean; // 可与 hardGate=vision 同时为 true
  continuationTarget: {
    resolvedTaskType: StrategyTaskType;
    source: "user_override" | "admin_layer";
    layerIndex: number | null; // admin 为 0-based；user override 为 null
    providerId: string;
    providerProtocol: "openai" | "anthropic";
    modelId: string;
    promptPolicyId: string | null;
  } | null;
};
```

### 4.2 固定顺序

以下顺序只用于显式 `coding/media/general`。`legacy` 在入口即转到冻结的旧分类/解析分支，以行为等价为最高优先级；v2 的全局 long-context 硬门、NFKC 匹配和新 seed 均不反向影响旧 route。

```text
1. 真实图片硬门
2. 长上下文硬门
3. 可信 background（internalPurpose + background evidence）
4. continuation 继承（agentic continuation + 受控的自然语言短续接）
5. 按模板过滤候选集合
6. v2 seed + signal-rules evidence，按模板优先级决胜
7. general
```

模板内优先级：

```text
coding: vision(soft) > debug > plan > test > code > general
media:  vision(soft) > topic > script > rewrite > writing > general
general: vision(soft) > general
legacy: 使用独立旧分支，保持现有顺序和结果
```

`vision(soft)` 仅指 §4.3 的受控文字意图；真实图片仍在优先级表之前走硬门。只有 `internalPurpose === 'background'` 且 background seed/signal 命中时才在第 3 步直接输出 `background`；这一步必须先于现有 agentic continuation detector，避免内部标题/摘要被错误锁回上轮模型。`long_context` 文字规则只产生 reason；硬门未成立时不进入上述候选优先级。

自然语言短续接使用 signal-rules 文件 `_meta.continuationExactMatches` 的完整精确白名单；`isAgenticContinuation` 或规范化后的整句白名单命中时，仅在 `previousDecision.template === input.template` 下继承其 `resolvedTaskType`，把原 layer/target/prompt policy 写入 `continuationTarget`，分别记录 `agentic_continuation` / `natural_continuation`。没有可验证前序状态时归 `general`。包含新实质意图的长句（例如 “continue with the API implementation”）不在白名单内，仍走正常分类。continuation 两个输入都只能由服务端复用现有 detector 和会话/粘性路由查询填充，不接受客户端自由提交，不新增终端协议或 UI。

### 4.3 Vision 硬门

- `outboundPayloadHasImage === true` 必须返回 `vision`，不受模板影响；reason 用 `current_user_image` / `historical_payload_image` 区分来源。
- 同时满足图片和长上下文时输出 `hardGate='vision'` 且 `requiresLongContext=true`，跨层解析只能选择上下文足够的 vision 目标。
- 无结构化图片时，`image/png`、文件扩展名、代码字段 `image_url`、普通词 `image/logo` 不构成硬门。
- 无图片的文字型 vision 只允许种子精确命中或受控短别名命中，并记录 `vision_text_intent`；它是软分类，可按普通场景规则回落。

### 4.4 Long-context 硬门

仅当以下条件全部满足时触发：

```text
estimatedTotalTokens > 1_000_000
AND activeContextKind / activeContextLimit are known
AND (
  activeContextKind == 'max_input'
    ? estimatedTotalTokens + safetyMargin > activeContextLimit
    : estimatedTotalTokens + requestedOutputTokens + safetyMargin > activeContextLimit
)
```

条件成立时 `requiresLongContext=true`；无图片时主 `hardGate='long_context'`，有图片时主硬门仍为 vision。

- 恰好 `1_000_000` 不触发。
- 模型容量未知时不预切，沿用现有上游错误回落。
- “长日志/整份 RFC”等 utterance 只提供 reason，不得绕过 token 和容量门。
- 仅有 `long_context` 文字信号但硬门不成立时，保留 `long_context_text_intent` reason，并排除该类后继续完成模板内分类。
- `safetyMargin` 沿用现有值 50；本期不调整 token 算法。

### 4.5 话术匹配

v2 运行时数据文件为根级扁平 map，加载器必须显式枚举 task key，忽略 `_` 开头的元数据 key。规范化统一为：Unicode NFKC、转小写、连续空白折叠、首尾 trim。legacy 继续使用当前文件及当前 normalizer。

显式 v2 模板的文本 evidence **只**来自 v2 seed 的精确/受限 contains 匹配和 signal-rules 文件；不得复用 legacy content analyzer、早返回关键词或未入库的 ad-hoc regex。legacy analyzer 只留在 `template=NULL` 分支。后续新增分析规则必须先更新 machine-readable signal-rules、独立 eval 和版本/hash。

匹配规则：

1. 只分析规范化后前 8,000 个 UTF-16 code unit，与现有上限一致；截断时追加 `lexical_input_truncated` reason。
2. 所有分类支持规范化后的精确匹配。
3. `general` 只允许精确匹配；`vision` 只允许精确 seed 或受控 signal regex，不做 seed contains。
4. 其余类别的 CJK 包含匹配要求种子至少 7 个规范化 Unicode code point；英文要求至少 3 个 token，并按单词边界匹配。英文 token 在规范化后严格用 `/[a-z0-9_]+(?:['’-][a-z0-9_]+)*/g` 切分；signal-rules 自身仍按声明的 ECMAScript regex 执行。`long_context` contains 只加 reason，`background` contains 仍要求可信 internalPurpose。
5. 受控短别名继续由显式正则处理，不靠宽泛 contains。
6. 同一输入多类命中时按 §4.2，而不是 JSON 顺序。
7. 构建测试必须拒绝空串、控制字符、规范化后跨类重复、计数不符、未知分类和非字符串成员。

---

## 5. 模板场景回落链

```ts
const SCENE_FALLBACKS = {
  coding: {
    plan: ["plan", "code", "general"],
    code: ["code", "general"],
    debug: ["debug", "code", "general"],
    test: ["test", "code", "general"],
    background: ["background", "general"],
    general: ["general"],
  },
  media: {
    topic: ["topic", "writing", "general"],
    script: ["script", "writing", "general"],
    writing: ["writing", "general"],
    rewrite: ["rewrite", "writing", "general"],
    background: ["background", "general"],
    general: ["general"],
  },
  general: {
    background: ["background", "general"],
    general: ["general"],
  },
} as const;
```

硬门没有通用场景回落：`vision → ['vision']`，`long_context → ['long_context']`。这是能力约束，不得静默发送给不满足能力的 General。无真实图片的 `vision_text_intent` 是软分类，单独使用 `['vision', 'general']`。

---

## 6. None 与跨层解析（唯一算法）

### 6.1 纯函数

```text
resolveTarget({
  classification,
  layersSnapshot,
  userOverrideSnapshot = null,
  userOverrideAttempted = false,
  template,
  startLayerIndex = 0,
  estimatedTotalTokens,
  requestedOutputTokens
}):
  reasons = copy(classification.reasons)
  fallbackPath = []

  if classification.continuationTarget != null and classification.hardGate == null:
    if continuationTarget.source == 'user_override':
      eligible = !userOverrideAttempted and startLayerIndex == 0
      locate the same alias slot in userOverrideSnapshot
    else:
      eligible = continuationTarget.layerIndex != null
        and continuationTarget.layerIndex >= startLayerIndex
      at continuationTarget.layerIndex, locate the enabled current-template rule
        keyed by continuationTarget.resolvedTaskType
    if eligible and exact provider/protocol/model/promptPolicy matches
      and target is available and satisfies required context capacity:
        return selected(continuationTarget, inherited=true)
    record continuation_target_unavailable and continue with scene resolution

  candidateScenes = classification.hardGate
    ? [classification.hardGate]
    : classification.taskType == 'vision'
      ? ['vision', 'general']
      : SCENE_FALLBACKS[template][classification.taskType] ?? ['general']

  if !userOverrideAttempted and startLayerIndex == 0 and userOverrideSnapshot:
    userScenes = classification.hardGate
      ? [classification.hardGate]
      : distinct([USER_ALIAS[classification.taskType], 'general'])
    validate userScenes in order with the same availability/capacity rules
    if valid target found:
      if classification.taskType == 'vision' and selected scene == 'general':
        reasons += vision_text_intent_soft_fallback
      return selected(userTarget, source='user_override', layer=null, reasons, fallbackPath)

  for layerIndex from startLayerIndex to layersSnapshot.length - 1:
    for candidateScene in candidateScenes:
      rule = unique normalized rule for candidateScene in layersSnapshot[layerIndex]
      if rule is missing or enabled=false:
        record fallbackPath(layerIndex, candidateScene, none)
        continue
      if provider/model/protocol is invalid or unavailable:
        record validation_failed and continue
      if classification.requiresLongContext and target capacity is unknown:
        record capacity_unknown and continue
      if classification.requiresLongContext and target capacity is insufficient:
        record capacity_insufficient and continue
      if classification.taskType == 'vision' and candidateScene == 'general':
        reasons += vision_text_intent_soft_fallback
      return selected(rule, layerIndex, resolvedScene=candidateScene, reasons, fallbackPath)
    record layer_skipped_none

  return unavailable
```

`record` 必须逐候选追加 `fallbackPath`，不能用汇总 reason 代替；missing 与 `enabled=false` 都写 `outcome='none'`，invalid/unknown-capacity/insufficient/selected 分别写同名 outcome。`layer_skipped_none` 只可作为附加 reason，不能吞掉候选级 path。`ResolutionResult.reasons` 从 classification reasons 复制并追加 resolver reason；`fallbackPath` 和 `selected` 使用 §8 同一结构。soft vision 最终选到 General 时必须追加 `vision_text_intent_soft_fallback`，这正是 eval `resolve-017` 的断言口径。

`layersSnapshot` 和 `userOverrideSnapshot` 在调用纯函数前一次性生成，每条启用规则包含已经解析的 `targetAvailable`、`providerProtocol`、最终 `promptPolicyId` 和 `{contextKind, contextLimit}`；纯函数内不访问 DB/网络。这样 availability 与容量判断可复现，也不会在一次决策中读取到不同状态。

admin continuation 的精确目标必须位于 `layerIndex >= startLayerIndex`，并在该层、该 `resolvedTaskType` 的当前模板有效规则中启用；U0 continuation 则要求尚未尝试过 user override。两者的 provider/protocol/model/promptPolicy 四元组必须一致。低于 `startLayerIndex` 只表示不可再继承，不抛参数错误。不得仅因相同模型出现在隐藏场景、其他层或其他 task 而复活旧目标。配置已变更、目标停用或容量不足时记录 `continuation_target_unavailable`（trace 使用 previous source/layer），再按继承的 `resolvedTaskType` 执行常规回落链。

### 6.2 行为约束

- None 跳过的是策略槽位；找不到同层回落目标时直接检查下一层。
- None/无效槽位跳层不发上游请求，不占 `retryCount`，不消耗漏斗失败次数。
- 上游真正失败后，从下一层开始，沿用本轮已分类的 scene，不重新分类。
- U0 失败后的“下一层”是管理员 L1；管理员 Lx 失败后的下一层是 L(x+1)，并携带 `userOverrideAttempted=true`。
- 当前层存在有效策略目标时，`bestEffort` 不得覆盖它；best-effort 只在该层没有策略选择且走旧兼容路径时生效。
- 选中规则后使用该层的 `promptPolicyId`，使用规则自己的 provider/model/protocol。
- 保存时必须用该层当前模板参与集合内每一条 enabled rule 的最终 `providerProtocol` 校验 `promptPolicyId`；任一不兼容即 400，不能只校验层顶级镜像模型。hidden rules 在切换为其模板保存时校验。
- 普通场景在所有层均不可用属于保存校验漏网或运行时失效，返回现有错误封装下的稳定原因 `strategy_no_available_target`；不得偷偷落到 None 槽。
- vision 全层不可用返回稳定原因 `vision_unavailable`。需要长上下文时，已知容量均不足返回 `context_budget_insufficient`；没有足够目标且至少一个候选容量未知时返回 `context_budget_unknown`。这些情况都不得回落 General。
- 显式 v2 模板下，层顶级 `providerId/modelId` 只作为旧结构兼容字段，不参与上述兜底。

---

## 7. 管理员 UI（唯一允许的 UI 面）

只在现有管理员路由编辑弹窗/策略表内完成：

1. 模板选择：coding / media / general。
2. 旧路由若模板为空，显示兼容模式提示；不自动选择、不在无操作保存时迁移。
3. 表头固定显示两个硬门 + 当前模板业务节点。
4. 单元格弹层顶部固定 None，下面维持按供应商分组和搜索。
5. None 单元格显示明确的“None / 跳过本层”状态，不使用含糊的“清空”。
6. hidden task rules 保存时原样保留。
7. 至少一个层级 General 的前后端校验提示一致。
8. 不做试跑、不做决策预览、不改 UserRoutes / Chat Logs / Dashboard。

当前 `TargetCellPopover` 已具备供应商分组，实施重点是模板过滤、None 的判别联合以及不再把 General 清空同步成无效层顶级目标。

---

## 8. 决策可观测性

新增 `request_logs.strategyRoutingTrace` nullable text，内容是 JSON 数组；不复用会被 Chat Logs 直接渲染的 `routingTrace`。

```ts
type StrategyDecisionTraceEntry = {
  schemaVersion: 1;
  classifierVersion: string;
  rulesetVersion: string;
  template: StrategyTemplate | "legacy";
  classifiedTaskType: StrategyTaskType;
  hardGate: "vision" | "long_context" | null;
  requiresLongContext: boolean;
  reasons: string[];
  fallbackPath: Array<{
    source: "user_override" | "admin_layer";
    layer: number | null; // admin 1-based；user override 为 null
    taskType: StrategyTaskType;
    outcome:
      | "none"
      | "validation_failed"
      | "capacity_unknown"
      | "capacity_insufficient"
      | "continuation_target_unavailable"
      | "selected";
    providerId?: string;
    modelId?: string;
  }>;
  selected: {
    resolvedTaskType: StrategyTaskType;
    source: "user_override" | "admin_layer";
    layer: number | null;
    providerId: string;
    modelId: string;
  } | null;
  outcome: "selected" | "already_on_target" | "unavailable";
  createdAt: string;
};
```

要求：

- 同模型、None 跳层和不可用结果也记录。
- `reasons` 只用稳定 code；不写输入正文、密钥、Header 或完整异常。
- `fallbackPath` 按真实检查顺序记录每个 layer/scene 候选，能区分同层 `plan=None → code=invalid → general=selected`。
- 单条 `fallbackPath` 最多 `min((layers.length + 1) * 3, 32)` 项（`+1` 为 U0）；单请求 decision entry 最多 `layers.length + 2` 条，整体序列化上限 8KB，超出时保留首尾并记录 `trace_truncated`。
- 现 `routingTrace` 继续只表达模型 handoff；本期不改变其 UI。

---

## 9. 数据文件与质量门

### 9.1 出厂种子

权威评审文件：`docs/strategy-routing/strategy-routing-init-utterances.zh-en.v1.1.json`；获得实施授权后，将其受控复制为新的 `apps/server/src/services/strategyRouteUtterances.v2.json`。现有 `strategyRouteUtterances.json` 冻结为 legacy 201 条，不覆盖。

- 12 类、450 条，保留现网 201 条和用户提供 v1.0 的全部 368 条，并新增 82 条高信号中英文表达。
- 根级分类数组可由同类静态加载方式读取；`_meta` / `_counts` 只供审计，加载器不得遍历它们。
- `vision`/`long_context` 话术不覆盖硬门条件。
- `background` 普通请求默认不启用。

### 9.2 验收语料

`docs/strategy-routing/strategy-routing-eval-cases.zh-en.v1.1.json` 是带预期标签的回归输入，包含：

- 三模板正向分类及中英文样例。
- vision/long-context 边界。
- 代码里出现 image/error/write 等反例。
- 跨层 None、别名回落、无效模型和硬门不可降级案例。
- legacy 与用户六类覆盖兼容案例。

当前组成：142 个分类/边界 case、16 个双信号仲裁 case（展开为 32 个断言）、32 个 None/跨层/U0 解析 case、14 条回落矩阵记录（展开为 39 个断言）、10 个兼容 case、11 个保存/API 校验 case，共 225 条记录 / 266 个可执行断言；分类文本与 seed 精确零重合。

回落矩阵每条记录按文件 `_meta.fallbackMatrixExpansion` 确定性展开：所有记录生成直接命中和跨层命中；长度大于 1 的链再生成同层别名命中。测试工具不得自行发明其他排列。

种子文件不是测试预期的替代品；实现不得用“每条种子自测命中”代替反例和冲突测试。

### 9.3 组合信号规则

`docs/strategy-routing/strategy-routing-signal-rules.zh-en.v1.1.json` 给出独立文本未精确命中 seed 时的机器可读 ECMAScript regex、模板适用范围、排除条件、reason code 和仲裁优先级。实现必须按该文件契约编译规则并做非法 regex 的构建失败测试；不得另写一套未记录的关键词猜测。

### 9.4 必须自动化的校验

```text
JSON 可解析
声明的 12 类齐全且无未知类
_counts 与实际数组长度一致，总数 = 450
成员均为非空字符串，长度 2..160，无控制字符
NFKC + lowercase + whitespace 规范化后：类内/跨类均无重复
现网 201 条全部保留；legacy 文件内容及 SHA-256 不变
每个新增业务类至少 4 条中文和 4 条英文高信号样例
signal rule id 唯一，regex 全部可编译，task/template/reason 均为声明值
每个非 hard-gate、非 continuation、非 general-default 分类 fixture 至少命中一条 seed/signal evidence，按声明优先级仲裁后等于 expectedTaskType
eval 各数组 id 全局唯一，_counts 与记录/展开断言数一致，fallback 矩阵严格按声明语义展开
```

### 9.5 评审基线哈希

| 文件                                                           | SHA-256                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| legacy `apps/server/src/services/strategyRouteUtterances.json` | `8808f5d240be2fd66eb55b1344a8eb05757ea0d7732172393e437fac253afefb` |
| v1.1 seed                                                      | `f47980c0f3f41c5f5f8606a8673c84c228dd9e8d175fd3b893723d703645be91` |
| v1.1 signal rules                                              | `0d9632a414832ad97732a909bb9ea44664da3cca9cc44a986df40bd2462e5b89` |
| v1.1 eval                                                      | `792644f078d7c876535ce0a0c85da68051cce05dca4356729b67993575b3ad3a` |

实施 PR 必须从这些固定输入复制；CI 重算并逐项比较。legacy 的内容与哈希必须继续保持不变。

---

## 10. 实施包与真实代码触点

只有获得单独执行授权后，按以下顺序实施。每个包独立提交并保持测试全绿。

### WP0：基线与行为锁定

- 固定当前 501 项策略专项回归结果。
- 补 UserRoutes、Chat Logs 输出不变的回归/快照。
- 记录现有 legacy route、targets route、用户覆盖各一份 fixture。

### WP1：数据与分类（不接网关）

- 新增 v2 扁平 seed；legacy seed 文件保持字节级不变。
- 将评审 signal rules 受控复制为 `strategyRouteSignalRules.v2.json` 并按其契约编译。
- 扩展服务端枚举、加载器、模板过滤、优先级和硬门条件。
- 用验收语料覆盖纯函数；不得在本包改变实际目标选择。

预期触点：

- `apps/server/src/services/strategyRouteUtterances.v2.json`（新增）
- `apps/server/src/services/strategyRouteSignalRules.v2.json`（新增）
- `apps/server/src/services/strategyRouteUtterances.json`（只读兼容基线，不应产生 diff）
- `apps/server/src/services/strategyRouteUtterances.ts`
- `apps/server/src/services/strategyRouting.ts`
- `apps/server/tests/strategyRoutingRegression.test.ts`
- 可新增仅策略分类测试文件

### WP2：规则契约、迁移与严格校验

- 增加 nullable `strategyRoutingTemplate`。
- 实现 enabled 判别联合、严格保存校验、legacy 解析分支。
- 不批量更新既有 route。

预期触点：

- `apps/server/src/db/schema.ts`
- `apps/server/src/db/index.ts`
- `apps/server/src/startup/migrations.ts`
- `apps/server/drizzle/<next>_strategy_routing_template.sql` 及生成的 strategy-only metadata
- `apps/server/src/utils/routeValidator.ts`
- `apps/server/src/controllers/adminRouteController.ts`
- `apps/server/src/controllers/adminRouteMutateController.ts`

### WP3：跨层解析与用户覆盖兼容

- 新增并单测 `resolveTarget` 纯函数。
- 在首次上游调用前解析目标；失败回落沿用 scene，从下一层解析。
- 用户六类覆盖作为兼容 overlay，不改变用户 UI。
- 修正策略目标与 best-effort、prompt policy 的先后关系。

预期触点：

- `apps/server/src/services/strategyRouting.ts`
- `apps/server/src/routes/gateway/authorization.ts`
- `apps/server/src/routes/gateway/gatewayExecutor.ts`
- `apps/server/src/routes/gateway/fallback.ts`
- `apps/server/src/routes/gateway/types.ts`
- 仅策略/漏斗衔接测试

### WP4：管理员模板与 None

- 拆分 legacy 用户任务常量和管理员模板常量。
- 添加模板选择、兼容提示、模板列、None 行为和前端校验。
- 保证用户页 DOM/交互不变。

预期触点：

- `apps/web/src/components/Routes/RouteTargetsTable.tsx`
- `apps/web/src/components/Routes/strategyRoutingConfig.ts`
- `apps/web/src/components/Routes/types.ts`
- `apps/web/src/components/Routes/useRoutesState.ts`
- `apps/web/src/components/Routes/RouteDialog.tsx`
- `apps/web/src/components/Routes/RouteList.tsx`（仅管理员摘要）
- `apps/web/src/locales/en.json`
- `apps/web/src/locales/zh.json`

`UserStrategyEditor.tsx` / `UserRoutes.tsx` 不得发生功能 diff；若类型拆分确需改 import，必须证明渲染产物不变。

### WP5：审计字段

- 增加 `request_logs.strategyRoutingTrace` additive migration。
- 所有完成路径和错误路径持久化同一结构。
- 不改 Chat Logs 展示。

预期触点：

- `apps/server/src/db/schema.ts`
- `apps/server/src/db/index.ts`
- `apps/server/src/startup/migrations.ts`
- 新 Drizzle migration/metadata
- `apps/server/src/routes/gateway/types.ts`
- `apps/server/src/routes/gateway/logging.ts`
- `apps/server/src/services/requestLogService.ts`
- `apps/server/src/routes/gateway/gatewayHandlers.ts`
- `apps/server/src/routes/gateway/gatewayResponder.ts`
- `apps/server/src/routes/gateway/gatewayExecutor.ts`

### WP6：回归、灰度与文档

- 全部 server test、web build/lint、strategy 专项测试。
- 先在新建测试 route 启用；旧 route 仍为 legacy。
- 对精确率、None 跳层、不可用率做离线审计后再显式迁移现有 route。
- `README.md` 与 `README.zh-CN.md` 只更新策略路由小节。

若实际 diff 需要超出上述直接策略触点，停止并确认。

---

## 11. 测试矩阵与验收门

### 11.1 分类

- [ ] 三模板各业务场景至少 4 条中文 + 4 条英文正例。
- [ ] `arbitrationCases` 覆盖 coding/media 的相邻业务类，并以中英文各 1 条覆盖 soft-vision 与两模板业务类；每条先证明双 signal evidence，再断言优先级 winner。
- [ ] 代码块/路径内的 `image`, `error`, `write`, `script`, `test` 不误判。
- [ ] media 模板不输出 coding 专属类；coding 模板不输出 media 专属类。
- [ ] general 模板除硬门外只输出 general。
- [ ] 普通用户文本不输出 background。
- [ ] 带 agentic continuation 标记的可信内部标题/摘要仍输出 background；普通 agentic continuation 继承上一有效目标。

### 11.2 硬门边界

- [ ] 真实图片始终 vision。
- [ ] 图片 + 超长上下文选择“有 vision 能力且容量足够”的目标。
- [ ] 999,999 / 1,000,000 tokens 不触发 long_context。
- [ ] 1,000,001 tokens 但当前容量足够不触发。
- [ ] 1,000,001 tokens 且容量不足才触发。
- [ ] 容量未知不预切。
- [ ] 已触发 requiresLongContext 后，候选容量未知会跳过并最终返回 `context_budget_unknown`，不误选也不降 General。

### 11.3 None / 层级

- [ ] 每条 §5 回落链均有直接命中、同层别名回落、跨层回落。
- [ ] None 跳层不增加 attempt/retry 计数。
- [ ] disabled 规则的旧 provider/model 不会复活。
- [ ] 无效/停用模型跳过并留 trace。
- [ ] hard gate 不回落 General。
- [ ] best-effort 不覆盖已选策略目标。
- [ ] 上游失败后不重新分类，且从下一层开始。
- [ ] U0 别名缺失/失效时按 user General→管理员 L1 回落；hard gate 不使用 user General；U0 或管理员层失败后均不重复尝试已失败层。

### 11.4 兼容

- [ ] `strategyRoutingTemplate = NULL` 的旧 route 在升级前后分类和选模一致。
- [ ] legacy 201 条 ruleset 的 SHA-256 和逐条内容不变，且旧分支不加载 v2 seed。
- [ ] 旧六类 JSON、route-level rules、fallback rules、targets rules 均可加载。
- [ ] 旧 `writing` 规则在 legacy 模式仍可达。
- [ ] 固定用户覆盖行为不变。
- [ ] 六类用户策略覆盖可通过别名链覆盖 v2 场景，用户 UI 不新增节点。
- [ ] 管理员切换模板不会删除隐藏规则。
- [ ] create 省略模板写 coding、create 显式 null 拒绝、update 省略模板保留旧值。

### 11.5 数据与工程

- [ ] §9.4 校验全部通过。
- [ ] 现有 501 项策略专项回归全绿。
- [ ] server 全测通过。
- [ ] web build 和 lint 通过。
- [ ] 分类纯函数不访问网络或数据库；同进程预热后 10,000 次 8KB 输入基准满足 `p95 <= max(legacy_p95 * 1.2, 5ms)`。
- [ ] git diff 仅 §10 的策略直接触点。
- [ ] Chat Logs / Dashboard / UserRoutes 无功能或视觉变化。

### 11.6 Go / No-Go

全部满足才可灰度：

- P0/P1 测试为 0 failure。
- legacy fixture 100% 行为一致。
- 指标样本固定为 eval 中非 legacy 的 138 个 `classificationCases` 加 16 个 `arbitrationCases`（后者每条只按 winner 计 1 个分类样本），共 154 个；不得加入 seed 自测或删除失败样例。
- 其中 `expectedHardGate != null` 的 19 个 case 单独要求 gate type 与 task type 100%；其余样本按 template 分组，对该组实际出现的非 hard-gate label 计算 macro precision/recall/F1：precision ≥ 95%、recall ≥ 90%、F1 ≥ 92%，且每个业务类 recall ≥ 85%。legacy、resolution、matrix、compatibility、validation 断言不进入分类指标，但各自必须 100% 通过；不得用 general 大量吞样例来虚增指标。
- 不存在保存成功但运行时无 General 的 v2 route。
- rollback 演练完成。

---

## 12. 发布与回滚

### 12.1 发布

1. 先部署 additive schema 与 legacy-compatible reader，所有旧 route 保持 `NULL`。
2. 部署分类与解析代码，但只对显式 template route 生效。
3. 创建专用测试 route 分别启用 coding/media/general。
4. 通过 §11 后，由管理员逐 route 显式迁移；不做批量自动回填。

### 12.2 回滚

- 代码回滚到上一版本；legacy utterance JSON 从未被覆盖，新增 v2 文件由旧代码自然忽略。
- 新增 nullable 列保留即可，旧代码忽略；不执行破坏性 DROP COLUMN。
- 因旧 route 未自动改写，无需数据逆迁移。
- 已显式选择模板的 route 在变更前导出 `id/template/targets/legacy rules` 备份；代码回滚时恢复其原规则快照。

### 12.3 观测触发条件

灰度期间出现以下任一情况立即停止继续迁移：

- vision 硬门错放到非 vision 目标。
- None 跳层发出多余上游请求。
- legacy route 选模与升级前不同。
- `strategy_no_available_target` 在通过保存校验的健康配置中出现。
- Chat Logs / UserRoutes 出现非预期 UI 变化。

---

## 13. 实施前最终检查

- [x] 范围未扩展。
- [x] media、缺省模板、试跑、background 均已锁定，无二选一。
- [x] 数据结构与当前 `targets[]` / flat rules 对齐。
- [x] None、General、跨层、hard gate、best-effort 顺序唯一。
- [x] legacy 与用户六类覆盖有明确兼容路径。
- [x] 种子与独立验收语料已定义。
- [x] 发布、回滚和 Go/No-Go 可执行。
- [ ] 尚待用户单独授权运行时代码/数据库实施。
