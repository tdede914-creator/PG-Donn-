/**
 * Poller: berjalan periodik untuk fetch mutasi dari setiap provider aktif,
 * kemudian mencocokkan ke invoice PENDING. Selain itu meng-expire invoice
 * yang sudah lewat waktu.
 *
 * Dijalankan bersama server (embedded) atau standalone:
 *   node src/workers/poller.js
 */

const cron = require('node-cron');
const prisma = require('../db');
const config = require('../config');
const { getAdapter } = require('../providers');
const matcher = require('../services/matcher');
const invoiceService = require('../services/invoice');

let isRunning = false;

async function tick() {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  try {
    // 1) Expire dulu
    const expired = await invoiceService.expireOverdue();
    if (expired > 0) console.log(`[poller] expired ${expired} invoice(s)`);

    // 2) Fetch mutasi tiap provider aktif
    const providers = await prisma.provider.findMany({ where: { isActive: true } });
    for (const p of providers) {
      try {
        const adapter = getAdapter(p.type);
        const mutations = await adapter.fetchMutations(p);
        const { saved, matched } = await matcher.ingestMutations(p.id, mutations);
        if (saved > 0 || matched > 0) {
          console.log(
            `[poller] provider=${p.name} type=${p.type} fetched=${mutations.length} saved=${saved} matched=${matched}`,
          );
        }
      } catch (err) {
        console.error(`[poller] provider ${p.name} error:`, err.message);
      }
    }
  } finally {
    const ms = Date.now() - startedAt;
    if (ms > 5000) console.log(`[poller] tick took ${ms}ms`);
    isRunning = false;
  }
}

function start() {
  const interval = Math.max(5, config.poller.intervalSeconds);
  // cron pattern setiap N detik: pakai node-cron dengan "*/N * * * * *"
  const pattern = `*/${interval} * * * * *`;
  console.log(`[poller] starting, interval=${interval}s`);
  cron.schedule(pattern, tick);
  // Jalankan sekali di awal
  tick().catch((e) => console.error('[poller] initial tick error', e));
}

if (require.main === module) {
  start();
}

module.exports = { start, tick };
