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
 * dikenal: <type>" tiap tick dan mutasi tidak akan pernah di-fetch.
 */

const orderkuotaJywa = require('./orderkuota_jywa');
const danaBisnis = require('./dana_bisnis');

const registry = {
  // ⭐ OrderKuota-KOBONGCLOUDSERVER
  // Endpoint /api/v2/qris/mutasi/{tokenId} — real-time polling qris_history.
  orderkuota_jywa: orderkuotaJywa,
  // ⭐ DANA Bisnis / Dabis — pengganti OrderKuota (QRIS OK sudah tutup).
  // Baca riwayat transaksi merchant lewat token/cookie sesi DANA.
  // Endpoint & field-map configurable lewat credentials (lihat DANA-SETUP.md).
  dana_bisnis: danaBisnis,
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
