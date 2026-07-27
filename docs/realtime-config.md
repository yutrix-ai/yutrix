# PromptGate 实时配置生效机制 (Request-Level Configuration Snapshot)

为了满足高并发下不停机就能无缝切换路由和网关配置的需求，PromptGate 采用了 **请求级快照 (Request-Level Snapshot)** 架构。

## 机制原理

在绝大多数传统的反向代理网关中，配置（如路由表、API Keys）通常会在服务启动时被全量加载到内存中。配置变更需要重启或发信号触发热重载，容易引发竞态。

PromptGate 基于 SQLite（或其它高性能数据库），采用如下流程：

1. **实时拉取快照**: 每一个到达 `/v1/chat/completions` 或 `/v1/messages` 的请求，在进入网关处理程序时，都会同步查询数据库，拉取当前最新的状态（包括 API Key、端点、系统设置等）。
2. **生命周期隔离**: 这些获取到的数据构成了该请求专属的**配置快照 (Snapshot)**。在此请求长达几分钟的流式等待过程中，它完全依赖这份隔离的快照运作。
3. **互不干扰**: 当后台修改了某个 `providers.enabled` 或是 `promptPolicy.content` 时，正在处理中的旧请求依然持有旧快照，平滑输出完毕；而修改完成后发起的新请求，将立即读取到新配置并按新规则执行。

## 验证说明

这种请求级隔离确保了如下操作可实时生效（测试脚本见 `docs/realtime-tests.sh`）：

- **模型动态切换**: 修改路由绑定的 `modelId`，下一次请求即使用新模型。
- **瞬时熔断**: 将 Provider `enabled` 置为 `false`，新请求立即被拒绝。
- **动态策略**: 提示词策略内容变更后，新的对话即立刻套用新注入规则。
- **全局设置即时生效**: 修改如 `allowUnknownHostFallback` 或 `corsAllowlist` 后，新请求的 CORS 预检或 Host 校验立即应用新规则。
