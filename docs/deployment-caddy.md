# Caddy 并行部署指南

如果您的服务器上已经运行了旧服务（例如占用了 3000 端口的 AnthroGate），您可以按照以下指南将 PromptGate 并行部署在 3001 端口，并通过 Caddy 反向代理提供服务。

## 部署步骤

### 0. 环境准备

**PromptGate 生产环境推荐 Node.js 24.16.x LTS。** (注意：Node 18 不作为生产推荐版本)
确保您的服务器已经安装了 Node.js 24 及其以上的 LTS 版本。

### 1. 创建环境变量文件

确保创建正确的数据和日志目录，然后生成 `.env` 文件：

```bash
mkdir -p /opt/promptgate/data /opt/promptgate/logs

cat > /opt/promptgate/.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
DB_FILE=/opt/promptgate/data/promptgate.sqlite
PROMPTGATE_SECRET=$(openssl rand -hex 32)
LOG_LEVEL=info
EOF
```

> **注意：** `PROMPTGATE_SECRET` 必须安全保管。它是用于加密数据库中各种敏感凭据的密钥。

### 2. 构建项目

在项目根目录下安装依赖并进行编译：

```bash
pnpm install
pnpm build
```

### 3. 启动服务

使用 PM2 启动项目并应用环境变量：

```bash
pm2 start ecosystem.config.cjs --update-env
pm2 logs promptgate-server
```

### 4. 检查端口与服务状态

验证 PromptGate 是否成功监听了 3001 端口：

```bash
ss -lntp | grep 3001
curl -I http://127.0.0.1:3001
```

### 5. Caddy 配置示例

如果您使用 Caddy 作为前端反向代理，可以参考下面的配置：

```caddyfile
pg.example.com, *.pg.example.com {
    encode gzip zstd
    reverse_proxy 127.0.0.1:3001 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

**关键说明：**
- **必须保留 Host Header**：Caddy 必须包含 `header_up Host {host}`，因为 PromptGate 完全依赖 Host 来进行网关级的路由匹配和子域名解析。
- **无需前后端分离域名**：不需要为前端和后端单独拆分域名，推荐使用主域名加上泛解析通配符（如 `pg.example.com` 和 `*.pg.example.com`）即可应对不同租户的子域名请求。
- **本地监听**：PromptGate 本身只需监听 `127.0.0.1` 保证内网安全，由 Caddy 在前端自动处理 HTTPS。
