# Cara Upload Manual ke Repo PG-Donn-

Folder ini isinya **hanya file yang perlu kamu upload/ganti** di repo GitHub
`tdede914-creator/PG-Donn-` untuk migrasi OrderKuota → **DANA Bisnis**.

Struktur folder di sini **sama persis** dengan struktur repo, jadi taruh tiap
file di path yang sama.

---

## Daftar file

### 🆕 File BARU (belum ada di repo — tinggal tambah)

| File di folder ini | Taruh di repo (path sama) |
|--------------------|---------------------------|
| `src/providers/dana_bisnis.js` | `src/providers/dana_bisnis.js` |
| `DANA-SETUP.md` | `DANA-SETUP.md` (root repo) |

### ✏️ File DIUBAH (timpa yang lama)

| File di folder ini | Timpa file di repo |
|--------------------|--------------------|
| `src/providers/index.js` | `src/providers/index.js` |
| `src/routes/dashboard.js` | `src/routes/dashboard.js` |
| `src/views/providers.ejs` | `src/views/providers.ejs` |
| `README.md` | `README.md` |
| `LICENSE-3RD-PARTY.md` | `LICENSE-3RD-PARTY.md` |

> Total 7 file. **Tidak ada** perubahan di `package.json` / `prisma/schema.prisma`
> (dependency `axios` & kolom `type` provider sudah tersedia dari sebelumnya).

---

## Cara upload lewat web GitHub

**Opsi A — drag & drop (paling gampang):**
1. Buka repo di github.com → tombol **Add file → Upload files**.
2. **Seret folder `src`** dari sini ke area upload. GitHub mempertahankan
   struktur folder, jadi `src/providers/dana_bisnis.js` dst. otomatis masuk ke
   path yang benar (menimpa yang lama).
3. Seret juga `README.md`, `LICENSE-3RD-PARTY.md`, dan `DANA-SETUP.md` (file root).
4. Isi commit message, mis. `feat: provider DANA Bisnis (ganti OrderKuota)` →
   **Commit changes**.

**Opsi B — per file (kalau drag folder bermasalah):**
1. Buka file lama di repo (mis. `src/providers/index.js`) → ikon **pensil (Edit)**.
2. Hapus semua isi, paste isi file dari folder ini → **Commit**.
3. Untuk file baru: **Add file → Create new file**, ketik path lengkap
   (mis. `src/providers/dana_bisnis.js`), paste isi → **Commit**.

---

## Setelah upload — WAJIB dibaca

Endpoint DANA di adapter masih **placeholder** (DANA tak punya API resmi). Kamu
harus isi nilai asli (token + endpoint hasil capture) lewat **Credentials (JSON)**
di halaman Providers, lalu kalibrasi pakai tombol **Poll Now (debug)**.

👉 Langkah lengkap ada di **`DANA-SETUP.md`**.
