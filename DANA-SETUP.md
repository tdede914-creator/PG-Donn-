# Setup Provider DANA Bisnis (Dabis)

Panduan mengganti sumber mutasi QRIS dari **OrderKuota** (sudah tutup) ke
**DANA Bisnis / Dabis**. Adapter: `src/providers/dana_bisnis.js`, type
`dana_bisnis`.

> **Ringkas:** Payment gateway ini tetap men-*generate* QRIS dinamis dari
> `qrisStatic` merchant-mu (tidak berubah). Yang berubah cuma **sumber mutasi**:
> sekarang dibaca dari riwayat transaksi akun DANA Bisnis lewat token/cookie
> sesi. Selama DANA mengembalikan **nominal yang persis sama** dengan
> `totalAmount` invoice (nominal + kode unik 1–999), pencocokan otomatis jalan
> seperti sebelumnya.

---

## ⚠️ Baca dulu: kenapa perlu kalibrasi

DANA **tidak** punya API publik resmi untuk baca mutasi merchant lewat token
aplikasi. Adapter ini di-port dari arsitektur
[`yono99/dana-api-gateway`](https://github.com/yono99/dana-api-gateway) (MIT),
tapi **endpoint & bentuk response-nya masih tebakan** dan **wajib kamu
verifikasi** dengan nilai asli dari akun DANA Bisnis-mu sendiri.

Karena itu adapter dibuat **configurable**: semua endpoint, header, parameter,
dan pemetaan field bisa diatur lewat **Credentials (JSON)** tanpa mengubah kode.
Alur kerjanya: isi credentials → **Poll Now (debug)** → baca raw response →
sesuaikan `txPath` / `fieldMap` → ulangi sampai mutasi terbaca.

> Lakukan ini **hanya pada akun DANA Bisnis milikmu sendiri**. Kamu bertanggung
> jawab atas kepatuhan terhadap Syarat & Ketentuan DANA.

---

## Langkah 1 — Dapatkan token/cookie sesi DANA

Ada dua jalur. **Jalur B (import manual) lebih andal** karena endpoint OTP
bawaan masih tebakan.

### Jalur A — Login OTP lewat dashboard (kalau endpoint OTP cocok)

1. Buka **Providers → Tambah Provider Baru**, pilih Type **DANA Bisnis / Dabis**.
2. Di panel **Login DANA Bisnis**, isi **No HP DANA Bisnis** → **Kirim OTP**.
3. Masukkan kode OTP → **Verify OTP**.
4. Kalau sukses, field **Credentials (JSON)** terisi otomatis (`accessToken`,
   `cookie`, `merchantId`, dll). Lanjut ke Langkah 2.

Kalau "Kirim OTP" / "Verify OTP" error (HTTP 404/400), berarti endpoint OTP
bawaan tidak cocok — pakai Jalur B.

### Jalur B — Import manual (capture token asli) — **disarankan**

Tujuan: menangkap **URL endpoint riwayat transaksi** + **header Authorization
(atau Cookie)** yang dipakai aplikasi/portal DANA Bisnis saat menampilkan
riwayat transaksi.

**Opsi B1 — Portal web DANA Bisnis (kalau tersedia di wilayahmu):**

1. Login ke portal web DANA Bisnis di browser desktop.
2. Buka **DevTools** (F12) → tab **Network** → filter **Fetch/XHR**.
3. Buka halaman **Riwayat/Transaksi** sehingga daftar transaksi ter-load.
4. Cari request yang me-return daftar transaksi (biasanya ada kata
   `transaction`, `history`, `mutation`, `order`, atau `acquirement` di URL).
5. Dari request itu, catat:
   - **Request URL** → dipecah jadi `apiBase` (skema+host) + `txPath` (path).
     Contoh: `https://api.saas.dana.id/v1/merchant/transactions`
     → `apiBase` = `https://api.saas.dana.id`, `txPath` = `/v1/merchant/transactions`.
   - **Request Headers** → `Authorization: Bearer xxxxx` (ambil `xxxxx` sebagai
     `accessToken`), dan/atau `Cookie: ...` (ambil sebagai `cookie`).
   - **Query String Params** → nama parameter tanggal/status/paging (untuk
     `extraParams` bila beda dari bawaan).
   - **Response** (tab Preview/Response) → perhatikan **di mana array transaksi
     berada** dan **nama field** nominal / id / waktu (untuk `fieldMap`).

**Opsi B2 — Intercept aplikasi Android (lebih teknis):**

Kalau tidak ada portal web, tangkap trafik aplikasi DANA Bisnis dengan HTTP
proxy (mis. **HTTP Toolkit** / **mitmproxy**). Aplikasi finansial umumnya pakai
**SSL pinning**, jadi butuh bypass (mis. **Frida**/**objection** di perangkat
ter-root atau emulator). Ini lanjutan dan berisiko melanggar ToS — lakukan hanya
pada akunmu sendiri dan atas tanggung jawabmu. Data yang dicari sama seperti
B1: URL endpoint, header Authorization/Cookie, dan bentuk response.

Setelah dapat nilainya, di panel provider klik **"Isi template berdasarkan
Type"** lalu **tempel** `accessToken`/`cookie`/`apiBase`/`txPath` ke Credentials
JSON.

---

## Langkah 2 — Isi Credentials (JSON)

Bentuk minimal (import manual pakai Bearer token):

```json
{
  "apiBase": "https://api.saas.dana.id",
  "txPath": "/v1/merchant/transactions",
  "accessToken": "eyJhbGciOi...token-asli...",
  "merchantId": "OPSIONAL_ISI_KALAU_ADA"
}
```

Atau pakai cookie sesi (tanpa Bearer):

```json
{
  "apiBase": "https://api.saas.dana.id",
  "txPath": "/v1/merchant/transactions",
  "cookie": "SESSIONID=abc; other=xyz"
}
```

### Referensi lengkap field credentials

| Field            | Wajib | Default                          | Keterangan |
|------------------|-------|----------------------------------|------------|
| `apiBase`        | ya*   | `https://api.saas.dana.id`       | Skema + host endpoint. Tanpa trailing slash. |
| `txPath`         | ya*   | `/v1/merchant/transactions`      | Path endpoint riwayat transaksi. |
| `accessToken`    | ya**  | —                                | Token Bearer hasil capture. |
| `cookie`         | ya**  | —                                | Cookie sesi (alternatif token). |
| `refreshToken`   | tidak | —                                | Untuk auto-refresh token saat 401. |
| `refreshPath`    | tidak | `/v1/oauth/token/refresh`        | Endpoint refresh token. |
| `merchantId`     | tidak | —                                | Dikirim sbg header `X-Merchant-Id` + query `merchantId`. |
| `deviceId`       | tidak | —                                | Header `X-Device-Id` bila diperlukan. |
| `authScheme`     | tidak | `Bearer`                         | Prefix header Authorization. Kosongkan (`""`) untuk token mentah. |
| `tokenHeader`    | tidak | `Authorization`                  | Nama header token bila bukan `Authorization`. |
| `clientId`       | tidak | `dana-business-web`              | Header `X-Client-Id`. |
| `userAgent`      | tidak | (UA Android bawaan)              | Header `User-Agent`. |
| `pageSize`       | tidak | `25`                             | Jumlah transaksi per fetch. |
| `lookbackMinutes`| tidak | `4320` (3 hari)                  | Rentang waktu yang diminta ke API. |
| `statusFilter`   | tidak | `SUCCESS,SETTLED,CAPTURE`        | Nilai query `status`. Sesuaikan dgn status "berhasil" versi DANA. |
| `dateFormat`     | tidak | `iso`                            | Format `startTime`/`endTime`: `iso` \| `unix` \| `unix_ms`. |
| `extraHeaders`   | tidak | `{}`                             | Header tambahan (object) yang di-merge. |
| `extraParams`    | tidak | `{}`                             | Query param tambahan (object) yang di-merge. |
| `includeAll`     | tidak | `false`                          | `true` = jangan buang transaksi arah debit/keluar. |
| `fieldMap`       | tidak | (kandidat toleran bawaan)        | Pemetaan field response → lihat bawah. |
| `expiresAt`      | auto  | —                                | Diisi otomatis setelah login/refresh. |

\* Punya default; ganti kalau endpoint aslimu beda.  
\** Minimal salah satu dari `accessToken` **atau** `cookie` harus ada.

### `fieldMap` — memetakan bentuk response

Adapter mencoba beberapa nama field umum secara otomatis. Kalau bentuk response
DANA-mu beda, override lewat `fieldMap`. Setiap entri adalah **daftar kandidat**
(dicoba berurutan; yang pertama ketemu dipakai). Dukungan path bertingkat pakai
titik, mis. `"amount.value"`.

```json
{
  "apiBase": "https://api.saas.dana.id",
  "txPath": "/v1/merchant/transactions",
  "accessToken": "...",
  "fieldMap": {
    "listPaths": ["data.transactions", "data.list", "transactions"],
    "amount":    ["amount.value", "gross_amount", "amount"],
    "id":        ["transactionId", "acquirementId", "order_id", "id"],
    "time":      ["transactionTime", "finishTime", "created_at"],
    "status":    ["status", "transaction_status"],
    "direction": ["direction", "type"]
  }
}
```

- `listPaths` — di mana array transaksi berada dalam response.
- `amount` — field nominal (dibersihkan jadi integer rupiah).
- `id` — dijadikan `externalId` untuk dedup (wajib unik & stabil per transaksi).
- `time` — waktu transaksi (`occurredAt`).
- `direction` — dipakai membuang transaksi keluar (debit/refund) kecuali
  `includeAll: true`.

---

## Langkah 3 — Kalibrasi dengan "Poll Now (debug)"

1. **Simpan** provider (klik Simpan). Boleh isi `qrisStatic` dulu (wajib di form).
2. Di daftar **Provider Terdaftar**, klik **Poll Now (debug)**.
3. Perhatikan hasilnya:
   - **Sample mutasi terbaru** — kalau sudah muncul `externalId` + `amount` yang
     benar, **berhasil**. Lanjut normal.
   - **🐛 Debug — Raw Response Provider** — kalau sample kosong, baca panel ini:
     - `HTTP 200` tapi `Sample` kosong → endpoint benar, tapi `fieldMap` /
       `listPaths` belum cocok. Lihat `Top-level keys` & isi `parsedDataPreview`,
       lalu sesuaikan `fieldMap`.
     - `HTTP 401/403` → token/cookie invalid atau kurang header. Ambil token
       baru, atau tambah `deviceId`/`extraHeaders` sesuai capture.
     - `HTTP 404` → `txPath` salah. Cek lagi URL asli dari DevTools.
     - `HTTP 400` → parameter tanggal/status tidak diterima. Coba ganti
       `dateFormat`, atau set `extraParams` sesuai capture.
4. **Edit Credentials** (tombol di provider) untuk ubah nilai tanpa hapus
   provider, lalu **Poll Now** lagi. Ulangi sampai sample benar.

> Tombol **Test** hanya memanggil `fetchMutations` dan menampilkan pesan
> ringkas; **Poll Now (debug)** menampilkan raw response — pakai Poll Now untuk
> kalibrasi.

---

## Cara pencocokan pembayaran (penting)

Matcher mencocokkan mutasi ke invoice **PENDING** berdasarkan **nominal persis**:

```
invoice.totalAmount == mutasi.amount
```

`totalAmount = amount + uniqueCode` (kode unik 1–999). Jadi:

- DANA **harus** mengembalikan nominal yang **persis dibayar** (termasuk kode
  unik). Kalau `amount` dari DANA dibulatkan atau dipotong biaya admin,
  pencocokan gagal. Pastikan `fieldMap.amount` menunjuk ke **gross amount**
  (yang dibayar pembeli), bukan nett/settlement.
- `externalId` harus unik & stabil per transaksi supaya dedup benar (mutasi yang
  sama tidak dobel diproses). Kalau tidak ada id unik, adapter membuat fallback
  dari `waktu + nominal` — kurang ideal, jadi usahakan set `fieldMap.id` ke id
  transaksi asli DANA.

---

## Auto-refresh & masa berlaku token

- Kalau credentials punya `refreshToken` + `expiresAt`, adapter refresh otomatis
  sebelum kedaluwarsa dan saat kena `401/403`, lalu **menyimpan token baru** ke
  DB provider (kamu tidak perlu login ulang tiap kali).
- Kalau hanya pakai `cookie` (tanpa refresh), sesi bisa mati sewaktu-waktu →
  tinggal ambil cookie baru dan **Edit Credentials**.

---

## Troubleshooting singkat

| Gejala (di Poll Now) | Kemungkinan sebab | Tindakan |
|----------------------|-------------------|----------|
| `HTTP 200`, sample kosong, raw ada isinya | `fieldMap`/`listPaths` belum cocok | Sesuaikan `fieldMap` dari `parsedDataPreview` |
| `HTTP 401/403` | Token/cookie invalid/kurang header | Ambil token baru; tambah `deviceId`/`extraHeaders` |
| `HTTP 404` | `txPath` salah | Perbaiki `apiBase`/`txPath` dari DevTools |
| `HTTP 400` | Param tanggal/status ditolak | Ganti `dateFormat`; set `extraParams` |
| "ada transaksi tapi 0 ter-normalize" (log) | `amount` selalu 0 / arah kebuang | Cek `fieldMap.amount`; set `includeAll: true` utk cek |
| Mutasi masuk tapi invoice tak jadi PAID | Nominal beda (nett vs gross) | Arahkan `fieldMap.amount` ke gross; cek biaya admin |
| Mutasi dobel diproses | `externalId` tidak unik | Set `fieldMap.id` ke id transaksi asli |

---

## Catatan atribusi

Arsitektur session + auto-refresh + fetch transaksi di adapter ini di-port dari
[`yono99/dana-api-gateway`](https://github.com/yono99/dana-api-gateway) (MIT).
Lihat `LICENSE-3RD-PARTY.md`.
