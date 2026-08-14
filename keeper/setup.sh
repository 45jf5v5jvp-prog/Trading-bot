#!/usr/bin/env bash
# One-command setup for the keeper server. Run from inside the keeper/ folder:
#   bash setup.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Installing dependencies (this compiles better-sqlite3, give it a minute)"
npm install

echo "==> Building"
npm run build

if [ ! -f .env ]; then
  echo "!! No .env found. Copy .env.filled to .env and paste the keeper private key, then re-run."
  exit 1
fi
if [ ! -f config.json ]; then
  echo "!! No config.json found. Copy config.example.json to config.json and set your vault + rules, then re-run."
  exit 1
fi

echo "==> Preflight (doctor)"
if npm run doctor; then
  echo ""
  echo "All checks passed. Start the keeper with:"
  echo "    pm2 start ecosystem.config.cjs"
  echo "    pm2 logs icaria-keeper"
else
  echo ""
  echo "Doctor reported problems above. Fix them before starting. Do NOT go live until every check is ok."
  exit 1
fi
