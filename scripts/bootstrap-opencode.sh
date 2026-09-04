#!/bin/bash
# Install the OpenCode CLI binary for this machine / Docker TARGETARCH.
# Docker Buildx sets TARGETARCH to amd64 or arm64; local runs fall back to uname -m.
# Never hardcode amd64-only. Unsupported arches fail loudly.
set -euo pipefail

resolve_pkg() {
  local ARCH="${1:-${TARGETARCH:-$(uname -m)}}"
  case "$ARCH" in
    x86_64|amd64)
      echo "opencode-linux-x64"
      ;;
    aarch64|arm64)
      echo "opencode-linux-arm64"
      ;;
    *)
      echo "Unsupported arch: ${ARCH} (supported: amd64/x86_64 → opencode-linux-x64, arm64/aarch64 → opencode-linux-arm64)" >&2
      exit 1
      ;;
  esac
}

if [ "${1:-}" = "--print-pkg" ]; then
  resolve_pkg "${2:-}"
  exit 0
fi

# Honor HTTP(S)_PROXY already in the environment (admin download proxy / Docker build).
if [ -n "${HTTPS_PROXY:-${HTTP_PROXY:-}}" ]; then
  echo "Using download proxy: ${HTTPS_PROXY:-$HTTP_PROXY}"
fi

mkdir -p .vendor/opencode/bin
cd .vendor/opencode

PKG="$(resolve_pkg)"
echo "Bootstrapping OpenCode ($PKG)..."

npm init -y >/dev/null 2>&1 || true
npm install --no-save "$PKG"

TARGET="$(pwd)/node_modules/${PKG}/bin/opencode"
if [ ! -f "$TARGET" ]; then
  echo "OpenCode binary missing after install: $TARGET" >&2
  exit 1
fi
if [ ! -x "$TARGET" ]; then
  chmod +x "$TARGET" || true
fi
if [ ! -x "$TARGET" ]; then
  echo "OpenCode binary is not executable: $TARGET" >&2
  exit 1
fi

ln -sfn "$TARGET" bin/opencode

LINK_DEST="$(readlink bin/opencode || true)"
if [ "$LINK_DEST" != "$TARGET" ]; then
  echo "OpenCode symlink did not point at the real binary (expected $TARGET, got ${LINK_DEST:-missing})" >&2
  exit 1
fi

echo "OpenCode installed at .vendor/opencode/bin/opencode -> $TARGET"
