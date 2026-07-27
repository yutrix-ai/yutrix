import { describe, expect, it } from "vitest";
import {
  classifyStrategyTask,
  extractCurrentUserInputForRouting,
  findStrategyRule,
  hasCurrentUserImageInputForRouting,
  hasImageInput,
  parseStrategyRoutingRules,
} from "../src/services/strategyRouting";

describe("strategy routing helpers", () => {
  it("classifies image input as vision without relying on model self-description", () => {
    const body = {
      model: "base-model",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "请识别这张截图里的按钮位置" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      }],
    };

    const currentInput = extractCurrentUserInputForRouting(body);
    expect(hasImageInput(body)).toBe(true);
    expect(classifyStrategyTask(currentInput, hasImageInput(body))).toMatchObject({
      taskType: "vision",
      reasons: ["image_input"],
    });
  });

  it("uses only the latest real user turn for routing intent", () => {
    const body = {
      messages: [
        { role: "user", content: "帮我写一封邮件" },
        { role: "assistant", content: "好的" },
        { role: "tool", content: "noise" },
        { role: "user", content: "这个接口 timeout 报错，帮我排查" },
      ],
    };

    const currentInput = extractCurrentUserInputForRouting(body);
    expect(currentInput).toContain("timeout");
    expect(currentInput).not.toContain("写一封邮件");
    expect(classifyStrategyTask(currentInput, false).taskType).toBe("debug");
  });


  it("normalizes configured rules and falls back to general", () => {
    const rules = parseStrategyRoutingRules(JSON.stringify([
      {
        taskType: "debug",
        providerId: "provider-a",
        providerProtocol: "openai",
        modelId: "debug-model",
        enabled: true,
      },
      {
        taskType: "debug",
        providerId: "duplicate",
        providerProtocol: "openai",
        modelId: "ignored",
      },
      {
        taskType: "general",
        providerId: "provider-b",
        providerProtocol: "anthropic",
        modelId: "general-model",
      },
    ]));

    expect(rules).toHaveLength(2);
    expect(findStrategyRule(rules, "debug")?.modelId).toBe("debug-model");
    expect(findStrategyRule(rules, "writing")?.modelId).toBe("general-model");
  });


  // --- Debug classification ---

  it("does not classify 'fix' alone as debug — it's too generic", () => {
    expect(classifyStrategyTask("fix the alignment of the sidebar", false).taskType).not.toBe("debug");
    expect(classifyStrategyTask("fix this typo in the README", false).taskType).not.toBe("debug");
  });

  it("does not classify 'broken' alone as debug", () => {
    expect(classifyStrategyTask("the broken link needs updating", false).taskType).not.toBe("debug");
  });

  it("still classifies true debug keywords correctly", () => {
    expect(classifyStrategyTask("this function throws an error", false).taskType).toBe("debug");
    expect(classifyStrategyTask("fix the bug in the parser", false).taskType).toBe("debug");
    expect(classifyStrategyTask("NullPointerException at line 42", false).taskType).toBe("debug");
    expect(classifyStrategyTask("the request keeps timing out", false).taskType).toBe("debug");
    expect(classifyStrategyTask("接口报错了，帮我排查一下", false).taskType).toBe("debug");
    expect(classifyStrategyTask("部署之后页面崩溃了", false).taskType).toBe("debug");
  });

  // --- Code classification ---

  it("does not classify common English words as code", () => {
    expect(classifyStrategyTask("let me know when you're done", false).taskType).not.toBe("code");
    expect(classifyStrategyTask("return to the previous topic", false).taskType).not.toBe("code");
    expect(classifyStrategyTask("what is the var of this dataset", false).taskType).not.toBe("code");
  });

  it("classifies programming keywords across languages", () => {
    expect(classifyStrategyTask("def calculate_sum(a, b):", false).taskType).toBe("code");
    expect(classifyStrategyTask("fn main() { println!(\"hello\"); }", false).taskType).toBe("code");
    expect(classifyStrategyTask("define a struct for the user model", false).taskType).toBe("code");
    expect(classifyStrategyTask("add an enum for status types", false).taskType).toBe("code");
    expect(classifyStrategyTask("帮我重构这个函数，使用 async/await 替换 callback", false).taskType).toBe("code");
  });

  it("classifies code with import/export/const correctly", () => {
    expect(classifyStrategyTask("import React from 'react'", false).taskType).toBe("code");
    expect(classifyStrategyTask("export default function App()", false).taskType).toBe("code");
    expect(classifyStrategyTask("const result = await fetch(url)", false).taskType).toBe("code");
  });

  it("classifies code blocks and file extensions correctly", () => {
    expect(classifyStrategyTask("```\nconsole.log('hello')\n```", false).taskType).toBe("code");
    expect(classifyStrategyTask("update the handler in app.tsx", false).taskType).toBe("code");
    expect(classifyStrategyTask("帮我写一段代码", false).taskType).toBe("code");
  });

  // --- Long context classification ---

  it("does not classify input containing common dev words as long_context", () => {
    expect(classifyStrategyTask("summarize this document for me", false).taskType).not.toBe("long_context");
    expect(classifyStrategyTask("explain the context of this change", false).taskType).not.toBe("long_context");
    expect(classifyStrategyTask("帮我总结一下这段内容", false).taskType).not.toBe("long_context");
    expect(classifyStrategyTask("看一下这个文档", false).taskType).not.toBe("long_context");
  });

  it("classifies truly long user input as long_context", () => {
    const longText = "a ".repeat(5000);
    expect(classifyStrategyTask(longText, false).taskType).toBe("long_context");
    expect(classifyStrategyTask(longText, false).reasons).toContain("large_input");
  });

  it("classifies specific long-context keywords correctly", () => {
    expect(classifyStrategyTask("分析一下这份 audit 记录", false).taskType).toBe("long_context");
    expect(classifyStrategyTask("帮我查看这段 log", false).taskType).toBe("long_context");
    expect(classifyStrategyTask("数据库迁移脚本有问题", false).taskType).toBe("long_context");
  });

  // --- Writing classification ---

  it("classifies writing tasks that were previously shadowed by long_context", () => {
    expect(classifyStrategyTask("帮我写一篇文章介绍新功能", false).taskType).toBe("writing");
    expect(classifyStrategyTask("polish this email draft", false).taskType).toBe("writing");
    expect(classifyStrategyTask("translate this changelog to Chinese", false).taskType).toBe("writing");
    expect(classifyStrategyTask("帮我润色一下这段文案", false).taskType).toBe("writing");
  });

  // --- General (fallback) classification ---

  it("falls back to general for ambiguous or simple input", () => {
    expect(classifyStrategyTask("hello", false).taskType).toBe("general");
    expect(classifyStrategyTask("explain how DNS works", false).taskType).toBe("general");
  });

  // --- Priority / edge cases ---

  it("debug takes priority over code when both signals exist", () => {
    expect(classifyStrategyTask("this function throws a TypeError exception", false).taskType).toBe("debug");
    expect(classifyStrategyTask("import 报错了", false).taskType).toBe("debug");
  });

  it("vision takes priority over everything", () => {
    expect(classifyStrategyTask("this screenshot shows an error in the code", false).taskType).toBe("vision");
  });

  // === Data-driven improvements (production data analysis) ===

  // --- Debug: Chinese negative feedback patterns ---

  it("classifies Chinese negative feedback as debug", () => {
    expect(classifyStrategyTask("员工管理 进入 白屏", false).taskType).toBe("debug");
    expect(classifyStrategyTask("样式错乱", false).taskType).toBe("debug");
    expect(classifyStrategyTask("筛选不好使", false).taskType).toBe("debug");
    expect(classifyStrategyTask("老人帐单列表数据没展示全", false).taskType).toBe("debug");
    expect(classifyStrategyTask("没改好", false).taskType).toBe("debug");
    expect(classifyStrategyTask("没效果", false).taskType).toBe("debug");
  });

  // --- Code: CSS properties and measurement units ---

  it("classifies CSS property names as code", () => {
    expect(classifyStrategyTask(".info-section 上下 padding 12", false).taskType).toBe("code");
    expect(classifyStrategyTask("去掉 margin-top", false).taskType).toBe("code");
    expect(classifyStrategyTask("border-radius 改为 10", false).taskType).toBe("code");
    expect(classifyStrategyTask("opacity 改为 0.5", false).taskType).toBe("code");
  });

  it("classifies CSS measurement units as code", () => {
    expect(classifyStrategyTask("退住日期 宽度增加 30px", false).taskType).toBe("code");
    expect(classifyStrategyTask("上下20rpx 左右10rpx", false).taskType).toBe("code");
    expect(classifyStrategyTask("字号都改为 14px", false).taskType).toBe("code");
  });

  // --- Code: file path references ---

  it("classifies file path references as code or debug depending on context", () => {
    // "头像" triggers vision because of '宁可错杀不可放过'
    expect(classifyStrategyTask("src/views/elder-manage/index.vue 头像不展示", false).taskType).toBe("vision");
    // "溢出" is a UI bug, so it correctly routes to debug now
    expect(classifyStrategyTask("src\\pages\\shop-dish\\manage-category\\index.vue 溢出", false).taskType).toBe("debug");
    expect(classifyStrategyTask("views/attendanceScheduling/approval/index.vue", false).taskType).toBe("code");
  });

  // --- Code: Chinese dev terminology ---

  it("classifies Chinese dev terminology as code", () => {
    expect(classifyStrategyTask("这个页面的分页组件靠右", false).taskType).toBe("code");
    expect(classifyStrategyTask("筛选弹框中的告警时间", false).taskType).toBe("code");
    expect(classifyStrategyTask("点击跳转到详情", false).taskType).toBe("code");
    expect(classifyStrategyTask("路由配置不对", false).taskType).toBe("code");
    expect(classifyStrategyTask("数据回显有问题", false).taskType).toBe("code");
    expect(classifyStrategyTask("表格排序功能", false).taskType).toBe("code");
    expect(classifyStrategyTask("调用这个方法获取数据", false).taskType).toBe("code");
    expect(classifyStrategyTask("字段传递不对", false).taskType).toBe("code");
    expect(classifyStrategyTask("参数也要传递", false).taskType).toBe("code");
    expect(classifyStrategyTask("按钮样式修改", false).taskType).toBe("code");
  });

  // --- Real production input examples ---

  it("correctly classifies real production inputs", () => {
    // These are actual user inputs from the production database
    expect(classifyStrategyTask("充值页面 预付款充值 和押金充值按钮是横向排列目前是竖向", false).taskType).toBe("code");
    // "帮我安装依赖" is now correctly routed to code (MDP round 8+: "安装" is a dev action)
    expect(classifyStrategyTask("帮我安装依赖", false).taskType).toBe("code");
    expect(classifyStrategyTask("what llm are you", false).taskType).toBe("general");
    expect(classifyStrategyTask("继续", false).taskType).toBe("general");
    expect(classifyStrategyTask("统计接口 前端报错 code: 400", false).taskType).toBe("debug");
    expect(classifyStrategyTask("http://localhost:9002 分页还是没展示", false).taskType).toBe("debug");
  });

  it("handles camelCase connection word suffix correctly", () => {
    expect(classifyStrategyTask("findAllAssessmentRecordBy", false).taskType).toBe("code");
    expect(classifyStrategyTask("getBy", false).taskType).toBe("code");
    expect(classifyStrategyTask("findUserById", false).taskType).toBe("code");
    expect(classifyStrategyTask("existingDelivery", false).taskType).toBe("code");
    expect(classifyStrategyTask("setCourierName", false).taskType).toBe("code");
  });

  it("handles JS ReferenceErrors and custom undefined errors as debug", () => {
    expect(classifyStrategyTask("ReferenceError: markRaw is not defined", false).taskType).toBe("debug");
    expect(classifyStrategyTask("[渲染层错误] canvas-id attribute is undefined", false).taskType).toBe("debug");
    expect(classifyStrategyTask("TypeError: Cannot read properties of null (reading 'map')", false).taskType).toBe("debug");
  });

  it("classifies non-protocol JSON payloads correctly as code or debug", () => {
    const rawJsonPayload = `{     "rawBase64Last50": "4cOdSDSW3VumqTIahefBigR/oi2lDTz5FhszlLNvhLYDANV7g=",     "rawBase64Length": 3184 }`;
    expect(classifyStrategyTask(rawJsonPayload, false).taskType).toBe("code");

    const errorJsonPayload = `{"message":"老人档案不存在","code":404}`;
    expect(classifyStrategyTask(errorJsonPayload, false).taskType).toBe("debug");
  });

  it("classifies WeChat mini program packages routes and custom routes correctly", () => {
    expect(classifyStrategyTask("staff-packages/leave-management/leave-detail/index 待审核不能编辑", false).taskType).toBe("debug");
    expect(classifyStrategyTask("assistive-product-rental-packages/assessment/detail 编辑点不开", false).taskType).toBe("debug");
  });

  it("classifies input containing return or let statements as code", () => {
    expect(classifyStrategyTask("return { count: 0 }", false).taskType).toBe("code");
    expect(classifyStrategyTask("let items = []", false).taskType).toBe("code");
  });
});
