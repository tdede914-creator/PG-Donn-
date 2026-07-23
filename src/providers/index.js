/**
 * Provider registry.
 *
 * Setiap adapter provider harus expose:
 *   async fetchMutations(provider): Promise<Array<{
 *      externalId: string,   // ID unik transaksi di provider (untuk dedup)
 *      amount: number,       // rupiah, integer
 *      occurredAt: Date,     // waktu transaksi
 *      raw: any              // payload asli
 *   }>>
 *
 * `provider` = row Prisma Provider. `provider.credentials` di-parse dari JSON.
 *
 * PENTING: setiap `type` yang muncul di dropdown `providers.ejs` HARUS
 * terdaftar di sini. Kalau tidak, poller akan throw "Provider type tidak
 * dikenal: <type>" tiap tick — di-catch diam-diam di poller.js — sehingga
 * mutasi TIDAK PERNAH di-fetch dan invoice tetap PENDING selamanya walau
 * pembayaran sudah masuk. Itu adalah root cause dari bug "status masih
 * pending padahal sudah dibayar" sebelumnya.
 */

const orderkuota = require('./orderkuota');
const orderkuotaJywa = require('./orderkuota_jywa');
const orderkuotaBalance = require('./orderkuota_balance');
const zeppelinOrderkuota = require('./zeppelin_orderkuota');
const danaBisnis = require('./danabisnis');
const okeconnect = require('./okeconnect');
const okeconnectH2H = require('./okeconnect_h2h');

const registry = {
  // Mobile API OrderKuota — endpoint /api/v2/get. Sering diblok versi.
  orderkuota,
  // ⭐ Rekomendasi: pakai endpoint /api/v2/qris/mutasi/{tokenId} (Jywa flavor).
  orderkuota_jywa: orderkuotaJywa,
  // Fallback kalau qris_history diblok: pantau delta qris_balance.
  orderkuota_balance: orderkuotaBalance,
  // Middleware pihak ketiga zeppelin-api.vercel.app.
  zeppelin_orderkuota: zeppelinOrderkuota,
  // DANA Bisnis (generic HTTP config).
  dana_bisnis: danaBisnis,
  // Scrape session cookie OkConnect dashboard.
  okeconnect,
  // OkConnect gateway H2H legacy (merchantId + apiKey).
  okeconnect_h2h: okeconnectH2H,
};

function getAdapter(type) {
  const adapter = registry[type];
  if (!adapter) {
    const known = Object.keys(registry).join(', ');
    throw new Error(
      `Provider type tidak dikenal: "${type}". Type yang tersedia: ${known}. ` +
        `Cek /providers dan pilih type yang tepat.`,
    );
  }
  return adapter;
}

module.exports = { getAdapter, registry };
