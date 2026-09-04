#!/bin/bash
set -e

mkdir -p .vendor/opencode/bin
cd .vendor/opencode

ARCH=${TARGETARCH:-$(uname -m)}
if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
  PKG="opencode-linux-x64"
elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  PKG="opencode-linux-arm64"
else
  echo "Unsupported arch: $ARCH"
  exit 1
fi

echo "Bootstrapping OpenCode ($PKG)..."
npm init -y > /dev/null 2>&1 || true
npm install --no-save $PKG
ln -sf ../node_modules/$PKG/bin/opencode bin/opencode
echo "OpenCode installed at .vendor/opencode/bin/opencode"
