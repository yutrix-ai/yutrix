# Yutrix（驭算）

<p align="center">
  <img src="./apps/web/public/favicon.svg" width="120" alt="Yutrix Logo" />
</p>

[English README](./README.md)

Yutrix（驭算，前身为 PromptGate）是一个轻量级 LLM 协议网关与管理控制台，用于在自有域名下统一管理 API Key、供应商、路由、提示词策略、并发控制、降级转发、Token 统计与实时日志。

Yutrix 专注于 LLM 协议网关本身：统一入口、统一鉴权、统一路由、统一日志和统一降级，而不是试图重新发明一个完整的模型平台。

- 根据 Host / 二级域名分流；
- 根据 Path 和协议识别 OpenAI / Anthropic 请求；
- 校验 Yutrix API Key；
- 替换上游供应商 API Key；
- 改写请求中的 `model`；
- 处理并发排队；
- 注入提示词策略；
- 执行用户/用户组最大输入 Token 限制；
- 记录 Token、耗时、用户、路由、供应商、模型等日志；
- 在上游限流或主供应商并发满时，按规则切换到备用供应商。

Yutrix 的核心抽象是：

```text
API Key 代表用户身份
Host 代表访问入口
Path + 路由协议代表请求形态
供应商出口能力决定最终转发协议
modelId 只是写入请求体的模型字符串
```

也就是说，Yutrix 是 **协议网关**，不是“Anthropic 模型 / OpenAI 模型”的类型网关。

---

## 目录

* [核心特性](#核心特性)
* [核心概念](#核心概念)
* [架构说明](#架构说明)
* [技术栈](#技术栈)
* [快速开始](#快速开始)
* [生产部署](#生产部署)
* [Caddy 反向代理](#caddy-反向代理)
* [环境变量](#环境变量)
* [首次启动](#首次启动)
* [升级指南](#升级指南)
* [路由管理](#路由管理)
* [供应商管理](#供应商管理)
* [API Key 管理](#api-key-管理)
* [用户组与路由授权](#用户组与路由授权)
* [用户/用户组输入 Token 限制](#用户用户组输入-token-限制)
* [提示词策略](#提示词策略)
* [并发、限流与降级](#并发限流与降级)
* [策略路由](#策略路由)
* [maxOutputTokens 说明](#maxoutputtokens-说明)
* [实时日志](#实时日志)
* [智能会话合并](#智能会话合并)
* [Token Usage Quality Score (TUQS 2.0)](#token-usage-quality-score-tuqs-20)
* [Playground / 调用测试](#playground--调用测试)
* [Claude Code 接入建议](#claude-code-接入建议)
* [安全说明](#安全说明)
* [测试](#测试)
* [项目结构](#项目结构)
* [常见问题](#常见问题)
* [License](#license)

---

### Logo 设计理念

Yutrix 的 Logo 采用了极具现代感的拱门（Gate）造型，中央悬浮着一颗发光的代码火花（Prompt）。这象征着它作为一个强大、安全、智能的 LLM 提示词网关（Portal）。标志性的青蓝色渐变色调传达出科技感、深度与可靠性。

## 最近更新 (Recent Updates)

- **客户端覆盖 (Client Override)**：当路由开启 **允许客户端指定模型 (Allow Client Model Override)** 后，已授权的普通用户可在「选择自定义模型」的覆盖模式中选择 **客户端覆盖**。网关会用客户端请求中的模型名（`body.model`）去匹配该路由 **L0** 配置（策略规则中的模型 + L0 基础模型）；命中则使用对应 L0 模型，全部无法命中则走 **General** 兜底。该模式与页面上的「全局固定模型」互斥（同一用户+路由覆盖下也不会与自定义策略映射并存）。
- **供应商模型一键启用/关闭**：在供应商模型配置弹窗中，管理员可一键启用或关闭列表中的全部模型（工具栏按钮 + 表头开关）。与单行开关一致，仅在保存后生效。
- **关闭模型发现时的路由式 `/v1/models` 列表**：模型发现**开启**（默认）时，`/v1/models` 仍返回管理员配置的 OpenAI/Anthropic 发现列表（与供应商模型库脱钩）。当模型发现**关闭**时，列表改为根据请求主机匹配的已启用 **L0** 路由动态生成：优先 `virtualModelAlias`，否则使用 L0 的 `targets[0].modelId` / 路由 `modelId`；若无可用路由则返回占位模型 `default`。
- **多级漏斗式降级路由 (Cascading Funnel Routing)**：废弃了过去的单级备用供应商逻辑，为每个路由引入了高级目标矩阵（Grid）。管理员现在可以配置真正的多层级联降级（如第一层满载或报错 -> 自动转第二层 -> 自动转第三层），并在遇到 429、502、503 等错误时自动向后接力。
- **尽力而为模型匹配 (Best Effort Matching)**：为降级目标引入了全新的“尽力而为”模式。现在不再需要将降级死锁在一个固定模型上，网关会在触发降级时智能扫描目标供应商，尝试寻找与原请求同名的模型，在跨供应商切换时最大程度保留用户的原始模型意图。
- **提供商模型别名 (Model Aliases)**：现在可以为模型配置易读的显示别名。该别名将优雅地展示在管理后台、LLM 审计日志以及自动化的钉钉使用报告中，同时网关仍会严格按照其实际的模型 ID（如 `gpt-4o`）向上游发起请求，兼顾可读性与协议严谨性。
- **模型发现列表 (Model Discovery List)**：`/v1/models` 端点现在返回**完全可配置**的模型列表，与系统实际配置的供应商模型**完全脱钩**。这确保了第三方客户端（Claude Desktop、opencode、Codex CLI 等）连接网关时能够自动发现并使用标准的官方模型 ID，获得最佳兼容性。管理员可在路由页面通过弹窗分别配置 OpenAI 和 Anthropic 协议的模型列表。默认启用，预置了常用模型（`gpt-4.1`、`o3`、`claude-opus-4-20250918` 等）。
- **用户/用户组输入 Token 限制**：管理员可以在用户组上配置默认最大输入 Token，也可以为单个用户设置覆盖值。`0` 表示不限制。实际 LLM 请求超过有效阈值时，Yutrix 会在上游调用前执行保守的滑动窗口截断，优先保留 system/developer 消息、最新对话轮次和工具调用链上下文。
- **续接感知模型锁定 (Continuation-Aware Model Locking)**：策略路由现在能区分「真实用户输入」和「工具结果 / system-reminder / 自动继续」。模型仅在用户每次真实发消息（输入文字或上传图片）时决策一次，之后锁定不变，直到下一次用户输入再重新决策——工具调用循环、Agentic 工作流和后台请求期间不会发生模型切换。
- **策略路由 (Strategy Routing)**：路由不再依赖 LLM 预判或模型交接，而是由网关本地按任务类型确定目标模型。系统会基于当前用户真实输入和是否携带图片，毫秒级归类为 `vision`、`debug`、`code`、`long_context`、`writing` 或 `general`，再转发到管理员为该任务配置的模型。没有额外 LLM 调用、没有语义缓存表、也没有 preflight 等待。
- **路由周期计划 (Route Scheduling)**：支持为任何路由规则配置按周/按时段循环的计划覆盖。在设定的生效时段内，网关将自动选用定制的模型、降级通道和尽力而为（Best Effort）策略。交互端支持“全天/具体时段”双模式切换，去除了繁琐的手动配置，改由程序自动感应并展示跨零点“次日”标识，并内置可视化浮窗规则说明，极低上手认知成本。
- **AI 客户端自动识别**：通过启发式分析请求头、路径及系统提示词特征，自动识别发起请求的 AI 编码客户端（如 Claude Code、Cursor、OpenCode、Xcode、Augment Code 等）。识别结果以品牌配色徽章的形式展示在审计日志 UI 中。对于历史遗留数据或无法识别的客户端，将优雅降级为不显示任何徽章。
- **响应缓存** — 管理员可将特定用户输入与预设响应绑定的缓存机制：
  - 在 LLM 审计日志中，管理员可以点击任意对话轮次旁的缓存按钮，将用户输入和模型完整回复（含推理过程）加入缓存
  - 后续任何请求的用户真实输入（而非完整 agent 上下文）匹配已缓存条目时，网关直接返回缓存响应——零 Token 消耗、零延迟、零上游 API 调用
  - 跨客户端通用（curl、Claude Code、Cursor 等），因为匹配基于提取后的用户真实输入，而非完整请求体
  - 缓存管理页面可查看所有条目、命中次数、最后命中时间，并支持删除
  - 缓存命中的回复在审计日志中标记「缓存命中」徽章，并按正常策略合并会话
- **系统信息与数据库管理**：在设置页面新增了全面的系统信息看板，可实时查看应用、内存及宿主机的详细运行状态。同时新增了 SQLite 数据库文件信息展示与备份下载功能。
- **审计日志 UI 重构与 Markdown 支持**：全新设计的 LLM 审计日志界面，移除了中间栏，新增了交互式对话迷你地图（Minimap）、持久化自动滚动开关，并为 AI 回复添加了轻量级 Markdown 渲染，极大优化了长对话的阅读体验。
- **Thinking 模型兼容性支持**：在网关层增加了对 OpenAI 兼容格式的“思考型”模型（如 DeepSeek-R1、Qwen）的支持。Yutrix 现会在将流式或非流式响应发送给客户端前，自动剥离 `reasoning_content` 字段，以防止旧版 LLM 客户端崩溃，同时在内部审计日志中完整保留该思考过程。
- **LLM 审计日志与智能会话合并**：利用强大的四级降级策略系统，智能地将多轮对话和工具调用循环（例如来自 Claude Code, Cursor, Augment Code 等自动助手）合并为连贯的会话。同时新增了**免审计用户**功能，可为特定高权限用户完全豁免日志记录。
- **后台 UI 与侧边栏优化**：重构了管理后台的侧边栏菜单分组，增加了状态持久化记忆功能，并新增了仪表盘（Dashboard）的快速访问入口。
- **用户组与路由授权**：新增用户组管理功能，支持默认组和自定义组。路由可按用户和组进行授权访问，现有部署自动向下兼容迁移，并支持从默认组移除成员。
- **全局统计周期 UI**：引入了极具现代感且完全国际化的顶栏时间周期筛选下拉框，并在设置页面新增了"数据统计设置"模块，允许自定义数据的聚合边界（如每日/每周的起始时间）。
- **钉钉通知增强**：支持自动向钉钉群推送每日消耗统计报表。新增了自定义 Cron 表达式、排除指定用户（即便 0 消耗也正常纳入推送排名）、以及国际化推送文案（中/英）功能。
- **登录体验与安全**：登录页现已全面支持国际化（i18n），并新增了符合现代 Web 体验的"保持登录状态 (Keep me logged in)" 功能。

## 核心特性

### 1. 统一路由管理

后台不再把“端点管理”和“二级域名分流”拆成两个割裂页面，而是统一为 **路由管理**。

一条路由规则定义：

```text
Host + Path + 路由协议
  → 供应商出口 + modelId + 提示词策略 + 备用服务
```

例如：

```text
Host: code.example.com
Path: /v1/messages
路由协议: Anthropic
供应商: qwen-provider
模型: qwen3.6-plus
```

### 2. 协议网关，而不是模型类型网关

Yutrix 的协议路由规则由：

```text
入口协议 + 供应商出口能力
```

决定。

模型只是写入请求体的 `model` 字段，不反向决定协议。

例如：

```text
路由协议 = Anthropic
供应商有 Anthropic 出口
  → 直接转发到 Anthropic 出口

路由协议 = Anthropic
供应商没有 Anthropic 出口，但有 OpenAI-compatible 出口
  → 使用 Anthropic → OpenAI-compatible 适配

路由协议 = OpenAI
  → 使用 OpenAI-compatible 出口
```

### 3. API Key 自主管理

用户创建自己的 Yutrix API Key。完整 Key 只在创建时显示一次，数据库只保存 hash 和前缀。

管理员可以查看、审计和管理 Key 状态；普通用户只能查看和作废自己的 Key。

### 4. 多供应商接入

供应商可以配置：

* OpenAI-compatible Base URL；
* Anthropic Base URL；
* 上游 API Key；
* 并发限制；
* 最大输出 Token；
* 模型列表。

保存供应商前需要测试连接并获取模型列表。

### 5. 并发控制

Yutrix 支持多层并发控制：

```text
全局队列
供应商队列
API Key 队列
```

主供应商达到并发上限时，如果路由配置了备用供应商，会触发单级降级。

### 6. 降级转发

路由可选配置备用供应商与备用模型。

默认触发降级的情况：

```text
主供应商并发已满
上游返回 429
上游返回 503
上游返回 529
```

如果备用供应商也达到并发限制，不会继续多级降级，而是在备用供应商队列中排队。

### 策略路由

策略路由是路由级的确定性、用户输入驱动的模型选择能力。开启后，每条路由维护一份任务类型到模型的映射：

* `vision`：图片、截图、视觉识别、图片位置调整等请求。
* `debug`：报错、异常、超时、堆栈、失败、修复和排查意图。
* `code`：代码生成、重构、接口、组件、编译和工程实现。
* `long_context`：长日志、审计记录、文档、迁移、总结和大段上下文。
* `writing`：文章、文案、邮件、翻译、改写和润色。
* `general`：必填兜底规则，未命中其他类型时使用。

#### 决策时机

网关**仅在真实用户输入时**（即用户打字发消息或上传图片，审计日志中的「蓝色气泡」）执行任务分类和模型选择。两次用户输入之间，模型锁定不变、不会重新分类：

```text
用户输入（文字 / 图片）  →  分类任务类型  →  选择模型  →  锁定
  工具结果               →  保持当前模型（不重新分类）
  system-reminder        →  保持当前模型
  自动继续               →  保持当前模型
  标题生成               →  保持当前模型
用户输入（下一条消息）    →  重新分类  →  选择模型  →  锁定
```

这确保了多步 Agentic 工作流（工具调用循环、文件编辑、终端命令）期间不会发生意外的模型切换。模型从用户发出请求的那一刻起保持一致，直到用户发出下一条消息。

#### 工作原理

分类逻辑在网关本地执行，提取当前用户输入文本并检测图片内容块。分类过程是确定性的——不调用路由 LLM、不创建语义缓存、不依赖模型自称能力。

对于续接请求（工具结果、system-reminder、自动生成标题等），网关通过会话匹配引擎查找上一轮使用的模型并继承。如果未找到上一轮模型，则保持当前模型不变。

如果命中的策略模型被停用或不存在，网关会安全地留在当前路由目标模型，避免请求中断。路由计划任务仍用于按时间覆盖主要目标和降级配置。策略路由处于队列、单级降级、协议适配、Token 统计、Action Logs 与 LLM 审计日志主链路内。

#### 长上下文安全网 (Long Context Override Safety Net)

Yutrix 针对上下文窗口限制实现了自动溢出路由。如果被分配到的目标模型配置了 `maxOutputTokens`（该值兼作物理上下文天花板），且网关估算到本次请求（加上即将注入的提示词策略）会超出此上限，网关会在把请求真正发给上游 API **之前**将其拦截，并自动将请求转交给为该路由配置的 `long_context` 任务模型。

该机制无论请求的任务类型如何（vision、code、debug、writing 等），都会生效。即使是 vision 类型请求，当所有 vision 模型容量不足时，也会回落到 Long Context 列寻找备用模型。并发降级后的请求同样适用此机制。

### 7. Token 处理流水线

Yutrix 的 Token 处理分为两条独立的流水线，互不干扰：

#### 输入 Token 流水线（控制 Prompt 长度）

```text
请求进入
  ↓
① 用户组输入限制（enforceInputTokenLimit）
   → 超过用户组/用户的 maxInputTokens → 智能剪裁（丢弃最旧对话轮次）
   → 未超过或无限制 → 原样放行
  ↓
② 策略路由（classifyTask）
   → 根据用户输入内容分类为 vision/debug/code/long_context/writing/general
   → 路由到对应任务类型的目标模型
  ↓
③ 长文本溢出检查（Long Context Override）
   → 估算输入 Token 数
   → 超过当前目标模型的 maxOutputTokens → 自动路由到 Long Context 列的模型
   → 未超过 → 留在原模型
  ↓
④ 发给上游
```

#### 输出 Token 流水线（控制 max_tokens 参数）

```text
请求进入 Payload 构建阶段（transformRequestBody）
  ↓
检查目标模型是否配置了 maxOutputTokens
  → 未配置（= 0）→ 完全透传，不裁剪、不补齐、不改写
  → 已配置（> 0）→ 以下规则：
    → 客户端未传 max_tokens       → 注入为 maxOutputTokens
    → 客户端传的值 > maxOutputTokens → 覆盖为 maxOutputTokens
    → 客户端传的值 ≤ maxOutputTokens → 原样保留
```

两条流水线完全独立：输入流水线决定「给模型看多少上下文」，输出流水线决定「让模型最多回复多少」。

### 8. Anthropic → OpenAI-compatible 适配

当入口是 Anthropic 协议，但供应商没有 Anthropic 出口、只有 OpenAI-compatible 出口时，Yutrix 可以执行非流式协议适配：

```text
Anthropic request
  → OpenAI chat/completions request
  → OpenAI response
  → Anthropic messages response
```

当前流式适配第一版暂不支持，会返回标准的 HTTP 错误。

### 9. 中文单行实时日志

每个关键动作都会生成一行中文 action log：

```text
2026-06-02 13:20:01 信息 请求完成 requestId=req_xxx 用户=test APIKey=pg_abcd Host=code.example.com 路径=/v1/messages 路由=ClaudeCode 供应商=供应商A 模型=qwen3.6-plus 状态=200 输入Token=10 输出Token=20 总Token=30 耗时=1234ms 排队=0ms 降级=否
```

同一条日志会同时进入：

```text
stdout / PM2 logs
页面实时日志 SSE
内存历史日志
data/action.log
```

页面日志不是 tail PM2 文件，而是消费同源 actionLogger 事件。

### 10. 智能会话合并

Yutrix 搭载了先进的启发式引擎，可将离散的 API 请求逻辑分组为高连贯性、人类可读的会话（Session）。如果客户端未显式传递 `X-Server-Session-Id` 请求头，Yutrix 会按有序级联逐层筛查：强确定性信号优先，弱启发式只会在前面全部未命中时执行。

0. **客户端会话 ID (Client Session ID)**：匹配客户端传入的 `X-Client-Session-Id`、`X-Conversation-Id` 或 `X-Session-Id`。
1. **上一轮助理回复哈希 (Previous Assistant Hash)**：精确匹配 AI 助手上一轮回复内容的密码学哈希，自动处理内容截断和思考 token（Reasoning Tokens）剥离。最适合发送完整对话历史记录的工具（如标准 API 客户端或常规 Web UI）。
2. **对话根哈希 (Conversation Root Hash)**：匹配首条 System 和首条 User 消息的 SHA-256 哈希值。对工具调用（Tool Calls）和中间分支具备极强的弹性。最适合维护稳定根上下文的 AI 编程助手。
3. **完全相同的输入指纹 (Identical Input Fingerprint)**：在 30 分钟窗口期内匹配完全相同的用户输入。有效解决重试风暴和非对话式的单次任务。
4. **内嵌提示词指纹 (Embedded Prompt Fingerprint)**：匹配相邻请求中被标题生成、摘要生成或委派工具调用包裹的真实用户意图。该层只比较归一化指纹，不依赖客户端名称或工具名称。
5. **上下文重叠 (Context Overlap)**：当动态 System Prompt 破坏根哈希时，使用最近对话内容做安全兜底匹配。
6. **最近活跃会话后备 (Recent Activity Fallback)**：将毫无歧义的延续性请求（如独立的工具调用反馈、后台标题生成等）安全地合并到该用户过去 5 分钟内最活跃的会话中。
7. **后台启发式 (Background Heuristic)**：处理孤立的后台单次请求，是最弱兜底层，只会在所有更严格策略都失败后执行。

### 11. Token Usage Quality Score (TUQS 2.0)

Yutrix 能够在不侵入用户业务代码的前提下，纯粹通过物理网关遥测数据来评估开发者的提示词质量。该评分基于 5 个核心指标计算：

1. **上下文激增率 (Context Spike Rate)**：在同一个 `sessionTitle` 下，如果 `promptTokens[n] > promptTokens[n-1] * 5` 且 `completionTokens[n]` 极短（< 200），则触发惩罚。激增率高说明用户正在盲目堆砌未经优化的海量文本。（越低越好）
2. **流式中断率 (Stream Abort Rate)**：中断请求与总请求的比例（`Aborted Requests / Total Requests`）。如果客户端在流自然结束前断开连接，则 `isAborted = true`。高流式中断率说明对提示词意图的把控较差。（越低越好）
3. **前缀缓存命中率 (Prefix Cache Efficiency)**：缓存 Token 占比（`SUM(cachedTokens) / SUM(promptTokens)`）。`cachedTokens` 从上游 `usage` 载荷中提取（如 OpenAI 的 `cached_tokens` 或 Anthropic 的 `cache_read_input_tokens`）。（越高越好）
4. **盲目重试 (Thrashing & Retry Loops)**：当同一 `sessionTitle` 下 5 分钟滚动窗口内出现 > 4 次请求，且各次调用的 `promptTokens` 波动率 < 5% 但输出极短或被中断时，触发惩罚。这表明用户在把 AI 当老虎机“抽卡”。（越低越好）
5. **首字延迟惩罚 (TTFT Penalty)**：计算用户的平均首字延迟（`ttftMs`）并与团队基准线进行对比。如果平均 TTFT 显著偏高，则扣分，这往往意味着上下文过度臃肿。（越低越好）

### 12. Playground / 调用测试

所有用户都可以使用调用测试页面：

* 选择路由；
* 粘贴自己的 API Key；
* 输入提示词；
* 生成 curl；
* 发起测试请求；
* 生成 Claude Code settings.json；
* 生成适合大任务拆分的 CLAUDE.md 建议片段。

Claude Code settings 默认不指定模型，模型由 Yutrix 路由决定。

---

## 核心概念

### Yutrix API Key

Yutrix API Key 是用户访问网关的凭证。

请求示例：

```bash
curl https://code.example.com/v1/messages \
  -H "Authorization: Bearer pg_xxx" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "auto",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "你好" }
    ]
  }'
```

Yutrix 会校验 `pg_xxx`，识别用户身份，然后根据 Host + Path + 路由协议匹配路由。

---

### Host / 二级域名

Host 是请求进入 Yutrix 的入口。

例如：

```text
code.example.com
token.example.com
claude.example.com
```

Yutrix 根据 Host 匹配路由规则。

如果开启 unknown host fallback，则未知 Host 只能命中显式配置的 wildcard/default 路由，不会随便命中具体 Host 的路由。

---

### 路由协议

路由协议表示客户端请求 Yutrix 的协议格式。

当前支持：

```text
OpenAI
Anthropic
```

常见路径：

```text
OpenAI:
  /v1/chat/completions

Anthropic:
  /v1/messages
  /v0/messages
```

---

### 供应商出口能力

供应商可以同时拥有：

```text
OpenAI-compatible 出口
Anthropic 出口
```

也可以只有其中一个。

Yutrix 根据入口协议和供应商出口能力决定最终转发方式。

#### Anthropic 路由规则

```text
如果供应商有 Anthropic 出口：
  直接使用 Anthropic 出口

如果供应商没有 Anthropic 出口，但有 OpenAI-compatible 出口：
  使用 Anthropic → OpenAI-compatible 适配
```

#### OpenAI 路由规则

```text
使用 OpenAI-compatible 出口
```

当前不做 OpenAI → Anthropic 适配。

---

### 模型 modelId

模型只是请求体里的字符串，最终会写入：

```json
{
  "model": "qwen3.6-plus"
}
```

模型本身不决定路由协议。

这点很重要：

```text
协议路由由路由协议和供应商出口能力决定。
模型只是被写入请求参数的数据。
```

---

## 架构说明

典型部署结构：

```text
Internet
  ↓ HTTPS
Caddy
  ↓ HTTP
Yutrix 127.0.0.1:3001
  ↓
上游供应商
```

建议：

```text
Caddy 负责 HTTPS
Yutrix 只监听 127.0.0.1
Yutrix 不直接暴露公网端口
```

---

## 技术栈

* TypeScript
* Fastify
* React
* Vite
* SQLite
* Drizzle ORM
* pnpm workspace
* PM2
* Caddy

生产推荐环境：

```text
Node.js 24.16.x LTS
PM2
Caddy
SQLite
```

---

## 快速开始

### Docker 启动（推荐）

> 感谢 [Arthur](https://github.com/arthur-studio) 提供 Dockerfile 和启动命令。

三条命令即可启动：

```bash
mkdir -p /opt/promptgate/data
```

```bash
# 容器名建议使用 yutrix（新部署）。若沿用旧容器名 promptgate 也可。
# 数据目录 /opt/promptgate/data 保持兼容，便于迁移旧数据。
docker run -d \
  --name yutrix \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /opt/promptgate/data:/app/data \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e DB_FILE=/app/data/promptgate.sqlite \
  -e ACTION_LOG_FILE=/app/data/action.log \
  -e PROMPTGATE_SECRET=$(openssl rand -hex 32) \
  -e LOG_LEVEL=info \
  ghcr.io/yutrix-ai/yutrix:latest
```

```bash
docker logs -f yutrix
```

首次启动会在日志中打印管理员用户名、密码和邀请码。

#### 镜像标签

| 分支 | 标签 |
| --- | --- |
| `main` | `latest` |
| 其他分支 | 分支名（如 `dev`、`feature-xxx`） |

### 手动安装

#### 1. 克隆项目

```bash
git clone https://github.com/yutrix-ai/yutrix.git
cd yutrix
```

#### 2. 安装依赖

```bash
pnpm install
```

#### 3. 构建

```bash
pnpm build
```

#### 4. 创建 `.env`

```bash
cat > .env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
DB_FILE=/opt/promptgate/data/promptgate.sqlite
PROMPTGATE_SECRET=$(openssl rand -hex 32)
LOG_LEVEL=info
EOF
```

#### 5. 启动

```bash
pm2 start ecosystem.config.cjs --update-env
pm2 logs promptgate-server
```

首次启动会在日志中打印：

```text
管理员用户名
管理员初始密码
邀请码
```

请登录后立即修改管理员密码。

---

## 生产部署

推荐部署路径：

```text
/opt/promptgate
```

推荐环境：

```text
OpenCloudOS / RHEL-like Linux
Node.js 24.16.x LTS
pnpm
PM2
Caddy
SQLite
```

### 安装 Node.js 24.16

推荐使用 nvm：

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"

nvm install 24.16.0
nvm use 24.16.0
nvm alias default 24.16.0

node -v
npm -v
```

安装 pnpm 和 PM2：

```bash
npm install -g pnpm pm2
pnpm -v
pm2 -v
```

如果服务器已有旧 Node 或旧 PM2 进程，建议不要直接覆盖系统 Node。可以通过 `.env` 指定：

```env
NODE_INTERPRETER=/home/user/.nvm/versions/node/v24.16.0/bin/node
```

---

## 反向代理与流式优化 (SSE Optimization)

当 Yutrix 面向公网暴露时，强烈建议为 API 路由（`/v1/*`, `/v0/*`）**关闭代理缓冲（Proxy Buffering）与压缩**。这能确保大模型的流式响应（SSE）在产生时瞬间推给客户端，避免因为反向代理的缓存机制导致流式输出“一卡一卡”，或者因为长思考模型（如 o1, gemma）首字延迟过高触发 `499 Client Closed Request` 断连超时。

不需要拆成“前端域名”和“后端域名”。推荐域名规划：

```text
pg.example.com          后台管理
code.example.com        Claude Code 路由
token.example.com       OpenAI-compatible 路由
```

### Caddy 推荐配置

```caddyfile
pg.example.com, code.example.com, token.example.com {
    # 1. 定义匹配器：排除大模型的 API 接口，避免压缩导致数据被缓冲
    @compress {
        not path /v1/*
        not path /v0/*
    }
    
    # 仅对前端页面等非流式接口进行压缩
    encode @compress gzip zstd

    # 2. 反向代理配置
    reverse_proxy 127.0.0.1:3001 {
        # 核心参数：-1 代表禁用内部响应缓冲，确保 SSE 瞬间推给客户端
        flush_interval -1
        
        # 传递客户端真实信息
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

### Nginx 推荐配置

```nginx
server {
    listen 443 ssl;
    server_name pg.example.com code.example.com token.example.com;
    
    # ... 你的 SSL 配置 ...

    # 默认路由：后台前端与普通静态资源
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API 路由：专门针对流式输出 (SSE) 的无缓冲优化
    location ~ ^/(v1|v0)/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 核心参数：彻底关闭缓冲和压缩，确保打字机效果平滑
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        
        # 延长读取超时，防止类似 gemma-31b 等模型长时思考导致 504 / 499 断连
        proxy_read_timeout 300s;
    }
}
```

### 部署关键点

```text
必须保留 Host header。
Yutrix 强依赖 Host 做多租户与路由匹配。
```

（如果修改了 Caddyfile，请使用 `systemctl reload caddy` 柔性重载，不要 `restart` 以免中断当前连接。）

---

## 环境变量

`.env` 示例：

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3001

DB_FILE=/opt/promptgate/data/promptgate.sqlite
PROMPTGATE_SECRET=change-me

LOG_LEVEL=info
ACTION_LOG_FILE=/opt/promptgate/data/action.log

NODE_INTERPRETER=/home/user/.nvm/versions/node/v24.16.0/bin/node
```

### 变量说明

| 变量                | 默认值                    | 说明                 |
| ----------------- | ---------------------- | ------------------ |
| NODE_ENV          | production             | 运行环境               |
| HOST              | 127.0.0.1              | 监听地址               |
| PORT              | 3000                   | 监听端口               |
| DB_FILE           | data/promptgate.sqlite | SQLite 文件路径        |
| PROMPTGATE_SECRET | 无                      | 用于加密供应商上游 API Key  |
| DB_BACKUP_PASSWORD| 无                      | 下载数据库备份时所需的验证密钥    |
| LOG_LEVEL         | info                   | 日志等级               |
| ACTION_LOG_FILE   | data/action.log        | action log 文件      |
| NODE_INTERPRETER  | node                   | PM2 使用的 Node 可执行文件 |

生产环境必须配置 `PROMPTGATE_SECRET`。

### 数据库备份安全配置

为了满足企业安全合规要求并实施**职责分离 (Separation of Duties, SoD)** 原则，Yutrix 将应用配置管理与原始敏感数据的所有权进行解耦：
* 默认情况下，数据库备份下载功能是**禁用的**（控制台中的密码框与下载按钮将被隐藏，且直接请求 API 会返回 `403 Forbidden`）。
* 要启用该功能，请配置 `DB_BACKUP_PASSWORD` 环境变量（或在 `.env` 文件中设置）。
* 启用后，管理员必须在控制台界面中输入正确的验证密码才可以激活下载按钮并导出 SQLite 备份文件。

生成方式：

```bash
openssl rand -hex 32
```

---

## 首次启动

首次启动时 Yutrix 会自动：

1. 初始化数据库；
2. 创建管理员账号；
3. 创建邀请码；
4. 在日志中打印管理员初始密码和邀请码。

查看日志：

```bash
pm2 logs promptgate-server
```

你会看到类似：

```text
管理员用户名: admin
管理员密码: xxxxxxxxxxxxxxxx
邀请码: pg-inv-xxxxxxxxxxxx
```

请妥善保存并立即修改管理员密码。

---

## 升级指南

如果需要将现有的手动部署环境升级到最新版本：

```bash
git pull
pnpm install
pnpm build
pm2 restart promptgate-server
```

Docker 部署升级时，拉取新镜像并用同一个数据卷重建容器：

```bash
docker pull ghcr.io/yutrix-ai/yutrix:latest
docker stop yutrix
docker rm yutrix
# 使用上文相同 docker run 命令，并保持同一个 /app/data 挂载
```

*注意：数据库的表结构更新（Migrations）会在应用每次启动时自动安全地执行，无需手动干预。* 本次升级切换到策略路由：新增路由级 `strategyRoutingEnabled` / `strategyRoutingRules`，移除旧 LLM 模型交接字段和供应商模型的路由指引字段，并删除旧路由缓存表。既有固定路由会保持策略路由关闭状态继续工作，部署后可立即在路由编辑页配置策略。

---

## 路由管理

路由管理是 Yutrix 的核心配置入口。

一条路由包括：

```text
规则名称
Host / 二级域名
请求路径
路由协议
供应商
模型
提示词策略
备用供应商
运行参数
```

示例：

```text
Host: code.example.com
Path: /v1/messages
路由协议: Anthropic
供应商: qwen-provider
模型: qwen3.6-plus
```

### OpenAI 路由

```text
Path: /v1/chat/completions
路由协议: OpenAI
供应商出口: OpenAI-compatible
```

请求会按 OpenAI-compatible 格式转发。

### Anthropic 路由

```text
Path: /v1/messages
路由协议: Anthropic
```

如果供应商有 Anthropic 出口：

```text
直接转发到 Anthropic 出口
```

如果供应商没有 Anthropic 出口，但有 OpenAI-compatible 出口：

```text
执行 Anthropic → OpenAI-compatible 非流式适配
```

### wildcard/default 路由

可使用 `*` 作为兜底入口。

unknown host fallback 只会命中这种明确配置的 wildcard/default 路由，不会命中具体 Host 的路由。

---

## 供应商管理

供应商代表一个上游 LLM 服务。

可配置：

```text
名称
OpenAI-compatible Base URL
OpenAI-compatible API Key
Anthropic Base URL
Anthropic API Key
并发限制
最大输出 Token
```

保存供应商前需要测试。测试会请求模型列表并存储到本地数据库。

### 上游 API Key 安全

供应商上游 API Key 使用 `PROMPTGATE_SECRET` 加密存储，不会返回给前端。

---

## API Key 管理

Yutrix API Key 是访问网关的凭证。

### 普通用户

普通用户可以：

```text
创建自己的 API Key
查看自己的 API Key
作废自己的 API Key
查看自己的使用统计
修改密码
```

完整 Key 只在创建时显示一次。

数据库只保存：

```text
keyHash
keyPrefix
status
userId
```

### 管理员

管理员可以：

```text
查看所有 API Key
审计 API Key 使用
禁用 / 启用 API Key
查看 revoked Key
```

管理员不需要代用户创建 API Key。API Key 的创建入口应以当前登录用户为准。

---

## 用户组与路由授权

Yutrix 支持通过用户组进行细粒度的路由访问控制：

- **默认组**：首次启动时自动创建。所有现有用户和路由会自动分配给它，确保向下兼容。
- **自定义组**：管理员可以创建额外的用户组，将用户分配到多个组，也可以从任意用户组移除成员，包括默认组。
- **路由授权**：每条路由可以授权给特定的用户和/或组。用户可以访问的路由包括：直接授权给自己的路由，以及所属组被授权的路由（取并集）。
- **自动分配**：新注册或管理员创建的用户会自动加入默认组。新建路由默认授权给默认组。
- **管理员豁免**：管理员用户可以访问所有路由，无需授权检查。

这套系统在保持简单性的同时实现了细粒度的访问控制：大多数用户属于默认组并拥有完全访问权限，而特定用户或组可以根据需要限制为访问部分路由。

---

## 用户/用户组输入 Token 限制

Yutrix 可以在请求转发给上游模型之前执行最大输入 Token 限制：

- **用户组默认值**：每个用户组可以配置 `maxInputTokens`，用户未单独覆盖时继承所属用户组限制。
- **用户覆盖值**：管理员可以为单个用户配置 `maxInputTokensOverride`。只要该值非空，就优先于所有用户组限制。
- **不限制语义**：`0` 表示不限制。用户覆盖值为 `0` 时，表示该用户显式不受用户组限制。
- **多用户组规则**：用户属于多个组且没有覆盖值时，系统会取所有正数限制里的最小值，即最严格限制。如果所有组都是 `0`，则不限制。
- **请求处理策略**：如果实际请求超过有效限制，Yutrix 会优先丢弃最旧的对话轮次；如果最新一轮本身仍然过大，则对其中最长的文本块执行头尾保留截断。
- **保护上下文**：系统/开发者消息、请求体级 system 指令、tools/functions、最近的 tool call/tool result 链会尽量保留。如果这些固定结构本身已经超过预算，网关会返回结构化错误，而不是发送一个必然爆窗的请求给上游。
- **Token 计数策略**：OpenAI 系模型优先使用 `tiktoken-node`；对于 GPT-4o/GPT-5/o 系等需要 `o200k_base` 的模型，使用 `tiktoken`。非 OpenAI 模型优先使用配置的 tokenizer repo，缺失时使用保守启发式估算。最终日志统计仍优先采用上游返回的 `usage`，避免本地估算覆盖真实账单口径。

这项能力适合作为网关层兜底：它能防止超长上下文直接打爆上游窗口，但不替代应用层的摘要、长期记忆或 RAG。需要长期上下文质量时，推荐使用“网关硬限制 + 应用层摘要/记忆/检索”的组合。

---

## 提示词策略

Yutrix 支持提示词注入策略。

原则：

```text
提示词只在每次对话开始时注入一次。
```

系统会根据请求形态和策略配置判断是否为新对话。

常见用途：

```text
Claude Code 系统提示词
Codex 风格策略
企业统一系统提示词
安全约束
角色设定
```

---

## 并发、限流与降级

Yutrix 支持多层并发：

```text
全局并发
供应商并发
API Key 并发
```

并发控制以队列形式执行。

### 降级触发条件

如果路由配置了备用供应商，以下情况会触发单级降级：

```text
主供应商并发已满
上游返回 429
上游返回 503
上游返回 529
```

状态码含义：

| 状态码 | 语义      |
| --- | ------- |
| 429 | 上游限流    |
| 503 | 上游服务不可用 |
| 529 | 上游过载    |

### 降级规则

```text
只做单级降级
不会多级 fallback
fallback 供应商也满时，在 fallback 供应商队列中排队
```

### 流式请求规则

对于流式请求：

```text
如果主请求尚未向客户端写出内容，上游直接返回 429 / 503 / 529，可以触发 fallback。
如果已经开始输出 stream，中途失败不再切换供应商。
```

避免一个流中混入两个模型的输出。

---

## maxOutputTokens 说明

供应商可配置：

```text
最大输出 Token
```

字段含义：

```text
maxOutputTokens = 0
  完全透传
  不裁剪
  不补齐
  不改写 max_tokens

maxOutputTokens > 0
  仅当请求中已有 max_tokens / max_completion_tokens 且超过上限时裁剪
```

Yutrix 默认不补 `max_tokens`。

这对 Claude Code 和代码生成场景很重要，因为大任务可能需要长输出。默认 0 能最大程度保持客户端行为。

兼容逻辑：

```text
max_tokens_to_sample → max_tokens
```

如果发生裁剪，会输出中文日志：

```text
警告 输出Token上限已裁剪 requestId=... 原始值=50000 裁剪后=8192
```

---

## 实时日志

Yutrix 的 action log 是中文单行日志。

同一条日志会同时进入：

```text
stdout / PM2 logs
页面实时日志
内存 ring buffer
data/action.log
```

页面实时日志使用 SSE，不读取 PM2 文件。

### 测试日志

后台实时日志页面提供：

```text
生成测试日志
```

点击后应同时在三处看到日志：

```text
页面实时日志
pm2 logs promptgate-server
data/action.log
```

### 典型请求日志

```text
2026-06-02 13:20:01 信息 请求完成 requestId=req_xxx 用户=test APIKey=pg_abcd Host=code.example.com 路径=/v1/messages 路由=ClaudeCode 供应商=供应商A 模型=qwen3.6-plus 状态=200 输入Token=10 输出Token=20 总Token=30 耗时=1234ms 排队=0ms 降级=否
```

### 典型降级日志

```text
2026-06-02 13:21:10 警告 触发降级 requestId=req_xxx 用户=test 主供应商=供应商A 主模型=qwen3.6-plus 降级原因=上游限流 备用供应商=供应商B 备用模型=qwen-max
```

---

## Playground / 调用测试

Playground 是所有用户可用的调用测试页面。

支持：

```text
选择路由
粘贴 API Key
输入提示词
生成 curl
发起测试调用
生成 Claude Code settings.json
生成 CLAUDE.md 建议片段
```

由于完整 API Key 只在创建时显示一次，Playground 不会从服务器取回完整 Key。用户需要手动粘贴自己的 `pg_` Key。

---

## Claude Code 接入建议

Claude Code 通常走 Anthropic 协议，即：

```text
/v1/messages
```

建议在 Yutrix 中创建：

```text
Host: code.example.com
Path: /v1/messages
路由协议: Anthropic
```

如果供应商没有 Anthropic 出口，但有 OpenAI-compatible 出口，Yutrix 会执行 Anthropic → OpenAI-compatible 非流式适配。

### 推荐 settings.json

建议使用 `ANTHROPIC_AUTH_TOKEN`，让 Claude Code 发送：

```text
Authorization: Bearer pg_xxx
```

示例：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://code.example.com",
    "ANTHROPIC_AUTH_TOKEN": "pg_xxx",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "allow": []
  },
  "theme": "auto"
}
```

不建议在 settings.json 中指定模型：

```json
{
  "model": "opus[1m]"
}
```

原因是 Yutrix 的真实模型由路由规则决定。Claude Code 的模型字段可能导致它在客户端侧认为模型不存在或无权限。

### 大任务建议

对于大规模代码任务，建议通过 `CLAUDE.md` 指导 Claude Code 分阶段执行，而不是用 Yutrix 裁剪 `max_tokens`。

推荐片段：

```md
# Claude Code 工作约定

处理大型编码任务时，请遵守：

1. 先制定分阶段计划，不要一次性输出全部代码。
2. 每次只修改一组相关文件。
3. 大文件修改请使用编辑工具分块完成。
4. 如果改动超过 5 个文件，先列出步骤。
5. 生成代码时优先写入文件或 patch，不要输出超长代码块。
6. 如果一次回复接近长度上限，请主动停止在安全边界，并说明下一步继续。
7. 不要因为输出限制省略关键实现。
```

---

## 安全说明

Yutrix 的安全边界包括：

```text
用户密码使用 hash 存储
Yutrix API Key 使用 hash 存储
完整 API Key 只显示一次
供应商上游 API Key 加密存储
日志不输出完整 API Key
日志不输出 keyHash
日志不输出 provider raw key
日志不输出 passwordHash
日志不输出 inviteCode hash
```

生产部署建议：

```text
Yutrix 监听 127.0.0.1
Caddy 提供 HTTPS
Caddy 保留 Host header
不要直接暴露 Yutrix 端口
定期备份 SQLite 数据库
妥善保存 PROMPTGATE_SECRET
建议使用非特权用户（如 yutrix）运行服务，不要使用 root 用户
```

---

## 测试

常用测试命令：

```bash
pnpm build

node -e "require('./apps/server/dist/routes/gateway.js'); console.log('gateway import ok')"

bash -n docs/fresh-install-test.sh
bash docs/fresh-install-test.sh

node docs/concurrency-tests.js
node docs/test_regression.js <admin_password>
```

### 重点回归项

```text
API Key 鉴权
disabled / revoked / expired Key 拒绝
Host + Path + 协议路由
unknown host fallback 安全边界
maxOutputTokens=0 透传
maxOutputTokens>0 裁剪
max_tokens_to_sample 兼容
429 / 503 / 529 降级
主供应商并发满降级
fallback 供应商满后排队
Anthropic → OpenAI-compatible 非流式适配
实时日志 SSE
页面日志与 PM2 logs 同源
```

---

## 项目结构

```text
Yutrix/
├── apps/
│   ├── server/                 # Fastify 后端、网关、API、SSE 日志
│   └── web/                    # React + Vite 前端
├── packages/
│   └── shared/                 # 共享类型和校验
├── data/                       # SQLite 数据库和 action.log
├── logs/                       # 可选日志目录
├── docs/                       # 部署、测试、回归文档
├── scripts/                    # 安装 / 检查脚本
├── ecosystem.config.cjs        # PM2 配置
├── pnpm-workspace.yaml
└── package.json
```

---

## 常见问题

### 需要两个域名分别给前端和后端吗？

不需要。

Yutrix 是单服务应用，前端页面、后台 API、网关 API 都由同一服务承载。

推荐：

```text
后台域名 + 路由域名
```

例如：

```text
pg.example.com
code.example.com
token.example.com
```

---

### 为什么 Claude Code 配了 Yutrix 但不能用？

首先确认 Claude Code 实际走的是 Anthropic 协议：

```text
/v1/messages
```

如果你只测试了：

```text
/v1/chat/completions
```

那只是 OpenAI-compatible 路由通了，不代表 Claude Code 通了。

建议用：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://code.example.com",
    "ANTHROPIC_AUTH_TOKEN": "pg_xxx"
  }
}
```

不要使用顶层 `model` 强制指定 Claude 官方模型。

---

### ANTHROPIC_API_KEY 和 ANTHROPIC_AUTH_TOKEN 有什么区别？

Claude Code 中：

```text
ANTHROPIC_API_KEY 通常发送 X-Api-Key
ANTHROPIC_AUTH_TOKEN 通常发送 Authorization: Bearer
```

Yutrix 推荐使用：

```text
ANTHROPIC_AUTH_TOKEN=pg_xxx
```

---

### maxOutputTokens 应该设置多少？

默认建议：

```text
0
```

含义：

```text
完全透传，不干预客户端请求
```

对于 Claude Code、代码生成、长输出场景，建议保持 0。

只有明确知道某个供应商有输出上限或需要控制成本时，才设置大于 0 的值。

---

### Anthropic → OpenAI-compatible 适配什么时候发生？

只在以下情况发生：

```text
入口协议是 Anthropic
供应商没有 Anthropic 出口
供应商有 OpenAI-compatible 出口
```

如果供应商配置了 Anthropic 出口，Yutrix 会直接转发 Anthropic 协议请求。

---

### 模型协议会影响路由吗？

不会。

Yutrix 是协议网关。模型只是写入请求体 `model` 字段的字符串。

路由协议由入口协议和供应商出口能力决定，不由模型类型决定。

---

### 页面实时日志和 PM2 logs 是一回事吗？

它们不是读取同一个文件，但来自同一个 actionLogger 事件。

一条 action log 会同时进入：

```text
PM2 stdout
页面 SSE
内存历史
data/action.log
```

因此从内容上看，它们是同源的。

---

## 文档

- [版本与产品线说明（Community vs 商业版）](./docs/editions.md)
- [English README](./README.md)
- [Caddy 部署指南](./docs/deployment-caddy.md)
- [全新安装测试](./docs/fresh-install-test.md)
- [实时日志说明](./docs/realtime-config.md)
- [发布检查清单](./docs/release-checklist.md)

## License

Yutrix is released under the [MIT License](./LICENSE).

Copyright (c) 2026 Tom Wu.
