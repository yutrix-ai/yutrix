---
name: strategy-routing-optimizer
description: 基于生产数据库 (promptgate.sqlite) 中的审计日志，通过多轮 MDP 数据分析迭代，提炼和优化策略路由的任务类型分类关键词规则。当用户提供新的 SQLite 数据库文件时执行此 skill。
---

# 策略路由分类优化 Skill

## 目标

分析 PromptGate 线上 SQLite 数据库中 `chat_logs` 表的用户真实输入，通过多轮数据分析迭代（MDP），发现分类盲区并优化 `classifyStrategyTask` 函数的关键词规则。

## 前置条件

- 用户提供一个 `promptgate.sqlite` 文件（通常在 `~/下载/` 或 `~/Downloads/`）
- 目标代码文件: `apps/server/src/services/strategyRouting.ts` 中的 `classifyStrategyTask` 函数
- 测试文件: `apps/server/tests/strategyRouting.test.ts`
- 依赖: `@node-rs/jieba` 已安装在 `apps/server`

## 架构约束（红线）

1. **不允许修改任何数据库 Schema**（如 drizzle 目录下的文件）
2. **不允许改变已有接口的入参和出参格式**（`StrategyTaskClassification` 等类型定义不动）
3. **必须保留 `general` 兜底**，确保任何情况下网关不会阻断请求
4. **Jieba 词典不放歧义英文单词**（let/var/return/class 等），这些由 regex 层用 `\b` 边界处理

## 执行流程

### Phase 1: 数据提取（创建 `apps/server/scratch_extract.js`）

数据库通常有损坏，不能直接全表扫描。使用以下脚本分批读取：

```javascript
#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');

const dbPath = process.argv[2] || '/home/tomwu/下载/promptgate.sqlite';
const outPath = '/tmp/extracted_prompts.json';
const BATCH = 200;
let offset = 0;
const results = [];
let errorCount = 0;
let emptyCount = 0;

while (emptyCount < 5 && errorCount < 50) {
  try {
    const query = `SELECT inputText, detectedClient, model FROM chat_logs WHERE inputText IS NOT NULL AND inputText != '' AND inputText NOT LIKE '[{"role":"tool"%' AND inputText NOT LIKE '[{"tool_use_id%' AND length(inputText) > 5 LIMIT ${BATCH} OFFSET ${offset};`;
    const raw = execSync(`sqlite3 -json "${dbPath}" "${query.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rows = JSON.parse(raw || '[]');
    if (rows.length === 0) { emptyCount++; offset += BATCH; continue; }
    emptyCount = 0;
    results.push(...rows);
    offset += BATCH;
    if (offset % 2000 === 0) process.stderr.write(`  ${offset} rows, ${results.length} collected...\n`);
  } catch (e) { errorCount++; offset += BATCH; }
}

const seen = new Set();
const unique = [];
for (const r of results) {
  const key = (r.inputText || '').trim();
  if (key && !seen.has(key)) { seen.add(key); unique.push(r); }
}

fs.writeFileSync(outPath, JSON.stringify(unique));
console.log(`Done. Total: ${results.length}, Unique: ${unique.length}, Errors: ${errorCount}`);
```

运行: `cd apps/server && node scratch_extract.js <db_path>`

**预期输出**: `/tmp/extracted_prompts.json`，应有 3000+ 条去重记录。

### Phase 2: 数据概览分析（创建 `apps/server/scratch_analyze.js`）

运行以下脚本获取数据画像，**重点关注 general 兜底率**：

```javascript
#!/usr/bin/env node
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/extracted_prompts.json', 'utf8'));
console.log(`=== TOTAL PROMPTS: ${data.length} ===\n`);

// 1. 客户端分布
const clients = {};
for (const r of data) { const c = r.detectedClient || 'unknown'; clients[c] = (clients[c] || 0) + 1; }
console.log('=== CLIENT DISTRIBUTION ===');
Object.entries(clients).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`));

// 2. 长度分布
const buckets = {'<50': 0, '50-200': 0, '200-500': 0, '500-1k': 0, '1k-2k': 0, '2k-5k': 0, '>5k': 0};
for (const r of data) {
  const len = (r.inputText || '').length;
  if (len < 50) buckets['<50']++; else if (len < 200) buckets['50-200']++;
  else if (len < 500) buckets['200-500']++; else if (len < 1000) buckets['500-1k']++;
  else if (len < 2000) buckets['1k-2k']++; else if (len < 5000) buckets['2k-5k']++;
  else buckets['>5k']++;
}
console.log('\n=== LENGTH DISTRIBUTION ===');
Object.entries(buckets).forEach(([k,v]) => console.log(`  ${k}: ${v} (${(v/data.length*100).toFixed(1)}%)`));

// 3. 语言分布
let chinese = 0, english = 0, mixed = 0;
for (const r of data) {
  const t = r.inputText || '';
  const hasCN = /[\u4e00-\u9fff]/.test(t), hasEN = /[a-zA-Z]{3,}/.test(t);
  if (hasCN && hasEN) mixed++; else if (hasCN) chinese++; else english++;
}
console.log('\n=== LANGUAGE ===');
console.log(`  Chinese: ${chinese}, English: ${english}, Mixed: ${mixed}`);

// 4. 高频关键词统计（按类别）
const keywords = {
  debug_cn: ['报错', '异常', '超时', '失败', '崩溃', '不生效', '没生效', '白屏', '错乱',
    '没展示', '没显示', '没改好', '没效果', '不能', '不行', '还是不', '不对',
    '怎么没', '怎么不', '点不了', '没了', '逻辑不对', '不一致'],
  code_cn: ['代码', '接口', '组件', '函数', '页面', '样式', '路由', '跳转', '弹框',
    '弹窗', '分页', '排序', '字段', '参数', '调用', '回显', '传参', '筛选',
    '重构', '编译', '新增', '删除', '查询', '列表', '详情', '方法', '属性',
    '居中', '内边距', '驼峰', '格式化'],
  writing_cn: ['写一篇', '文章', '润色', '文案', '翻译', '总结', '帮我写', '邮件', '故事',
    '起草', '方案', '发布说明', '总结一下', '生成', '文档'],
  code_en: ['function', 'const', 'import', 'export', 'class', 'async', 'await',
    'interface', 'struct', 'enum', 'controller', 'service', 'dto'],
  debug_en: ['error', 'bug', 'exception', 'failed', 'failure', 'timeout', 'crash'],
};
console.log('\n=== KEYWORD FREQUENCY ===');
for (const [cat, words] of Object.entries(keywords)) {
  console.log(`\n  --- ${cat} ---`);
  for (const w of words) {
    let count = 0;
    for (const r of data) { if ((r.inputText || '').toLowerCase().includes(w.toLowerCase())) count++; }
    if (count > 0) console.log(`    "${w}": ${count} hits`);
  }
}
```

运行: `cd apps/server && node scratch_analyze.js`

**关注点**: 发现新的高频信号词（命中 > 10 次且当前未被覆盖的词），为后续 MDP 迭代提供候选。

### Phase 3: MDP 评估闭环（创建 `apps/server/scratch_mdp_eval.ts`）

这是最核心的脚本 — **直接调用真实的 `classifyStrategyTask` 函数对全量数据做分类**：

```typescript
import * as fs from 'fs';
import { classifyStrategyTask } from './src/services/strategyRouting';

const data: Array<{inputText: string}> = JSON.parse(
  fs.readFileSync('/tmp/extracted_prompts.json', 'utf8')
);

const distribution: Record<string, number> = {};
const generalBucket: Array<{text: string}> = [];

for (const item of data) {
  const text = item.inputText || '';
  const { taskType } = classifyStrategyTask(text, false);
  distribution[taskType] = (distribution[taskType] || 0) + 1;
  if (taskType === 'general' && text.length > 10 && text.length < 500) {
    generalBucket.push({ text: text.trim().slice(0, 200) });
  }
}

console.log('=== CLASSIFICATION DISTRIBUTION ===');
const total = data.length;
for (const [k, v] of Object.entries(distribution).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v} (${(v / total * 100).toFixed(1)}%)`);
}
console.log(`  TOTAL: ${total}`);
console.log(`\n  General fallback rate: ${((distribution.general || 0) / total * 100).toFixed(1)}%`);

// 随机采样 general 桶，用于人工/LLM 审阅
console.log('\n=== GENERAL BUCKET SAMPLES (60) ===');
const shuffled = generalBucket.sort(() => Math.random() - 0.5);
for (let i = 0; i < Math.min(60, shuffled.length); i++) {
  console.log(`  [${i + 1}] ${shuffled[i].text}`);
}
```

运行: `cd apps/server && npx tsx scratch_mdp_eval.ts`

**关键指标**: `General fallback rate` — 这是唯一的北极星指标。目标 < 20%。

### Phase 4: MDP 迭代循环（核心！反复执行直到收敛）

**每轮迭代的标准流程**：

```
1. 运行 scratch_mdp_eval.ts → 记录 general 兜底率
2. 阅读 GENERAL BUCKET SAMPLES 的 60 条输出
3. 逐条判断：这条应该被分类到哪个桶？为什么当前规则没有捕获它？
4. 提取模式 → 形成候选关键词或正则
5. 修改 strategyRouting.ts（优先改 regex 层，边界场景用 Jieba 补充）
6. 运行 npx vitest run tests/strategyRouting.test.ts → 确保 24/24 通过
7. 回到第 1 步
```

**历史经验：各轮迭代的典型发现类型**

| 轮次 | 典型发现 | 效果 |
|------|---------|------|
| 1-2 | JSON 解包缺失（49% 的输入被包裹） | -5pp general |
| 2-3 | 否定反馈模式（还是不/怎么没/点不了） | -2pp |
| 3-4 | camelCase 变量名检测 | -11pp (最大单轮改进) |
| 4-5 | Java/Spring 类名、/api/ URL 路径 | -2pp |
| 5-6 | CSS 选择器、布局术语（居中/靠右） | -1pp |
| 6+ | 收敛，剩余 general 多为真正的通用问题 | <1pp |

**MDP 迭代的修改目标文件和位置**：

修改 `apps/server/src/services/strategyRouting.ts` 中的以下部分：

1. **`normalizeStrategyInput` 函数** — JSON/system-reminder 解包逻辑
   - 当发现新的 agentic 客户端协议格式时在此添加解包规则
   
2. **Debug regex 块** (第 ~228 行起) — 错误信号 + 否定反馈
   - 按信号来源分行，每行加注释说明来源轮次
   
3. **Code regex 块** (第 ~237 行起) — 编程关键词 + 文件/路径引用
   - 最复杂的块，按子类型分行：语言关键词 / 文件扩展名 / 路径引用 / CSS / 中文术语 / Java类名 / URL / camelCase
   
4. **Writing regex 块** (第 ~260 行起) — 内容创作相关
   
5. **`ROUTING_WEIGHTS` 字典** — Jieba 补充权重
   - 仅用于穿透了所有 regex 的边界 case
   - 阈值为 8，低于此值不会触发分类

**修改策略的优先级**：

```
优先用 regex（确定性高、可测试）
↓ 只有 regex 无法覆盖的模式才加到 Jieba 词典
↓ 阈值从 8 开始，只在确认无误判时才降低
```

**迭代终止条件**:
- General 兜底率 < 20% 且连续 2 轮变化 < 0.5pp
- 或已完成 10+ 轮迭代
- 剩余 general 桶中的样本大部分为真正的通用问题（如 "继续"、"确定"、"你好"）

### Phase 5: 验证与提交

1. **运行全部测试**:
   ```bash
   cd apps/server && npx vitest run tests/strategyRouting.test.ts
   ```

2. **类型检查**:
   ```bash
   cd apps/server && npx tsc --noEmit
   ```

3. **清理临时文件**:
   ```bash
   rm -f apps/server/scratch_extract.js apps/server/scratch_analyze.js apps/server/scratch_mdp_eval.ts /tmp/extracted_prompts.json
   ```

4. **提交**:
   ```bash
   git add apps/server/src/services/strategyRouting.ts apps/server/tests/strategyRouting.test.ts .agents/skills/strategy-routing-optimizer/SKILL.md
   git commit -m "feat: 基于生产数据分析优化策略路由分类 ($(date +%Y-%m-%d))"
   ```

**不 push** — 等用户确认后再 push。

### Phase 6: 更新本 SKILL

每次优化完成后，更新本文件底部的「基准数据」表格，记录本轮的指标变化，作为下次优化的起点。

## 输出物

1. **数据分析报告** — 创建 artifact `data_analysis.md`，包含:
   - 数据概览（记录数、客户端分布、输入类型分布）
   - 各分类的命中统计和 general 兜底率
   - 新增关键词清单及其出现频次
   - 分类覆盖率变化（优化前 vs 优化后）

2. **代码变更** — 更新后的 `classifyStrategyTask` 函数和测试

## 关键原则

- **直接调用 `classifyStrategyTask` 做真实评估**，不用 SQL CASE WHEN 模拟
- **general 兜底率是唯一的北极星指标** — 它下降就是进步
- **每个新增关键词都必须有生产数据验证** — 至少命中 5 次以上
- **保持向后兼容** — 只扩充不删除已有关键词（除非数据证明有误判）
- **Jieba 词典不放歧义英文单词**（let/var/return/class 等），用 regex `\b` 边界处理
- **JSON 解包是关键**: 生产数据中大量输入被 agentic 客户端以 JSON 包裹

## 基准数据（2026-06-26 分析结果）

| 指标 | 优化前 (26日初) | 优化后 (深度清理 + 二轮 MDP Review) | 最新 (三轮 MDP: 宁可错杀不可放过 Vision) |
|------|--------|--------|--------|
| 数据源 | 3,237 条 | 31,235 条 (全量) | 29,322 条 (去重后全量) |
| General 兜底率 | 25.4% | 1.62% | **1.55%** |
| Code 命中率 | 51.0% | 91.27% | 88.32% |
| Debug 命中率 | 12.5% | 1.65% | 1.56% |
| Vision 命中率 | 9.4% | 5.35% | **8.46%** |
| 测试通过 | 24/24 | 29/29 | 29/29 |

### 历史关键发现

1. **客户端分布**: Codex CLI (62.7%), Claude Code (13.3%), unknown (23.3%), Cline (0.6%)
2. **输入类型**: 49% 以 JSON 格式到达（需要解包）
3. **语言**: 75% 中英混合, 16% 纯中文, 9% 纯英文
4. **Vision 第一优先级**: Vision 检测必须在所有其他规则之前执行（"宁可错杀也不要放过"），防止图片请求被误路由。
5. **Java PascalCase 后缀匹配修复**: `\b(controller)\b` 无法匹配经 toLowerCase 后的类名，改用后缀匹配。
6. **宽泛中文词误判排查**: `颜色/背景/高度/改成/配置` 等词在日常口语中频繁出现，移除或添加技术上下文约束。
7. **全量数据提取 (31k vs 6k)**: SQL 预过滤后只有 6,356 条，全量无过滤提取得到 31,149 条。

