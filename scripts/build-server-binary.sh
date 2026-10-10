#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Build the standalone single-binary SERVER distribution:
# one binary serving the API + embedded web UI. No Node/Bun/Docker needed
# to RUN it (Bun is only needed to BUILD it).
#
# Usage:  bash scripts/build-server-binary.sh [--target bun-linux-x64]
# Output: dist/mvp-server[-<target>]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="bun-linux-x64"
# Accept both "--target X" and bare "X".
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-bun-linux-x64}"; shift 2 ;;
    --target=*) TARGET="${1#--target=}"; shift ;;
    *) TARGET="$1"; shift ;;
  esac
done
OUT="$ROOT/dist/mvp-server"

echo "==> building workspace (web UI first, then API with embedded assets)"
npm run build --prefix "$ROOT"

echo "==> compiling single binary for $TARGET"
mkdir -p "$ROOT/dist"
bun build --compile --target="$TARGET" "$ROOT/apps/api/src/index.ts" --outfile "$OUT"

echo "DONE: $OUT"
echo "Run:  PORT=4000 GROQ_API_KEY=... ./$(basename "$OUT")"
echo "Then open http://localhost:4000 in a browser."
