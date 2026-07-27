# PromptGate Fresh Install Acceptance Test

## 目的
本测试用于验证在空数据库状态下，PromptGate 的全链路配置是否正常工作，且没有任何回归或错误。

## 准备条件
1. 停止当前所有 PromptGate 服务 (`pm2 stop all` 或 `Ctrl+C`)
2. 删除现有数据库文件: `rm data/promptgate.sqlite`
3. 执行数据库初始化:
   ```bash
   cd apps/server
   npm run db:push
   ```
   > 提示：如果提示输入，请选择 "Yes, I want to execute all statements"。
4. 确认生产环境中已配置 Caddy 作为前置反向代理（Caddy 负责 HTTPS 与 CORS 等外部流量安全控制，PromptGate 不把 CORS 作为核心验收标准）。

## 测试步骤

### 1. 系统启动与管理员初始化
1. 启动服务: `pnpm dev` (或者使用 `pm2 start ecosystem.config.cjs`)
2. **查阅日志**：首次启动空库时，系统会自动初始化 admin 用户，并**随机生成 admin 密码**，打印到控制台或 pm2 logs 中。
3. 打开浏览器访问前端控制台 `http://localhost:5173`。
4. 使用用户名 `admin` 和刚才从日志中复制的**随机密码**登录。

### 2. 系统设置
1. 进入 "系统设置" 页面。
2. 配置 **主域名** (例如 `localhost`)。
3. 点击 "保存"。
4. **预期**: 系统设置成功保存。

### 3. 创建二级域名
1. 进入 "网关路由 -> 二级域名"。
2. 点击 "添加"，输入名称 `test-api`，开启状态。
3. **预期**: 创建成功，且此时 `endpoint_routes` 表中应该为空（因为此时还没有任何端点）。

### 4. 创建 API Key
1. 进入 "API Keys"。
2. 点击 "创建 API Key"，绑定到 admin，设置名称为 "Test Key"。
3. **预期**: 返回带有 `pg_` 前缀的完整 Key。列表页面**没有**显示任何 hash 信息（安全校验）。

### 5. 供应商创建与模型验证 (核心回归修复测试)
1. 进入 "供应商 (Providers)"。
2. 添加一个新供应商。
3. 在 OpenAI 协议下，填入 `http://localhost:4010/v1` 和 `sk-test` (上游供应商的 Key)。
4. 点击 "测试连接"（需要预先运行 mock server，可使用 `node docs/test_regression.js` 启动 mock，或自动测试脚本）。
5. **预期**: 测试成功，后端生成安全的 `testSessionId`。
6. 不勾选 Anthropic，点击 "保存"。
7. **预期**: 列表出现该供应商，显示 OpenAI 已配置并有模型数量，Anthropic 显示未配置。
8. 再次编辑该供应商，尝试修改 OpenAI Base URL 但不重新测试。
9. **预期**: 保存时后端返回 400，拒绝修改（强制校验 testSessionId）。
10. 只修改 "并发限制" 和 "名称" 并保存。
11. **预期**: 成功保存，未触发 testSessionId 校验拦截。

### 6. 端点与路由配置
1. 进入 "端点管理 (Endpoints)"。
2. 创建端点，路径为 `/v1/chat/completions`。
3. **预期**: 创建成功，并自动生成绑定了 `test-api` 子域名的路由条目，但状态处于 "禁用" 且供应商为 "需要配置"。
4. 编辑该路由，选择刚刚创建的供应商和其中的模型。
5. 点击保存。
6. **预期**: 后端校验通过，路由状态变为 "活跃 (Active)"。

### 7. 端到端请求测试
1. 使用 curl 发送测试请求，带上刚才创建的 PromptGate API Key。
   ```bash
   curl http://test-api.localhost:3000/v1/chat/completions \
     -H "Authorization: Bearer pg_YOUR-API-KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-4","messages":[{"role":"user","content":"hello"}]}'
   ```
2. **预期**: 成功代理并返回 mock 响应（200 OK）。

### 8. 测试总结
若以上全部通过，说明 v1.0.0-rc.1 所有 P1 链路已经全部闭环。安全校验（API Key 不泄露、Provider 修改校验、路由矩阵协议匹配校验）均生效。
