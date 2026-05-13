#!/usr/bin/env bash
# Cross-platform peer of start.bat. macOS / Linux dev quick-start.
# See README.md for full setup. Ctrl+C stops all three services.

set -e
cd "$(dirname "$0")"

echo "============================================================"
echo " PostDash dev environment"
echo "============================================================"
echo

if ! command -v pnpm > /dev/null 2>&1; then
  echo "[ERROR] pnpm not found in PATH."
  echo "Install: npm install -g pnpm@9"
  exit 1
fi

if [ ! -f .env ]; then
  echo "[ERROR] .env not found."
  echo "Run: cp .env.example .env"
  echo "Then fill DATABASE_URL with your Neon connection string."
  exit 1
fi

if [ ! -f node_modules/.modules.yaml ]; then
  echo "[INFO] node_modules missing or incomplete. Running pnpm install..."
  pnpm install
fi

echo
echo "[STEP 1/2] Applying DB migrations..."
pnpm db:migrate

echo
echo "[STEP 2/2] Starting api + worker + miniapp..."
echo "Press Ctrl+C to stop all."
echo
pnpm dev
