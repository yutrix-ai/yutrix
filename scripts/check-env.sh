#!/bin/bash

# A simple script to verify deployment environment before starting the service

echo "=== Yutrix Environment Check ==="

# 1. Check Node
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d 'v' -f2 | cut -d '.' -f1)
  if [ "$NODE_MAJOR" -lt 24 ]; then
    echo "[WARN] 警告：当前 Node.js 版本 ($NODE_VER) 低于推荐版本。Yutrix 生产环境推荐 Node.js 24.16.x LTS。"
  else
    echo "[OK] node is installed: $NODE_VER"
  fi
else
  echo "[FAIL] node is not installed. Please install Node.js."
  exit 1
fi

# 2. Check pnpm
if command -v pnpm >/dev/null 2>&1; then
  echo "[OK] pnpm is installed: $(pnpm -v)"
else
  echo "[FAIL] pnpm is not installed. Please install pnpm."
  exit 1
fi

# 3. Check pm2
if command -v pm2 >/dev/null 2>&1; then
  echo "[OK] pm2 is installed: $(pm2 -v)"
else
  echo "[FAIL] pm2 is not installed. Please install pm2 globally (npm i -g pm2)."
  exit 1
fi

# 4. Check .env exists
if [ -f ".env" ]; then
  echo "[OK] .env file exists."
else
  echo "[FAIL] .env file is missing. Please create it from .env.example."
  exit 1
fi

# 5. Check PROMPTGATE_SECRET
if grep -q "^PROMPTGATE_SECRET=" .env; then
  SECRET_VAL=$(grep "^PROMPTGATE_SECRET=" .env | cut -d '=' -f2)
  if [ -z "$SECRET_VAL" ] || [ "$SECRET_VAL" = "change-me" ]; then
    echo "[FAIL] PROMPTGATE_SECRET is missing or set to default 'change-me' in .env. Please generate one using: openssl rand -hex 32"
    exit 1
  else
    echo "[OK] PROMPTGATE_SECRET is configured."
  fi
else
  echo "[FAIL] PROMPTGATE_SECRET is missing in .env."
  exit 1
fi

# 6. Check PORT occupancy
PORT=$(grep "^PORT=" .env | cut -d '=' -f2)
if [ -z "$PORT" ]; then
  PORT=3000
fi

HOST=$(grep "^HOST=" .env | cut -d '=' -f2)
if [ -z "$HOST" ]; then
  HOST=127.0.0.1
fi

if [ "$HOST" = "0.0.0.0" ]; then
  echo "[WARN] 警告：HOST 配置为 0.0.0.0，这可能会将服务直接暴露给外网。生产部署建议配置 HOST=127.0.0.1 并由 Caddy 等前置反向代理。"
else
  echo "[OK] HOST is configured as $HOST."
fi

echo "Checking if port $PORT is occupied..."
if command -v ss >/dev/null 2>&1; then
  if ss -lntp | grep -q ":$PORT "; then
    echo "[WARN] Port $PORT is currently occupied! Please ensure the old service is stopped, or change PORT in .env."
  else
    echo "[OK] Port $PORT is available."
  fi
elif command -v lsof >/dev/null 2>&1; then
  if lsof -i :$PORT >/dev/null 2>&1; then
    echo "[WARN] Port $PORT is currently occupied! Please ensure the old service is stopped, or change PORT in .env."
  else
    echo "[OK] Port $PORT is available."
  fi
else
  echo "[WARN] Neither 'ss' nor 'lsof' is available, skipping port occupancy check."
fi

echo "=== All checks completed! ==="
echo "If all checks are [OK], you can safely start the server:"
echo "pm2 start ecosystem.config.cjs --update-env"
