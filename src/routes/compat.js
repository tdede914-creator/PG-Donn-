/**
 * Compatibility endpoints — mimic response format 3rd-party payment providers
 * supaya bot/aplikasi existing bisa pakai PG kita TANPA rombak code mereka.
 * Cukup ganti URL base dan API key.
 *
 * Endpoints:
 *   GET /api/compat/okconnect/mutasi/qris/:merchant/:apikey
 *     Format response mirip https://gateway.okeconnect.com/api/mutasi/qris/...
 *   POST /hooks/okconnect-callback
 *     Terima webhook dari OkConnect dashboard (URL Callback di
 *     Integrasi Transaksi) → insert ke Mutation table.
 */

const express = require('express');
const prisma = require('../db');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/compat/okconnect/mutasi/qris/:merchant/:apikey
// ---------------------------------------------------------------------------
// Kompatibel dengan format OkConnect:
//   {
//     "status": "success",
//     "data": [
//       {
//         "date": "2026-07-22 18:22:00",
//         "amount": "1628",
//         "type": "CR",
//         "qris": "static",
//         "brand_name": "SeaBank",
//         "issuer_reff": "..."
//       }
//     ]
//   }
// Data diambil dari:
//   1. Mutation table (yang populate lewat poller OR webhook OkConnect)
//   2. Invoice yang statusnya PAID (backup, kalau merchant pakai kita untuk
//      create invoice juga)
// ---------------------------------------------------------------------------
router.get('/api/compat/okconnect/mutasi/qris/:merchant/:apikey', async (req, res) => {
  const { apikey } = req.params;

  // Verify API key valid & aktif
  const key = await prisma.apiKey.findUnique({ where: { key: apikey } });
  if (!key || !key.isActive) {
    return res.status(401).json({
      status: 'error',
      message: 'API key invalid atau tidak aktif',
    });
  }

  // Ambil mutasi terbaru (1 jam terakhir) — cukup untuk bot yang polling
  // per 10 detik untuk deteksi transaksi baru.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [mutations, paidInvoices] = await Promise.all([
    prisma.mutation.findMany({
      where: { occurredAt: { gt: oneHourAgo } },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    }),
    prisma.invoice.findMany({
      where: {
        status: 'PAID',
        paidAt: { gt: oneHourAgo },
        apiKeyId: key.id,
      },
      orderBy: { paidAt: 'desc' },
      take: 50,
    }),
  ]);

  // Convert Mutation → OkConnect format
  const mutasiData = mutations.map((m) => {
    let raw = {};
    try { raw = JSON.parse(m.rawPayload || '{}'); } catch (_) {}
    return {
      date: formatDate(m.occurredAt),
      amount: String(m.amount),
      type: 'CR',
      qris: 'static',
      brand_name: raw?.brand?.name || raw?.keterangan || raw?.desc || 'QRIS',
      issuer_reff: m.externalId,
    };
  });

  // Convert Invoice PAID → OkConnect format (backup source)
  const invoiceData = paidInvoices.map((inv) => ({
    date: formatDate(inv.paidAt || inv.createdAt),
    amount: String(inv.totalAmount),
    type: 'CR',
    qris: 'static',
    brand_name: 'PG-Invoice',
    issuer_reff: inv.reference,
  }));

  // Merge, unique by (date+amount+issuer_reff), sort desc by date
  const combined = [...mutasiData, ...invoiceData];
  const seen = new Set();
  const unique = [];
  for (const item of combined) {
    const key2 = `${item.date}|${item.amount}|${item.issuer_reff}`;
    if (!seen.has(key2)) {
      seen.add(key2);
      unique.push(item);
    }
  }
  unique.sort((a, b) => (a.date < b.date ? 1 : -1));

  res.json({
    status: 'success',
    total: unique.length,
    data: unique,
  });
});

function formatDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  // Format "YYYY-MM-DD HH:mm:ss" di WIB (UTC+7)
  const wib = new Date(dt.getTime() + 7 * 60 * 60 * 1000);
  const s = wib.toISOString().replace('T', ' ').slice(0, 19);
  return s;
}

// ---------------------------------------------------------------------------
// POST /hooks/okconnect-callback
// ---------------------------------------------------------------------------
// Receive webhook dari dashboard OkConnect (Integrasi Transaksi → URL Callback).
// Format payload BELUM diketahui pasti — kita log dulu untuk discovery.
// Best-effort parsing untuk umum-nya format callback pulsa/QRIS:
//   { merchant_id, amount, date, reff, type, ... }
// ---------------------------------------------------------------------------
router.post('/hooks/okconnect-callback', express.json({ limit: '256kb' }), express.urlencoded({ extended: true }), async (req, res) => {
  const startedAt = new Date();
  const rawBody = JSON.stringify(req.body || {});
  const headers = JSON.stringify(req.headers || {});

  console.log(`[okconnect-callback] ${startedAt.toISOString()}`);
  console.log(`  headers: ${headers}`);
  console.log(`  body:    ${rawBody}`);

  try {
    // Best-effort field extraction dari berbagai format callback yang umum
    const b = req.body || {};
    const amount =
      parseInt(String(b.amount ?? b.nominal ?? b.jumlah ?? b.kredit ?? 0).replace(/[^0-9]/g, ''), 10) || 0;
    const dateStr = b.date || b.tanggal || b.waktu || b.datetime || startedAt.toISOString();
    const occurredAt = new Date(dateStr);
    const externalId = String(
      b.reff || b.reference || b.ref || b.id || b.trx_id || `OKC-${Date.now()}`,
    );
    const type = String(b.type || 'CR').toUpperCase();

    // Kalau CR (credit / masuk) dan amount > 0 → simpan Mutation
    if (amount > 0 && (type === 'CR' || type === 'IN' || type === 'CREDIT' || !b.type)) {
      // Attach ke provider aktif pertama (arbitrary tapi konsisten).
      const provider = await prisma.provider.findFirst({
        where: { isActive: true },
      });
      const providerId = provider ? provider.id : null;

      if (providerId) {
        try {
          await prisma.mutation.upsert({
            where: {
              providerId_externalId: {
                providerId,
                externalId,
              },
            },
            create: {
              providerId,
              externalId,
              amount,
              rawPayload: rawBody,
              occurredAt: isNaN(occurredAt.getTime()) ? startedAt : occurredAt,
            },
            update: {}, // ga overwrite kalau udah ada (dedup)
          });
          console.log(`[okconnect-callback] Mutation saved: ${externalId} amount=${amount}`);

          // Coba match ke invoice PENDING
          const matcher = require('../services/matcher');
          const { saved, matched } = await matcher.ingestMutations(providerId, [{
            externalId, amount, occurredAt,
            raw: b,
          }]);
          console.log(`[okconnect-callback] matcher: saved=${saved} matched=${matched}`);
        } catch (err) {
          console.error(`[okconnect-callback] db error:`, err.message);
        }
      } else {
        console.warn(`[okconnect-callback] no active provider — Mutation skipped`);
      }
    }

    res.json({ success: true, received: { amount, externalId, type } });
  } catch (err) {
    console.error('[okconnect-callback] error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
