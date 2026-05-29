#!/usr/bin/env bash
set -euo pipefail

echo "[postCreate] Verifying Bun installation..."
bun --version

echo "[postCreate] Verifying tmux availability..."
tmux -V

if [ -f package.json ]; then
  echo "[postCreate] Installing dependencies..."
  bun install --frozen-lockfile
fi

echo "[postCreate] Done."
