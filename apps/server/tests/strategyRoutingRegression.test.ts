import { describe, expect, it } from "vitest";
import {
  classifyIntentTaskType,
  classifyStrategyTask,
  type StrategyTaskType,
} from "../src/services/strategyRouting";

function expectStrategyRoute(input: string, taskType: StrategyTaskType) {
  expect(classifyStrategyTask(input, false).taskType, input.slice(0, 120)).toBe(
    taskType,
  );
}

describe("strategy routing regression matrix", () => {
  it.each([
    ["from the station we walked home before dinner. ".repeat(20), "general"],
    ["let us reflect on what friendship means. ".repeat(20), "general"],
    ["return to the main trail after the lake. ".repeat(20), "general"],
    [
      "compare package delivery options for a small shop. ".repeat(20),
      "general",
    ],
  ] as const)(
    "does not infer code from repeated prose tokens",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["```css\n.card { display: grid; color: red; }\n```\n".repeat(120), "code"],
    ["```html\n<section><h1>Hello</h1></section>\n```\n".repeat(120), "code"],
    [
      "```sh\nfor file in *.txt; do printf '%s\\n' \"$file\"; done\n```\n".repeat(
        100,
      ),
      "code",
    ],
    [
      'fun greet(name: String): String { return "Hello $name" }\n'.repeat(100),
      "code",
    ],
  ] as const)(
    "keeps oversized multi-language source on the code route",
    (input, expected) => {
      expect(input.length).toBeGreaterThan(4000);
      expectStrategyRoute(input, expected);
    },
  );

  it("does not treat fenced prose or fenced structured logs as source code", () => {
    const prose = `\`\`\`text\n${"ordinary narrative sentence. ".repeat(180)}\n\`\`\``;
    const logs = `\`\`\`log\n${"2026-07-31 10:11:12 INFO status=200 message=ok\n".repeat(20)}\`\`\``;

    expectStrategyRoute(prose, "long_context");
    expectStrategyRoute(logs, "long_context");
  });

  it.each([
    ["```css\n.panel { overflow: hidden; }\n```", "code"],
    ["```tsx\n<div>failed</div>\n```", "code"],
    ['export const status = "failed";', "code"],
    ["export function f() { return 500; }", "code"],
    ["const error = null\nthe app crashes", "debug"],
  ] as const)(
    "keeps source literals local without hiding a later live failure",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["update src/parser.ts to parse status=200 level=info message=ok", "code"],
    [
      "UPDATE jobs SET status='ok', level='info', message='done' WHERE id=1;",
      "code",
    ],
    [
      "implement a parser API with status=200 level=info message=ok fields",
      "code",
    ],
    ["review this transcript and build a parser", "code"],
    ["write a Python script to analyze nginx logs", "code"],
    ["write a regex to parse logs", "code"],
  ] as const)(
    "lets explicit source work beat log-like fields",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["retry when the request times out", "code"],
    ["write a test for when the request times out", "code"],
    ["implement the API to report an error when the token is invalid", "code"],
    ["新增报错提示功能", "code"],
    ["给页面加报错提示", "code"],
    ["新增崩溃提示功能", "code"],
    ["实现白屏监控功能", "code"],
    ["实现部署失败告警", "code"],
  ] as const)(
    "treats failure-themed specifications as code work",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["the request keeps failing", "debug"],
    ["the endpoint responds with 500", "debug"],
    ["the endpoint status is 500", "debug"],
    ["请求仍然失败", "debug"],
    ["请求继续失败", "debug"],
    ["请求依旧失败", "debug"],
    ["页面出现错位", "debug"],
    ["按钮错位了", "debug"],
    ["文字溢出了", "debug"],
    ["元素发生重叠", "debug"],
  ] as const)(
    "routes live runtime and layout failures to debug",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["implement API error handling, but production is crashing", "debug"],
    ["implement timeout handling, but the endpoint responds with 500", "debug"],
    ["新增报错提示功能后，登录依然报错", "debug"],
    ["实现堆栈展示功能后页面白屏", "debug"],
    ["在 Demo.vue 中实现内容溢出处理", "code"],
    ["在 Demo.tsx 中添加一个遮挡层", "code"],
  ] as const)("uses clause-local failure roles", (input, expected) => {
    expectStrategyRoute(input, expected);
  });

  it.each([
    ["Add retry logic for IOException", "code"],
    ["Create a handler for IOException", "code"],
    ["support IOException mapping", "code"],
    ["assertThrows(IOException.class, action)", "code"],
    ["IOException should be caught and retried", "code"],
    ["implement IOException handling", "code"],
    [
      "IOException: connection reset\n  at Client.send(Client.java:42)",
      "debug",
    ],
    ["IOException", "debug"],
  ] as const)(
    "distinguishes exception development from live exceptions",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["麻烦帮我看一下这张图", "vision"],
    ["能帮我看看这幅图吗", "vision"],
    ["看看这张图哪里有问题", "vision"],
    ["堆栈如下：线程阻塞，等待数据库连接超过一分钟", "debug"],
    ["堆栈如下，线程阻塞，等待数据库连接超过一分钟", "debug"],
  ] as const)(
    "accepts natural Chinese image and stack aliases",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["What is Bug Analyzer?", "general"],
    ["compare Bug Locator with Bug Tracker", "general"],
    ["buganalyzer has bugs", "debug"],
    ["Bug Locator has two bugs", "debug"],
    ["there are bugs in Bug Tracker", "debug"],
    ["Bug Analyzer keeps failing", "debug"],
    ["Bug Analyzer reports an error", "debug"],
    ["fix docs for Bug Analyzer", "general"],
    ["fix this typo in README for Bug Analyzer", "general"],
  ] as const)(
    "masks brand spans but keeps residual bug meaning",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["these bugs are harmless examples", "general"],
    ["parser has bugs", "debug"],
    ["found multiple bugs", "debug"],
    ["bugs need fixing", "debug"],
    ["triage these bugs", "debug"],
    ["address the production bugs", "debug"],
    ["write release notes for these bugs", "writing"],
    ["draft release notes for production bugs", "writing"],
    ["write a changelog for these bugs", "writing"],
  ] as const)(
    "requires operational context for plural bugs",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["fix BUG-123", "debug"],
    ["investigate BUG #123", "debug"],
    ["resolve BUG:123", "debug"],
    ["triage BUG/123", "debug"],
    ["Bugs 101 course", "general"],
    ["write release notes for BUG-123", "writing"],
  ] as const)(
    "recognizes canonical tickets without stealing writing or course titles",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["implement a customer service policy", "general"],
    ["implement an employee migration plan", "general"],
    ["implement a class schedule", "general"],
    ["implement an interface design standard", "general"],
    ["implement authentication middleware", "code"],
    ["implement response caching", "code"],
    ["implement OAuth login", "code"],
    ["implement rate limiting", "code"],
    ["implement a CLI command", "code"],
  ] as const)(
    "requires a concrete technical target for implement",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["checking the server logs", "long_context"],
    ["reviewing the audit logs", "long_context"],
    ["searched the nginx logs for failures", "long_context"],
    ["finding crashes in application logs", "long_context"],
    ["searching timeouts in server logs", "long_context"],
    ["reviewed failed requests in nginx logs", "long_context"],
    ["scanning crashes across application logs", "long_context"],
    ["examine the application logs", "long_context"],
    ["grep the nginx logs for request ids", "long_context"],
    ["correlate logs across services", "long_context"],
    ["enable logging then analyze the logs", "code"],
    ["enable logging and write a report", "code"],
    ["write a report, then enable logging", "code"],
    ["add logging and write documentation", "code"],
  ] as const)(
    "handles log-analysis inflections and instrumentation priority",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ['const error = new Error("boom");', "code"],
    ["class IOException extends Exception {}", "code"],
    ["function handle(error) { return error; }", "code"],
    ["catch (error) { console.log(error); }", "code"],
    ["void run() throws IOException {}", "code"],
    ["return 500;", "code"],
    ["UPDATE jobs SET status=500, message='failed' WHERE id=1;", "code"],
    [".panel { overflow: hidden; }", "code"],
    ["interface ErrorResponse { error: string; }", "code"],
    ["select id from users", "code"],
    ["delete from users", "code"],
    ["create table users", "code"],
    ["class Foo {} this.status = 500", "code"],
    ["function f(){return 1;} app.status = 500", "code"],
    ["class Foo {} request.failed = false", "code"],
  ] as const)(
    "does not mistake failure words inside source code for live incidents",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["write an article about application crashes", "writing"],
    ["write an email explaining why the endpoint returns 500", "writing"],
    ["draft a report about common errors", "writing"],
    ["document common IOException errors", "writing"],
    ["translate an article about human error", "writing"],
    ["write an article about how to enable logging", "writing"],
    ["create an article about logging best practices", "writing"],
    ["write a guide about how to enable logging", "writing"],
    ["create a guide about logging best practices", "writing"],
    ["document how to enable logging", "writing"],
    ["draft a guide to investigate errors in server logs", "writing"],
    ["write a postmortem about errors found in logs", "writing"],
    ["create a report to investigate errors in logs", "writing"],
    ["write a report after adding context about application crashes", "writing"],
    ["write an article after adding a section about why apps crash", "writing"],
    ["summarize results after adding failure cases", "writing"],
  ] as const)(
    "keeps failure and logging topics inside a writing frame",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["now implement timeout handling", "code"],
    ["implement IOException handling now", "code"],
    ["现在新增报错提示功能", "code"],
    ["实现后端错误处理", "code"],
    ["新增后端报错提示功能", "code"],
    ["develop backend exception handling", "code"],
    ["show an error", "code"],
    ["if upload fails, show an error", "code"],
    ["send an alert when the app crashes", "code"],
    ["display an error when validation fails", "code"],
    ["monitor crashes in production", "code"],
    ["define a TypeScript interface", "code"],
    ["declare a Java class", "code"],
    ["configure the endpoint to return 500", "code"],
    ["the UI should show an error", "code"],
    ["the endpoint should return 500", "code"],
    ["the function must throw an error", "code"],
    ["In styles.css, text must not overflow the card", "code"],
    ["Update styles.css so the sidebar does not overlap content", "code"],
    ["Set overflow:hidden in styles.css", "code"],
    ["Prevent text from overflowing in styles.css", "code"],
    ["Avoid overlap in styles.css", "code"],
    ["Use overflow:hidden in styles.css", "code"],
    ["Change overflow:hidden in styles.css", "code"],
    ["Apply overflow:hidden in styles.css", "code"],
    ["Make text not overflow in styles.css", "code"],
    ["Do not let sidebar overlap content in styles.css", "code"],
    ["在 styles.css 中防止文字溢出", "code"],
    ["在 styles.css 中避免按钮重叠", "code"],
    ["implement a command to debug errors in logs", "code"],
    ["build a tool to investigate errors in logs", "code"],
    ["implement a parser to fix errors found in logs", "code"],
    ["write a script to troubleshoot errors in server logs", "code"],
  ] as const)("recognizes modal and temporal specifications", (input, expected) => {
    expectStrategyRoute(input, expected);
  });

  it.each([
    ["implement error handling and the app still crashes", "debug"],
    ["implement timeout handling and the request still times out", "debug"],
    ["新增报错提示功能登录仍然报错", "debug"],
    ["returns 500", "debug"],
    ["throws an error", "debug"],
    ["shows an error", "debug"],
    ["the text overflows the card", "debug"],
    ["the button overlaps the label", "debug"],
    ["the modal obscures the submit button", "debug"],
    ["the scrollbar disappeared", "debug"],
    ["the text is cut off", "debug"],
    ["the button is covered", "debug"],
    ["const error = null; the app crashes", "debug"],
    ["const error = null, the app crashes", "debug"],
    ["const error = null and the app crashes", "debug"],
    ["class ErrorBoundary {} checkout crashes", "debug"],
    [".panel { overflow:hidden; } but the app crashes", "debug"],
    ["UPDATE jobs SET status=200; deployment failed", "debug"],
    ["function handle(error) { return error; } the service fails", "debug"],
    ["UPDATE jobs SET status='failed'; the request keeps failing", "debug"],
    ["UPDATE jobs SET status='failed'; investigate why production crashes", "debug"],
    ["after adding retry the request fails", "debug"],
    ["after adding support the request fails", "debug"],
    ["after adding an alert the app crashes", "debug"],
    ["after we implemented retry the request fails", "debug"],
    ["once retry was added the request fails", "debug"],
    ["I clicked update and the button overlaps the label", "debug"],
    ["I set the value and the modal overlaps the footer", "debug"],
    ["the update completed and the modal obscures the button", "debug"],
    ["support replied and the elements overlap", "debug"],
    ["the input misaligns after resize", "debug"],
    ["Dashboard.vue chart overflows plot area", "debug"],
    ["Canvas.tsx canvas overflows parent", "debug"],
    ["Popover.vue popover overlaps trigger", "debug"],
    ["Drawer.tsx drawer obscures FAB", "debug"],
    ["service panics", "debug"],
    ["after the retry was implemented the request fails", "debug"],
    ["following retry implementation the request fails", "debug"],
    ["since we added retry the request fails", "debug"],
    ["write a report and the app crashes", "debug"],
    ["draft a guide and the service fails", "debug"],
  ] as const)(
    "keeps an unpunctuated live tail stronger than an earlier specification",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["find errors in nginx logs", "long_context"],
    ["analyze nginx logs for failed requests", "long_context"],
    ["check server logs for timeout errors", "long_context"],
    ["review logs where the endpoint returned 500", "long_context"],
    ["find failed requests in nginx logs", "long_context"],
    ["find timeouts in nginx logs", "long_context"],
    ["find crashes in application logs", "long_context"],
    ["look at the server logs", "long_context"],
    ["go through the audit logs", "long_context"],
    ["query the logs for request ids", "long_context"],
    ["tail the nginx logs", "long_context"],
    ["extract errors from nginx logs", "long_context"],
    ["analyze logs and fix the error", "debug"],
    ["review logs to investigate the error", "debug"],
    ["why does this error occur?", "debug"],
    ["why did this error happen?", "debug"],
    ["analyze this error", "debug"],
    ["review the error", "debug"],
    ["inspect this error", "debug"],
    ["inspect the error logs", "long_context"],
    ["analyze the error log", "long_context"],
    ["review the error logs", "long_context"],
    ["check the error log", "long_context"],
    ["examine the error logs", "long_context"],
    ["search errors in logs and troubleshoot them", "debug"],
    ["find the error in nginx logs to troubleshoot it", "debug"],
    ["search errors in logs and reproduce them", "debug"],
    ["review logs while investigating the error", "debug"],
    ["analyze logs before fixing the error", "debug"],
    ["search logs while debugging the error", "debug"],
    ["review logs after reproducing the error", "debug"],
    ["analyze logs while troubleshooting the error", "debug"],
    ["troubleshooting errors in server logs", "debug"],
    ["review logs containing IOException", "long_context"],
    ["grep application logs for NullPointerException", "long_context"],
    ["analyze logs for exception patterns", "long_context"],
    ["find exception entries in server logs", "long_context"],
    ["search logs for BUG-123", "long_context"],
    ["find BUG-123 in nginx logs", "long_context"],
    ["grep application logs for BUG #123", "long_context"],
    ["review logs containing BUG:123", "long_context"],
    ["review logs to investigate BUG-123", "debug"],
    ["analyze logs and fix BUG-123", "debug"],
    ["the error needs fixing", "debug"],
    ["this error must be fixed", "debug"],
    ["the error message needs fixing", "debug"],
    ["this error response should be investigated", "debug"],
    ["the error should be investigated", "debug"],
    ["analyze logs; the error needs fixing", "debug"],
    ["analyze the error budget", "general"],
    ["review the error bars", "general"],
    ["inspect the error covariance matrix", "general"],
    ["the error has to be fixed", "debug"],
    ["the error is being investigated", "debug"],
    ["the error is under investigation", "debug"],
    ["analyze the error message", "debug"],
    ["review this error code", "debug"],
    ["review the error response", "debug"],
    ["inspect the error stack", "debug"],
    ["analyze the error in production", "debug"],
    ["analyze the error in measurement", "general"],
    ["standard error must be fixed", "general"],
    ["measurement error should be investigated", "general"],
  ] as const)(
    "separates log-search topics from explicit debugging work",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["package delivery was delayed by weather", "general"],
    ["type your answer in the box", "general"],
    ["class schedules change every semester", "general"],
    ["object permanence develops in infancy", "general"],
    ["interface design standards are discussed below", "general"],
    ["function and form in modern architecture", "general"],
    ["we await your response", "general"],
    ["crop yield increased this year", "general"],
    ["export growth slowed this quarter", "general"],
    ["catch the next bus", "general"],
    ["the road extends north", "general"],
    ["import taxes rose last year", "general"],
    ["select one option from the list", "general"],
    ["an obscure historical fact", "general"],
    ["meeting times overlap", "general"],
    ["the river overflows every spring", "general"],
    ["the fog obscures the mountain", "general"],
    ["support replied and meeting times overlap", "general"],
    ["the profit margin increased this quarter", "general"],
    ["the grocery store closes at nine", "general"],
    ["the distance between the cities is twenty miles", "general"],
    ["the gender gap narrowed last year", "general"],
    ["the street grid follows the old city walls", "general"],
    ["flex your knees before lifting", "general"],
    ["government opacity weakened public trust", "general"],
    ["we await your response\ncrop yield increased\nexport growth slowed\nreturn home safely", "general"],
    [`${"ordinary prose sentence. ".repeat(180)}\nwe await a reply\nexport growth continued`, "long_context"],
    ["Alice: Hello\nBob: Welcome\nCarol: Thanks\nDave: Goodbye", "general"],
    ["first thought;\nsecond thought;\nthird thought;\nfourth thought;", "general"],
  ] as const)("does not accumulate prose lines into source evidence", (input, expected) => {
    expectStrategyRoute(input, expected);
  });

  it("recognizes unfenced shell source and common structured log layouts", () => {
    expectStrategyRoute("echo hello\n".repeat(500), "code");
    expectStrategyRoute("mkdir output\n".repeat(400), "code");
    expectStrategyRoute(
      "Jul 31 12:00:00 host sshd[123]: Accepted connection\n".repeat(3),
      "long_context",
    );
    expectStrategyRoute(
      "INFO 2026-07-31 12:00:00 Request completed\n".repeat(3),
      "long_context",
    );
    expectStrategyRoute(
      '{"log":"request complete\\n","stream":"stdout","time":"2026-07-31T12:00:00.000000000Z"}\n'.repeat(
        3,
      ),
      "long_context",
    );
    expectStrategyRoute(
      "2026-07-31T12:00:00.000000000Z stdout F request complete\n".repeat(
        3,
      ),
      "long_context",
    );
    expectStrategyRoute(
      '2001:db8::1 - - [31/Jul/2026:12:00:00 +0000] "GET /health HTTP/1.1" 200 2\n'.repeat(
        3,
      ),
      "long_context",
    );
    expectStrategyRoute(
      "items = [1, 2, 3]\nresult = [x * 2 for x in items]\nprint(result)",
      "code",
    );
    expectStrategyRoute(
      'const user = {};\nuser.name = "Ada";\nresult = users.map(renderUser);',
      "code",
    );
    expectStrategyRoute(
      "items := []int{1, 2, 3}\nresult := append(items, 4)\nfmt.Println(result)",
      "code",
    );
    expectStrategyRoute(
      '{\n  "name": "Ada",\n  "active": true,\n  "roles": ["admin"]\n}',
      "code",
    );
  });

  it("does not reinterpret JSX or HTML attributes as key-value logs", () => {
    expectStrategyRoute(
      '<Widget status="ok" message="ready" />\n'.repeat(3),
      "code",
    );
    expectStrategyRoute(
      '<div status="ok" message="ready"></div>\n'.repeat(3),
      "code",
    );
  });

  it.each([
    ["the parser has no bugs", "general"],
    ["there are no UI bugs in the release", "general"],
    ["we found no regression bugs", "general"],
    ["Bug Analyzer reports no errors", "general"],
    ["Bug Tracker has no error", "general"],
    ["Bug Locator never fails", "general"],
    ["Bugs Bunny has a carrot", "general"],
    ["There are cartoons with Bugs Bunny", "general"],
    ["parser A has no bugs and parser B has bugs", "debug"],
    ["write an article about fixing bugs", "writing"],
    ["write a guide for fixing bugs", "writing"],
    ["draft an article: fixing production bugs", "writing"],
    ["write release notes for fixing BUG-123", "writing"],
    ["summarize the BUG-123 fix", "writing"],
    ["write release notes for BUG-123 and BUG-124", "writing"],
    ["summarize BUG-123 and BUG-124", "writing"],
    ["translate BUG-123 and BUG-124", "writing"],
    ["summarizing BUG-123", "writing"],
    ["documenting BUG-123", "writing"],
    ["translating BUG-123", "writing"],
    ["rewriting BUG-123 description", "writing"],
    ["polishing BUG-123 title", "writing"],
    ["describing how BUG-123 was fixed", "writing"],
    ["explaining the BUG-123 fix", "writing"],
    ["summarize ways to fix bugs", "writing"],
    ["preparing documentation for BUG-123", "writing"],
    ["create a report about BUG-123", "writing"],
    ["review a report about BUG-123", "writing"],
    ["describe BUG-123 in a report", "writing"],
    ["write a summary of BUG-123", "writing"],
    ["create a summary for BUG-123", "writing"],
    ["update description for BUG-123", "writing"],
    ["撰写 BUG-123 的修复报告", "writing"],
    ["总结 BUG-123 的修复情况", "writing"],
    ["更新 BUG-123 的描述", "writing"],
    ["编辑 BUG-123 的描述", "writing"],
    ["改写 BUG-123 的描述", "writing"],
    ["撰写报告说明如何修复 BUG-123", "writing"],
    ["revise the report about BUG-123", "writing"],
    ["do not fix BUG-123, only write a report about it", "writing"],
    ["do not investigate BUG-123; just summarize BUG-123", "writing"],
    ["not asking you to fix BUG-123, only explain it", "writing"],
    ["不要修复 BUG-123，只写一份报告", "writing"],
    ["BUG-123 不需要修复，只要写报告", "writing"],
    ["do not fix BUG-123, investigate BUG-124", "debug"],
    ["fix BUG-123, do not investigate BUG-124", "debug"],
    ["write release notes for BUG-123 and investigate BUG-124", "debug"],
    ["write an article about BUG-123 and fix BUG-124", "debug"],
    ["write a report, then investigate BUG-123", "debug"],
    ["write release notes, then fix BUG-123", "debug"],
    ["search logs for BUG-123 and fix README", "long_context"],
    ["find BUG-123 in nginx logs and fix a typo in README", "long_context"],
    ["search logs for BUG-123 while fixing README", "long_context"],
    ["find BUG-123 in nginx logs after fixing a README typo", "long_context"],
    ["BUG-123 has been resolved", "general"],
    ["BUG-123 is closed", "general"],
    ["BUG-123 已修复", "general"],
    ["fix BUG-123 and update README", "debug"],
    ["fix BUG-123 and write release notes", "debug"],
    ["update README and fix BUG-123", "debug"],
    ["fix BUG-123 in README", "debug"],
    ["fix README for BUG-123", "general"],
    ["Can you fix the typo in README for Bug Analyzer?", "general"],
  ] as const)("handles negated and meta-level bug language", (input, expected) => {
    expectStrategyRoute(input, expected);
  });

  it.each([
    ["the endpoint is not failing and the worker crashes", "debug"],
    ["service A never crashes and service B fails", "debug"],
    ["no exception occurred and the worker crashes", "debug"],
    ["the request no longer fails", "general"],
    ["endpoint did not fail", "general"],
    ["IOException did not occur", "general"],
    ["the crash is resolved", "general"],
    ["what is measurement error", "general"],
    ["mean squared error is a loss function", "general"],
    ["why is mean squared error useful?", "general"],
    ["why does standard error decrease with sample size?", "general"],
    ["why is measurement error important?", "general"],
    ["why is prediction error important?", "general"],
    ["why does percentage error matter?", "general"],
    ["why is trial and error effective?", "general"],
    ["why is error correction important?", "general"],
    ["investigate percentage error in the survey", "general"],
    ["calculate standard error", "general"],
    ["the error was fixed", "general"],
    ["崩溃已解决", "general"],
    ["报错已修复", "general"],
    ["页面错位已修复", "general"],
    ["问题已经解决，不再崩溃", "general"],
    ["retry after the request fails", "code"],
    ["after adding retry the request no longer fails", "general"],
    ["ever since adding retry the request no longer fails", "general"],
    ["after implementing fix app does not crash", "general"],
    ["新增功能后没有报错", "general"],
    ["新增重试后请求失败时自动告警", "code"],
    ["after adding retry show an error when request fails", "code"],
    ["未发生异常", "general"],
    ["请求未失败", "general"],
    ["从未发生崩溃", "general"],
    ["we never experienced a crash", "general"],
    ["the app did not experience a crash", "general"],
    ["we have not had a timeout", "general"],
    ["after implementation of retry the request fails", "debug"],
    ["ever since adding retry the request fails", "debug"],
    ["after confirming the app does not crash, implement monitoring", "code"],
    ["since the service no longer crashes, add a cleanup job", "code"],
    ["after verifying the request did not fail, write a unit test", "code"],
    ["新增重试功能，确保以后没有报错", "code"],
    ["新增监控，保证部署后没有报错", "code"],
    ["新增重试功能后请求不再失败", "general"],
    ["新增监控后部署没有报错", "general"],
    ["with the exception of admins, all users can log in", "general"],
    ["an exception to the rule", "general"],
    ["make an exception for this user", "general"],
    ["allow an exception to the policy", "general"],
    ["translate: with the exception of weekends", "writing"],
  ] as const)(
    "keeps negation and non-runtime failure terminology local",
    (input, expected) => {
      expectStrategyRoute(input, expected);
    },
  );

  it.each([
    ["the parent responsibilities overlap", "general"],
    ["the parent company overlaps with the subsidiary", "general"],
    ["the trigger schedules overlap", "general"],
    ["the plot timelines overlap", "general"],
    ["Widget.svelte title overlaps subtitle", "debug"],
    ["styles.scss title overlaps subtitle", "debug"],
  ] as const)("binds layout failures to UI context", (input, expected) => {
    expectStrategyRoute(input, expected);
  });

  it.each([
    ["translate this JavaScript function to Python", "code"],
    ["rewrite this function", "code"],
    ["edit this function", "code"],
    ["review this function", "code"],
    ["edit Widget.svelte", "code"],
  ] as const)("routes transformations of code targets to code", (input, expected) => {
    expectStrategyRoute(input, expected);
  });

  it.each([
    ["看一下这个图", "vision"],
    ["帮我看看那张图", "vision"],
    ["请看一下这张图的布局和文字", "vision"],
  ] as const)("accepts additional natural Chinese image grammar", (input, expected) => {
    expectStrategyRoute(input, expected);
  });

  it("keeps agentic continuation payloads from acquiring a new debug intent", () => {
    const toolResult =
      '{"type":"tool_result","content":"BUG-123 failed with error"}';
    const interrupted = "[Request interrupted by user] fix these bugs";

    expect(classifyIntentTaskType(toolResult, true)).toBe("general");
    expect(classifyIntentTaskType(interrupted, true)).toBe("general");
  });
});
