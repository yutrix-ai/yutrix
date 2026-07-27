#!/bin/bash

# Exit on error
set -e

echo "====================================="
echo "  PromptGate Auto Update Script"
echo "====================================="

echo "[1/4] Fetching latest code from git..."
git fetch
git reset --hard origin/main
git pull

echo "[2/4] Cleaning up old build artifacts..."
rm -rf apps/server/dist
rm -rf apps/web/dist
echo "Cleaned old dist directories."

echo "[3/4] Installing dependencies and building..."
pnpm install
pnpm -r build

echo "[4/4] Restarting PM2 services..."
pm2 restart all

echo "====================================="
echo "  Update completed successfully!"
echo "====================================="
