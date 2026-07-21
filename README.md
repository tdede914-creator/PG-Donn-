# Payment Gateway (QRIS - DANA Bisnis / OrderKuota)

Self-hosted payment gateway pribadi. Generate QRIS dinamis dari akun DANA Bisnis
atau OrderKuota kamu sendiri, lalu polling mutasi untuk auto-detect pembayaran.
Dilengkapi dashboard admin, REST API, halaman pembayaran publik, dan webhook
signed HMAC-SHA256.

> **Catatan**: Ini dibuat untuk penggunaan pribadi/bisnis kamu sendiri. Menjual
> kembali sebagai layanan payment gateway ke pihak lain di Indonesia masuk
> ranah regulasi Bank Indonesia (PJP). Pastikan compliance sebelum monetize.

---

## Fitur

- Multi-provider: **OrderKuota** dan **DANA Bisnis** (mudah ditambah adapter baru).
- Generate **QRIS dinamis** dari static QRIS (parser TLV + CRC16 CCITT-FALSE).
- **Unique code** 1–999 rupiah untuk membedakan invoice dengan nominal sama.
- Poller mutasi otomatis (default 10 detik) dengan dedup.
- Halaman pembayaran publik + auto-refresh status.
- **REST API** dengan API key (X-API-Key) untuk merchant/aplikasi kamu.
- **Webhook** signed HMAC-SHA256 + retry 3x.
- Dashboard admin: statistik, riwayat, provider config, API key management.
- Database SQLite (via Prisma). Bisa switch ke MySQL/PostgreSQL dengan mengubah `provider` di `prisma/schema.prisma`.

---

## Struktur Project

```
payment-gateway/
├── prisma/schema.prisma           # Schema DB
├── src/
│   ├── server.js                  # Entry Express
│   ├── config.js                  # Config dari .env
│   ├── db.js                      # Prisma client
│   ├── middleware/
│   │   ├── auth.js                # Session auth
│   │   └── apikey.js              # X-API-Key
│   ├── routes/
│   │   ├── auth.js                # Login / logout
│   │   ├── dashboard.js           # Halaman admin
│   │   ├── pay.js                 # /pay/:ref
│   │   └── api.js                 # /api/v1/*
│   ├── services/
│   │   ├── qris.js                # Parser + CRC16 + generator
│   │   ├── invoice.js             # Buat invoice + unique code
│   │   ├── matcher.js             # Cocokkan mutasi ke invoice
│   │   └── webhook.js             # Kirim webhook signed
│   ├── providers/
│   │   ├── index.js               # Registry
│   │   ├── orderkuota.js          # Adapter OrderKuota
│   │   └── danabisnis.js          # Adapter DANA Bisnis
│   ├── workers/poller.js          # Cron poller
│   ├── scripts/seed.js            # Seed admin
│   └── views/*.ejs                # Halaman EJS + Tailwind (CDN)
├── package.json
├── .env.example
└── README.md
```

---

## Setup

Butuh **Node.js >= 18**.

```bash
# 1. Install dependencies
cd payment-gateway
npm install

# 2. Setup env
cp .env.example .env
# edit .env: SESSION_SECRET, WEBHOOK_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD, BASE_URL

# 3. Migrate DB (SQLite)
npm run prisma:generate
npm run prisma:migrate

# 4. Seed admin awal
npm run db:seed

# 5. Jalankan
npm start
# atau mode dev (auto reload)
npm run dev
```

Buka `http://localhost:3000/login` dan login dengan kredensial dari `.env`.

---

## Konfigurasi Provider

Setelah login, buka **Providers → Tambah**.

### OrderKuota

- **Type**: `orderkuota`
- **Static QRIS**: string QRIS statis merchant kamu (bisa didapat dari aplikasi OrderKuota atau decode gambar QR statis).
- **Credentials (JSON)**:

```json
{
  "authToken": "TOKEN_AUTH_ORDERKUOTA",
  "authUsername": "USERNAME_OK",
  "endpoint": "https://app.orderkuota.com/api/v2/get/qris_history",
  "method": "POST"
}
```

Cara dapat `authToken`: login ke aplikasi OrderKuota, sniff request `qris_history`
dari aplikasi mobile (proxy tools seperti HTTP Toolkit). Endpoint bisa berubah;
lihat komentar di `src/providers/orderkuota.js` untuk penyesuaian.

### DANA Bisnis

- **Type**: `dana_bisnis`
- **Static QRIS**: static QRIS merchant DANA Bisnis-mu.
- **Credentials (JSON)**:

```json
{
  "endpoint": "https://api-partner.dana.id/v1/merchant/transaction/history",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer XXX",
    "X-Signature": "XXX"
  },
  "body": {
    "startDate": "AUTO_TODAY",
    "endDate":   "AUTO_TODAY"
  },
  "resultsPath": "data.transactions"
}
```

- Nilai `AUTO_TODAY` otomatis diganti tanggal hari ini (YYYY-MM-DD).
- `resultsPath` = path dot-notation ke array transaksi di response.
- Untuk merchant DANA Bisnis resmi, gunakan endpoint & signature partner API.
- Untuk pemakaian personal, session token dari dashboard bisnis bisa dipakai (rentan berubah).

---

## REST API

Base: `{BASE_URL}/api/v1`. Auth: header `X-API-Key: pk_...`.

### POST `/invoices` — buat invoice

Request:
```json
{
  "amount": 15000,
  "provider_id": 1,
  "merchant_ref": "ORDER-123",
  "description": "Top-up 15rb",
  "callback_url": "https://myshop.com/webhook/pg"
}
```

`provider_id` opsional; kalau kosong akan pakai provider aktif pertama.

Response:
```json
{
  "reference": "INV-XXXXXXXXXX",
  "merchant_ref": "ORDER-123",
  "amount": 15000,
  "unique_code": 342,
  "total_amount": 15342,
  "status": "PENDING",
  "qris_string": "00020101021226...",
  "qris_image": "data:image/png;base64,....",
  "expired_at": "2026-07-21T09:15:00.000Z",
  "pay_url": "http://localhost:3000/pay/INV-XXXXXXXXXX"
}
```

### GET `/invoices/:reference` — cek status

```json
{
  "reference": "INV-XXXXXXXXXX",
  "status": "PAID",
  "paid_at": "2026-07-21T09:03:12.000Z",
  ...
}
```

### POST `/invoices/:reference/cancel` — batalkan (hanya PENDING)

---

## Webhook

Ketika invoice berubah ke `PAID`, sistem POST ke `callback_url` (jika di-set):

Headers:
- `Content-Type: application/json`
- `X-Event: invoice.paid`
- `X-Signature: <HMAC-SHA256(body, apiKey.secret)>`

Body:
```json
{
  "event": "invoice.paid",
  "reference": "INV-XXXXXXXXXX",
  "merchantRef": "ORDER-123",
  "amount": 15000,
  "uniqueCode": 342,
  "totalAmount": 15342,
  "status": "PAID",
  "paidAt": "2026-07-21T09:03:12.000Z",
  "providerType": "orderkuota"
}
```

Verifikasi di sisi merchant (Node.js):
```js
const crypto = require('crypto');
const expected = crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
if (expected !== req.header('X-Signature')) return res.status(401).end();
```

Retry: 3x dengan jeda 2 detik jika non-2xx. Log tersimpan di dashboard invoice.

---

## Poller

Berjalan embedded bersama server (default). Interval diatur di `.env`
(`POLLER_INTERVAL_SECONDS`, minimum 5). Untuk deploy skala lebih besar,
matikan embed dengan `EMBED_POLLER=false` dan jalankan terpisah:

```bash
npm run poller
```

---

## Pindah ke MySQL / PostgreSQL

Di `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "mysql"        // atau "postgresql"
  url      = env("DATABASE_URL")
}
```

Update `DATABASE_URL` di `.env`, lalu `npx prisma migrate dev --name init`.

---

## Deploy

- **VPS**: `pm2 start src/server.js --name pg` cukup.
- **Docker**: expose port 3000, mount volume untuk `dev.db` (SQLite) atau pakai DB terpisah.
- **HTTPS**: taruh di belakang nginx / Caddy dengan Let's Encrypt.
- Ubah `BASE_URL` di `.env` sesuai domain.

---

## Roadmap ide

- Multi-tenant (jual PG ke merchant lain)
- Manual settlement fee
- Ekspor CSV transaksi
- 2FA admin
- Signed webhook v2 dengan timestamp anti-replay
