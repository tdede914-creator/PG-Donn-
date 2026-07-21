/**
 * Matcher: kaitkan mutasi baru ke invoice PENDING berdasarkan totalAmount.
 * Kalau match -> tandai invoice PAID + trigger webhook.
 */

const prisma = require('../db');
const webhookService = require('./webhook');

/**
 * Simpan mutasi baru (dedup by providerId+externalId) dan coba match.
 * @param {number} providerId
 * @param {Array} mutations Array dari adapter.fetchMutations()
 * @returns {{ saved:number, matched:number }}
 */
async function ingestMutations(providerId, mutations) {
  let saved = 0;
  let matched = 0;

  for (const m of mutations) {
    // Cek dedup
    const exists = await prisma.mutation.findUnique({
      where: {
        providerId_externalId: {
          providerId,
          externalId: m.externalId,
        },
      },
    });
    if (exists) continue;

    const created = await prisma.mutation.create({
      data: {
        providerId,
        externalId: m.externalId,
        amount: m.amount,
        rawPayload: JSON.stringify(m.raw ?? {}),
        occurredAt: m.occurredAt,
      },
    });
    saved += 1;

    // Coba match ke invoice PENDING.
    const candidate = await prisma.invoice.findFirst({
      where: {
        status: 'PENDING',
        totalAmount: m.amount,
        providerId,
        expiredAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (candidate) {
      await prisma.invoice.update({
        where: { id: candidate.id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          matchedMutationId: created.id,
        },
      });
      matched += 1;
      // Fire webhook (non-blocking; error di-log).
      webhookService.sendForInvoice(candidate.id).catch((e) => {
        console.error('[webhook] error', e.message);
      });
    }
  }

  return { saved, matched };
}

module.exports = { ingestMutations };
