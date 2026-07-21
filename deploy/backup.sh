#!/usr/bin/env bash
# =============================================================================
# backup.sh - Backup DB SQLite + .env
# =============================================================================
# Cara pakai:
#   bash deploy/backup.sh
# Cron harian (crontab -e):
#   0 3 * * * /opt/payment-gateway/deploy/backup.sh >> /var/log/pg-backup.log 2>&1
# =============================================================================

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
mkdir -p "$BACKUP_DIR"

# Cari file DB (SQLite). Kalau bukan sqlite, skrip ini tidak berlaku.
DB_URL_RAW="$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' || true)"
if [[ "$DB_URL_RAW" == file:* ]]; then
  DB_FILE="${DB_URL_RAW#file:}"
  # Path relatif -> resolve dari root project
  if [[ "$DB_FILE" != /* ]]; then
    DB_FILE="$APP_DIR/${DB_FILE#./}"
  fi
  if [[ -f "$DB_FILE" ]]; then
    OUT="$BACKUP_DIR/db-$STAMP.sqlite"
    # Pakai .backup command dari sqlite kalau ada, kalau engga copy biasa.
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$DB_FILE" ".backup '$OUT'"
    else
      cp "$DB_FILE" "$OUT"
    fi
    gzip -9 "$OUT"
    echo "[backup] DB -> $OUT.gz"
  else
    echo "[backup] File DB tidak ditemukan: $DB_FILE"
  fi
else
  echo "[backup] DATABASE_URL bukan SQLite, gunakan mysqldump/pg_dump di skrip terpisah."
fi

# Backup .env (terenkripsi opsional; di sini plain, karena sudah 0600).
cp .env "$BACKUP_DIR/env-$STAMP.env"
chmod 600 "$BACKUP_DIR/env-$STAMP.env"
echo "[backup] .env -> $BACKUP_DIR/env-$STAMP.env"

# Rotasi: simpan 14 hari terakhir
find "$BACKUP_DIR" -type f \( -name "db-*.sqlite.gz" -o -name "env-*.env" \) -mtime +14 -delete
echo "[backup] rotasi (>14 hari) selesai."
