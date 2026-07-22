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
 */

const orderkuota = require('./orderkuota');
const orderkuotaBalance = require('./orderkuota_balance');
const zeppelinOrderkuota = require('./zeppelin_orderkuota');
const danaBisnis = require('./danabisnis');
const okeconnect = require('./okeconnect');
const okeconnectH2h = require('./okeconnect_h2h');

const registry = {
  orderkuota,
  orderkuota_balance: orderkuotaBalance,
  zeppelin_orderkuota: zeppelinOrderkuota,
  dana_bisnis: danaBisnis,
  okeconnect,
  okeconnect_h2h: okeconnectH2h,
};

function getAdapter(type) {
  const adapter = registry[type];
  if (!adapter) throw new Error(`Provider type tidak dikenal: ${type}`);
  return adapter;
}

module.exports = { getAdapter, registry };
