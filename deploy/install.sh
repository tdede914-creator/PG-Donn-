#!/usr/bin/env bash
# =============================================================================
# Payment Gateway - VPS Auto Installer
# =============================================================================
# Support: Ubuntu 20.04 / 22.04 / 24.04, Debian 11 / 12
# Untuk Rocky/Alma/CentOS: ganti apt-get -> dnf, paket setara.
#
# Cara pakai (dari root project):
#   sudo bash deploy/install.sh
#
# Yang dikerjakan skrip ini:
#   1. Install dependency OS (build-essential, git, curl, openssl)
#   2. Install Node.js 20 LTS via NodeSource
#   3. Install PM2 global
#   4. Buat file .env dari template + generate SESSION_SECRET & WEBHOOK_SECRET
#   5. npm ci (atau npm install)
#   6. Prisma generate + migrate deploy
#   7. Seed admin
#   8. pm2 start ecosystem.config.js + pm2 save + pm2 startup
# =============================================================================

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

log()  { echo -e "\033[1;36m[INSTALL]\033[0m $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m $*"; }
err()  { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; }

if [[ "$EUID" -ne 0 ]]; then
  err "Jalankan dengan sudo/root: sudo bash deploy/install.sh"
  exit 1
fi

log "APP_DIR = $APP_DIR"

# -----------------------------------------------------------------------------
# 1) OS dependencies
# -----------------------------------------------------------------------------
log "Update apt + install dependency dasar..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg build-essential git openssl ufw

# -----------------------------------------------------------------------------
# 2) Node.js 20 LTS via NodeSource
# -----------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 18 ]]; then
  log "Install Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  log "Node.js sudah terpasang: $(node -v)"
fi

# -----------------------------------------------------------------------------
# 3) PM2 global
# -----------------------------------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  log "Install PM2..."
  npm install -g pm2
else
  log "PM2 sudah terpasang: $(pm2 -v)"
fi

# -----------------------------------------------------------------------------
# 4) .env
# -----------------------------------------------------------------------------
if [[ ! -f .env ]]; then
  log "Buat .env dari template dengan secret auto-generate..."
  if [[ ! -f .env.production ]]; then
    err "File .env.production tidak ditemukan di root project."
    exit 1
  fi
  cp .env.production .env
  SESSION_SECRET_VAL="$(openssl rand -hex 32)"
  WEBHOOK_SECRET_VAL="$(openssl rand -hex 32)"
  ADMIN_PASSWORD_VAL="$(openssl rand -base64 18 | tr -d '/=+' | cut -c1-16)"
  # Portable sed (works on GNU + BSD)
  sed -i.bak \
    -e "s|__CHANGE_ME_SESSION_SECRET__|${SESSION_SECRET_VAL}|" \
    -e "s|__CHANGE_ME_WEBHOOK_SECRET__|${WEBHOOK_SECRET_VAL}|" \
    -e "s|__CHANGE_ME_ADMIN_PASSWORD__|${ADMIN_PASSWORD_VAL}|" \
    .env
  rm -f .env.bak
  chmod 600 .env
  log "Admin password ter-generate: ${ADMIN_PASSWORD_VAL}"
  log "Catat sekarang! Bisa dilihat juga di file .env."
else
  warn ".env sudah ada, skip generate. Pastikan SESSION_SECRET & WEBHOOK_SECRET sudah di-set."
fi

# -----------------------------------------------------------------------------
# 5) Install dependencies
# -----------------------------------------------------------------------------
log "npm install..."
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
# Prisma CLI dibutuhkan untuk migrate; install sebagai dev dep terpisah kalau perlu.
if ! npx --no prisma --version >/dev/null 2>&1; then
  npm install --no-save prisma@5 --no-audit --no-fund
fi

# -----------------------------------------------------------------------------
# 6) Prisma migrate + generate
# -----------------------------------------------------------------------------
log "Prisma generate..."
npx prisma generate

log "Prisma migrate deploy..."
# Kalau belum ada migration folder, buat init pertama
if [[ ! -d prisma/migrations ]]; then
  log "Belum ada migration, membuat migration awal..."
  npx prisma migrate dev --name init --skip-seed --create-only
fi
npx prisma migrate deploy

# -----------------------------------------------------------------------------
# 7) Seed admin
# -----------------------------------------------------------------------------
log "Seed admin user..."
node src/scripts/seed.js || warn "Seed gagal / admin sudah ada."

# -----------------------------------------------------------------------------
# 8) PM2
# -----------------------------------------------------------------------------
log "Start PM2..."
pm2 start ecosystem.config.js --update-env
pm2 save
# Setup PM2 startup untuk boot otomatis
pm2 startup systemd -u "${SUDO_USER:-root}" --hp "$(eval echo ~${SUDO_USER:-root})" || true

log "==================================================================="
log "Selesai. Cek status: pm2 status"
log "Log real-time         : pm2 logs payment-gateway"
log "Restart               : pm2 restart payment-gateway"
log "URL default           : http://<IP-VPS>:$(grep '^PORT=' .env | cut -d= -f2 || echo 3000)"
log ""
log "Selanjutnya:"
log "  1. Setup nginx + HTTPS -> lihat deploy/nginx.conf.example"
log "  2. Buka firewall port 80/443 -> ufw allow 'Nginx Full'"
log "  3. Login admin dengan kredensial dari .env"
log "==================================================================="
