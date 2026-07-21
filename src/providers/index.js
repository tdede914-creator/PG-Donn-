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
const danaBisnis = require('./danabisnis');

const registry = {
  orderkuota,
  dana_bisnis: danaBisnis,
};

function getAdapter(type) {
  const adapter = registry[type];
  if (!adapter) throw new Error(`Provider type tidak dikenal: ${type}`);
  return adapter;
}

module.exports = { getAdapter, registry };
