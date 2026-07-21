#!/usr/bin/env bash
# =============================================================================
# update.sh - Update app di VPS
# =============================================================================
# Cara pakai (di root project):
#   bash deploy/update.sh
#
# Yang dikerjakan:
#   1. git pull (kalau folder git)
#   2. npm ci --omit=dev
#   3. prisma migrate deploy
#   4. pm2 reload payment-gateway
# =============================================================================

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

log() { echo -e "\033[1;36m[UPDATE]\033[0m $*"; }

if [[ -d .git ]]; then
  log "git pull..."
  git pull --ff-only
else
  log "Bukan folder git, skip git pull."
fi

log "npm ci..."
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

log "Prisma generate + migrate..."
npx prisma generate
npx prisma migrate deploy

if command -v pm2 >/dev/null 2>&1; then
  log "PM2 reload..."
  pm2 reload payment-gateway
elif systemctl is-active --quiet payment-gateway; then
  log "systemctl restart..."
  sudo systemctl restart payment-gateway
else
  log "Tidak ada PM2 / systemd yang aktif. Restart manual:  node src/server.js"
fi

log "Update selesai."
