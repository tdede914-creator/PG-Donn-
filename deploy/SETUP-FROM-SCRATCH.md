# 🚀 Setup Payment Gateway dari NOL — Panduan Lengkap

Panduan ini untuk **install ulang** aplikasi payment gateway di VPS baru,
misal kamu pindah dari VPS A ke VPS B, atau reset instalasi lama.

Bisa ikutin ini kalau kamu **lupa cara install**, atau HP kamu doang tanpa
laptop.

---

## 📋 Yang Kamu Butuhkan

### Software di HP Android:
- **Termius** (Play Store, gratis) — buat SSH ke VPS
- Browser apapun (Chrome/Firefox/dll) — buat buka dashboard

### VPS:
- **Ubuntu 22.04 atau 24.04** (Debian 12 juga oke) — Server yang bersih baru
- Minimum **1 GB RAM**, 1 vCPU
- **Provider Indonesia direkomendasikan** (Biznet Gio / Niagahoster / IDCloudHost / Cloudmatika) — biar OrderKuota API ga blokir
- Port yang butuh dibuka: **22** (SSH) + **3000** (aplikasi) + **80/443** (kalau pakai domain nanti)

### Info yang harus dikumpulin dulu:
- ✅ **IP Address VPS** (format `xxx.xxx.xxx.xxx`)
- ✅ **Password root VPS** (dari email provider VPS)
- ✅ **Password OrderKuota** kamu (untuk setup provider nanti)
- ✅ **Username / no HP OrderKuota** kamu

---

## 🛣️ 3 Cara Setup — Pilih Salah Satu

| Cara | Kapan Dipakai | Butuh |
|---|---|---|
| **A. Git Clone** | Repo online + kamu tau URL-nya | Internet di VPS |
| **B. Download ZIP di VPS** | Kalau ga mau install git, atau backup file | Internet di VPS |
| **C. Upload Manual dari HP** | Repo down / offline / private | Termius Pro atau app SFTP |

**REKOMENDASI: Cara A** untuk update mudah nanti (`git pull` aja).

---

## 🅰️ Cara A: Git Clone (Recommended)

Buka **Termius** → connect ke VPS.

Copy-paste command ini semua sekaligus:

```bash
apt update && apt install -y git curl && \
git clone https://github.com/tdede914-creator/PG-Donn-.git /opt/payment-gateway && \
cd /opt/payment-gateway && \
echo "✅ Repo cloned, next: buat .env"
```

Lanjut ke [**Bagian 4: Setup .env**](#-bagian-4-setup-env-wajib).

---

## 🅱️ Cara B: Download ZIP di VPS (No Git)

Kalau kamu ga mau install git, atau butuh source code offline:

```bash
apt update && apt install -y wget unzip && \
cd /opt && \
wget https://github.com/tdede914-creator/PG-Donn-/archive/refs/heads/main.zip -O pg.zip && \
unzip pg.zip && \
mv PG-Donn--main payment-gateway && \
rm pg.zip && \
cd payment-gateway && \
echo "✅ Extracted, next: buat .env"
```

Kalau repo GitHub down, download ZIP dari HP → upload via **Cara C**.

Lanjut ke [**Bagian 4: Setup .env**](#-bagian-4-setup-env-wajib).

---

## 🅾️ Cara C: Upload Folder Manual dari HP

### Langkah 1: Download ZIP di HP

Buka Chrome/Firefox di HP, buka URL ini (auto-download ZIP):

```
https://github.com/tdede914-creator/PG-Donn-/archive/refs/heads/main.zip
```

File `PG-Donn--main.zip` masuk folder **Downloads** HP kamu (biasanya ~60-80 KB).

### Langkah 2: Upload ZIP dari HP ke VPS

Ada 2 sub-cara:

#### Sub-cara C1: Pakai Termius (paling gampang, Pro required)

1. Di Termius → tap-hold host VPS kamu → pilih **"SFTP"**
2. Navigate ke `/root/`
3. Tap tombol **"Upload"** (icon panah atas)
4. Pilih file `PG-Donn--main.zip` dari Downloads HP kamu
5. Tunggu selesai upload

#### Sub-cara C2: Pakai app SFTP gratis (kalau Termius Pro ga aktif)

1. Install **"AndFTP"** atau **"Turbo FTP"** dari Play Store (gratis)
2. Bikin connection baru: SFTP, host = IP VPS, port 22, user root, password
3. Navigate ke `/root/` di sisi VPS
4. Upload `PG-Donn--main.zip` dari Downloads HP

#### Sub-cara C3: Web upload sekali pakai (super gampang, no app)

Di **Termius** connect ke VPS, jalankan:

```bash
apt install -y python3 && cd /root && python3 -m http.server 8000 &
echo "SERVER JALAN. Buka di browser HP: http://IP-VPS-KAMU:8000"
```

Terus dari **Chrome HP**, buka `http://IP-VPS-KAMU:8000` — muncul file listing kosong. Tapi ini cara terbalik: kita butuh upload, bukan download.

Skip sub-cara ini, pakai C1 atau C2 aja.

### Langkah 3: Extract di VPS

Setelah ZIP ke-upload ke `/root/`, di Termius:

```bash
apt install -y unzip && \
cd /opt && \
unzip /root/PG-Donn--main.zip && \
mv PG-Donn--main payment-gateway && \
rm /root/PG-Donn--main.zip && \
cd payment-gateway && \
echo "✅ Extracted, next: buat .env"
```

Lanjut ke [**Bagian 4: Setup .env**](#-bagian-4-setup-env-wajib).

---

## 📝 Bagian 4: Setup .env (Wajib)

Di Termius (masih di dalam folder `/opt/payment-gateway`):

```bash
nano .env
```

Layar berubah jadi text editor kosong. Paste blok ini:

```env
PORT=3000
NODE_ENV=production
BASE_URL=http://IP-VPS-KAMU:3000
SESSION_SECRET=GANTI_DENGAN_STRING_ACAK_64_KARAKTER_HEXADECIMAL_UNTUK_KEAMANAN_SESSION
WEBHOOK_SECRET=GANTI_DENGAN_STRING_ACAK_64_KARAKTER_HEXADECIMAL_UNTUK_SIGN_WEBHOOK
DATABASE_URL="file:./prod.db"
ADMIN_USERNAME=admin
ADMIN_PASSWORD=GantiPasswordAdmin123
POLLER_INTERVAL_SECONDS=10
INVOICE_EXPIRE_MINUTES=15
EMBED_POLLER=true
```

Yang wajib diganti:
- `IP-VPS-KAMU` → **IP asli VPS kamu** (mis. `103.93.132.217`)
- `SESSION_SECRET` → string acak, 64+ karakter. Generate cepat:
- `WEBHOOK_SECRET` → string acak lain, 64+ karakter
- `ADMIN_PASSWORD` → password buat login dashboard admin. **Catat!**

**Cara generate secret acak** (di Termius terpisah, atau di komputer):
```bash
openssl rand -hex 32
```

Atau pakai website: https://randomkeygen.com/ pilih "CodeIgniter Encryption Keys".

Save file di nano:
- Tekan **Ctrl+O** → **Enter**
- Tekan **Ctrl+X**

Kunci permission:
```bash
chmod 600 .env
```

---

## ⚙️ Bagian 5: Jalankan Installer Otomatis

```bash
cd /opt/payment-gateway
bash deploy/install.sh
```

Installer akan:
- ✅ Install Node.js 20 LTS (WAJIB versi 20+ — bukan 18)
- ✅ Install PM2 (process manager)
- ✅ `npm install` (semua dependencies)
- ✅ `prisma migrate deploy` (bikin database SQLite)
- ✅ Seed admin user
- ✅ Start via PM2 + save + auto-start saat VPS reboot

Tunggu **5-10 menit**. Kalau sukses, muncul:
```
[INSTALL] Selesai. Cek status: pm2 status
```

### Verifikasi:
```bash
pm2 status
```

Kolom `status` **harus** `online` (hijau).

Kalau `errored` atau `stopped`:
```bash
pm2 logs payment-gateway --lines 30
```
Screenshot log-nya kirim ke saya.

---

## 🔥 Bagian 6: Buka Firewall

### 6.1 UFW (Firewall Ubuntu):
```bash
ufw allow 22/tcp && \
ufw allow 3000/tcp && \
echo "y" | ufw enable
```

### 6.2 Firewall Provider VPS (SANGAT PENTING):
Banyak provider VPS punya firewall tersendiri di dashboard mereka (di luar UFW).
Kamu **wajib** buka port 3000 di sana juga. Contoh:

**Biznet Gio Cloud:**
- Login `portal.biznetgio.com` → NEO Virtual Compute → pilih VPS → tab **Firewall / Security Group**
- Add Rule: TCP, Port 3000, Source 0.0.0.0/0, Allow

**Vultr / DigitalOcean / Contabo / Niagahoster:**
- Biasanya ga ada firewall tambahan, UFW udah cukup.

**Tencent Cloud / Alibaba Cloud / AWS:**
- WAJIB open port 3000 di Security Group cloud provider.

### 6.3 Cek IP:
```bash
curl -s ifconfig.me
```

Catat IP-nya.

---

## 🎯 Bagian 7: Login Dashboard

Buka browser HP → address bar:
```
http://IP-VPS-KAMU:3000/login
```

Login pakai:
- Username: `admin`
- Password: yang kamu set di `.env` tadi

Kalau masuk = **sukses install!** 🎉

Kalau ga bisa dibuka:
1. Cek `pm2 status` = online?
2. Cek `ss -tlnp | grep :3000` = app listen di port 3000?
3. Cek `curl -I http://localhost:3000/login` dari VPS = HTTP 200?
4. Kalau semua OK tapi browser HP masih ga bisa → firewall provider VPS belum kebuka.

---

## 🔌 Bagian 8: Setup Provider OrderKuota (via OTP)

Di dashboard, klik menu **Providers** → isi form:

- **Nama**: `OrderKuota` (bebas)
- **Type**: **OrderKuota (login pakai OTP - seperti JAGOPAY)**
- Panel biru muncul:
  - **Username / No HP**: `xxdonn` atau `08xxxxxxxxxx` (username OK kamu)
  - **Password**: password OK kamu
  - Klik **📧 Kirim OTP ke Email**
- Cek email → dapat OTP 6 digit → paste → **✅ Verify OTP**
- Credentials JSON auto-terisi

Lalu isi **Static QRIS String** (QRIS statis merchant kamu, dimulai `00020101...`)

Klik **🔌 Test connection dulu** → harusnya muncul sample mutasi.

Klik **Simpan**.

---

## 🔑 Bagian 9: Bikin API Key untuk Bot

Menu **API Keys** → isi label `Bot Telegram` → **Buat API Key**

**Catat** API key + secret yang muncul (secret cuma tampil sekali).

Sekarang bot kamu bisa call:
```
POST http://IP-VPS-KAMU:3000/api/v1/invoices
Header: X-API-Key: pk_...
Body: { "amount": 15000, "callback_url": "https://bot-kamu.com/webhook/pg" }
```

Lihat panduan integrasi bot lengkap di [README.md](../README.md).

---

## 📝 Ringkasan Perintah Sehari-hari

| Aksi | Perintah |
|---|---|
| Cek status app | `pm2 status` |
| Lihat log real-time | `pm2 logs payment-gateway` |
| Restart app | `pm2 restart payment-gateway` |
| Update ke versi baru | `cd /opt/payment-gateway && git pull && npm install && pm2 restart payment-gateway` |
| Backup DB manual | `cp /opt/payment-gateway/prod.db /root/backup-$(date +%F).db` |
| Cek IP VPS | `curl -s ifconfig.me` |

---

## 🆘 Troubleshooting

### App status `errored` / crash-looping

```bash
pm2 logs payment-gateway --lines 50
```

**Kalau muncul `ReferenceError: File is not defined`** → Node.js kamu masih v18. Upgrade:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
cd /opt/payment-gateway && rm -rf node_modules package-lock.json && npm install
pm2 restart payment-gateway
```

### Dashboard ga bisa dibuka di browser HP

Diagnosa:
```bash
pm2 status
ss -tlnp | grep :3000
curl -I http://localhost:3000/login
```

Kalau `pm2 status` online + curl 200 OK tapi browser HP masih refused → **firewall provider VPS belum buka port 3000** (bukan UFW).

### OrderKuota "User tidak ditemukan"

Field `authUsername` salah. Login ulang dari menu Providers, credentials auto-refresh.

### OrderKuota HTTP 469 "Gunakan Jaringan Internet Lainnya"

IP VPS kamu diblokir OrderKuota. Pindah ke VPS provider Indonesia lain (Biznet / Niagahoster / IDCloudHost).

### Lupa password admin

```bash
cd /opt/payment-gateway
node -e "
const bcrypt = require('bcryptjs');
const prisma = require('./src/db');
(async () => {
  await prisma.user.update({
    where: { username: 'admin' },
    data: { passwordHash: bcrypt.hashSync('PasswordBaru123', 10) }
  });
  console.log('OK - password reset ke: PasswordBaru123');
  await prisma.\$disconnect();
})();
"
```

Login ulang, ganti password via menu Account.

### PM2 hilang setelah reboot VPS

```bash
pm2 resurrect
pm2 startup   # ikutin perintah yang muncul
pm2 save
```

---

## 🔄 Kalau Ganti VPS

Backup dulu di VPS lama:
```bash
cp /opt/payment-gateway/prod.db /root/backup-prod.db
scp /root/backup-prod.db user@VPS-BARU:/root/
```

Di VPS baru:
1. Ikutin Bagian 1-6 di panduan ini
2. Sebelum start PM2, restore DB:
   ```bash
   cp /root/backup-prod.db /opt/payment-gateway/prod.db
   ```
3. Lanjut Bagian 7 (login dashboard)

Semua provider, invoice history, API key kebawa dari VPS lama. 🎯

---

**Semoga sukses!** Kalau mentok di step manapun, screenshot layar HP + output Termius, kirim ke chat. 🙏
