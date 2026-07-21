# Panduan Deploy VPS (Payment Gateway)

Dua jalur deploy tersedia:

- **A. Native (Node + PM2 + Nginx)** — paling ringan, cocok untuk 1 VPS kecil.
- **B. Docker Compose** — paling cepat setup, sekali `docker compose up`.

Pilih salah satu. Rekomendasi: **A** kalau VPS 1GB RAM, **B** kalau kamu suka container.

---

## Persiapan Umum

1. **VPS**: Ubuntu 22.04 / 24.04 (Debian 12 juga oke). Minimum 1 GB RAM, 1 vCPU.
2. **Domain**: Point A-record ke IP VPS (mis. `pg.domainkamu.com`).
3. **SSH**: bisa login sebagai root atau user dengan sudo.
4. **Firewall**: pastikan port 22, 80, 443 terbuka.

---

## A. Deploy Native (Node + PM2 + Nginx) — RECOMMENDED

### 1. Upload project ke VPS

Cara paling gampang, via git:

```bash
# di VPS
sudo mkdir -p /opt/payment-gateway
sudo chown $USER:$USER /opt/payment-gateway
cd /opt/payment-gateway
git clone <URL_REPO_KAMU> .
```

Atau via SCP dari komputer lokal:

```bash
# dari komputer lokal
rsync -avz --exclude node_modules --exclude .env --exclude '*.db' \
  ./payment-gateway/ user@ip-vps:/opt/payment-gateway/
```

### 2. Jalankan installer

```bash
cd /opt/payment-gateway
sudo bash deploy/install.sh
```

Yang dikerjakan otomatis:
- Install Node.js 20 LTS
- Install PM2
- Generate `.env` dengan `SESSION_SECRET`, `WEBHOOK_SECRET`, dan `ADMIN_PASSWORD` random
- `npm ci`
- `prisma migrate deploy`
- Seed admin user
- Start PM2 + save + startup (boot otomatis saat reboot)

**PENTING**: Catat `ADMIN_PASSWORD` yang muncul di akhir installer. Kalau lupa, cek `cat /opt/payment-gateway/.env | grep ADMIN_PASSWORD`.

Setelah install selesai, cek:

```bash
pm2 status
pm2 logs payment-gateway --lines 50
curl http://localhost:3000/login   # harus balas HTML login
```

### 3. Setup Nginx + HTTPS

Install nginx & certbot:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

Copy config nginx template:

```bash
sudo cp /opt/payment-gateway/deploy/nginx.conf.example \
        /etc/nginx/sites-available/payment-gateway
sudo sed -i 's/pg.domainkamu.com/DOMAIN_KAMU/g' \
        /etc/nginx/sites-available/payment-gateway
sudo ln -s /etc/nginx/sites-available/payment-gateway /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Sekarang install SSL gratis dari Let's Encrypt:

```bash
sudo certbot --nginx -d pg.domainkamu.com
```

Ikuti prompt. Certbot otomatis akan meng-update nginx config kamu jadi HTTPS + auto-redirect 80→443.

### 4. Update `BASE_URL` di .env

```bash
sudo sed -i 's|BASE_URL=.*|BASE_URL=https://pg.domainkamu.com|' /opt/payment-gateway/.env
pm2 restart payment-gateway
```

### 5. Selesai!

Buka `https://pg.domainkamu.com/login` di browser, login pakai:
- Username: `admin` (dari `.env`)
- Password: nilai `ADMIN_PASSWORD` yang di-generate installer.

Langsung buka **Account → Ganti Password** dan ganti sekarang juga.

---

## B. Deploy dengan Docker Compose

Persyaratan: Docker + Docker Compose plugin sudah ter-install di VPS.

```bash
# Install Docker (Ubuntu):
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # logout-login supaya berlaku
```

### 1. Upload project + siapkan .env

```bash
git clone <URL_REPO_KAMU> /opt/payment-gateway
cd /opt/payment-gateway

# Siapkan .env dari template
cp .env.production .env

# Generate secret (manual, karena installer tidak dipakai)
SECRET1=$(openssl rand -hex 32)
SECRET2=$(openssl rand -hex 32)
PASS=$(openssl rand -base64 12 | tr -d '/=+' | cut -c1-14)
sed -i "s|__CHANGE_ME_SESSION_SECRET__|$SECRET1|" .env
sed -i "s|__CHANGE_ME_WEBHOOK_SECRET__|$SECRET2|" .env
sed -i "s|__CHANGE_ME_ADMIN_PASSWORD__|$PASS|" .env
echo "ADMIN_PASSWORD: $PASS  (catat!)"
chmod 600 .env
```

### 2. Jalankan

```bash
docker compose up -d --build
docker compose logs -f
```

Cek `http://<IP-VPS>:3000/login`.

### 3. HTTPS via Caddy (opsional, otomatis)

Edit `deploy/Caddyfile` — ganti `pg.domainkamu.com` dengan domain kamu. Lalu uncomment blok `caddy:` di `docker-compose.yml`, lalu:

```bash
docker compose up -d --build
```

Caddy akan otomatis ambil sertifikat Let's Encrypt.

---

## Alternatif: systemd (tanpa PM2, tanpa Docker)

```bash
# Setelah npm ci + prisma migrate deploy selesai:
sudo cp /opt/payment-gateway/deploy/payment-gateway.service /etc/systemd/system/
# Edit User/Group/WorkingDirectory bila perlu (default: /opt/payment-gateway, user www-data)
sudo chown -R www-data:www-data /opt/payment-gateway
sudo systemctl daemon-reload
sudo systemctl enable --now payment-gateway
sudo systemctl status payment-gateway
sudo journalctl -u payment-gateway -f
```

---

## Update ke Versi Baru

```bash
cd /opt/payment-gateway
bash deploy/update.sh
```

Skrip akan `git pull`, `npm ci`, `prisma migrate deploy`, dan `pm2 reload`.

## Backup Otomatis

```bash
# Test manual dulu
bash /opt/payment-gateway/deploy/backup.sh

# Jadwalkan tiap hari jam 3 pagi
sudo crontab -e
# Tambahkan baris:
0 3 * * * /opt/payment-gateway/deploy/backup.sh >> /var/log/pg-backup.log 2>&1
```

Backup DB SQLite (gzip) + `.env` disimpan di `/opt/payment-gateway/backups/` dan rotasi otomatis (simpan 14 hari terakhir).

**Rekomendasi**: sync folder backup ini ke object storage (S3/R2/B2) untuk aman.

---

## Troubleshooting

### PM2 tidak start setelah reboot

```bash
pm2 resurrect
pm2 startup   # ikuti perintah yang muncul (biasanya minta systemctl enable pm2-<user>)
pm2 save
```

### Poller tidak deteksi pembayaran

```bash
pm2 logs payment-gateway | grep poller
```

Kalau ada error `provider XXX error: HTTP 401` → berarti `authToken` OrderKuota kedaluwarsa. Login ulang dan update credentials via dashboard **Providers**.

### CRC QRIS tidak valid saat scan

Cek log invoice detail di dashboard. Kalau QRIS string tidak bisa di-scan:
- Pastikan `qrisStatic` di provider adalah **string TLV lengkap** (termasuk `6304XXXX` CRC di ujung).
- Coba scan static QRIS-nya dulu pakai aplikasi lain untuk pastikan valid.

### Webhook tidak sampai ke merchant

Dashboard **Invoices → klik invoice** → lihat **Webhook Logs**. Kolom "Response" akan tunjukkan error dari server merchant.

### Ganti password admin lupa

```bash
cd /opt/payment-gateway
node -e "
const bcrypt=require('bcryptjs');
const p=require('./src/db');
(async()=>{
  await p.user.update({where:{username:'admin'},data:{passwordHash:bcrypt.hashSync('PasswordBaru123',10)}});
  console.log('OK');
  process.exit(0);
})();
"
```

### Reset semua data

```bash
pm2 stop payment-gateway
rm prisma/prod.db
npx prisma migrate deploy
node src/scripts/seed.js
pm2 restart payment-gateway
```

---

## Checklist Keamanan Production

- [x] `SESSION_SECRET` & `WEBHOOK_SECRET` di-generate acak (installer sudah otomatis).
- [x] File `.env` permission 600 (installer sudah set).
- [ ] Password admin default sudah diganti setelah login pertama.
- [ ] HTTPS aktif (Let's Encrypt / Caddy).
- [ ] Firewall UFW aktif, port 3000 **tidak** expose langsung ke publik (hanya via nginx).
- [ ] Backup otomatis harian sudah di-cron.
- [ ] Log rotasi (PM2 sudah rotate default 10MB × 5 file).
- [ ] Rate limit nginx aktif untuk `/api/*`.
- [ ] Update OS berkala: `sudo apt update && sudo apt upgrade -y`.

Selamat deploy 🚀
