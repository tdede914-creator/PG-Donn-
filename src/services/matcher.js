/**
 * Matcher: kaitkan mutasi baru ke invoice PENDING berdasarkan totalAmount.
 * Kalau match -> tandai invoice PAID + trigger webhook.
 *
 * Strategi matching:
 *  1. Single-match: cari 1 invoice PENDING dgn totalAmount === delta
 *  2. Combo-match: kalau single ga ketemu, cari KOMBINASI 2-3 invoice PENDING
 *     yang totalnya === delta. Ini handle balance-delta race condition
 *     (multiple payment dalam 1 poll interval).
 */

const prisma = require('../db');
const webhookService = require('./webhook');

async function ingestMutations(providerId, mutations) {
  let saved = 0;
  let matched = 0;

  for (const m of mutations) {
    // Cek dedup by externalId
    const exists = await prisma.mutation.findUnique({
      where: {
        providerId_externalId: { providerId, externalId: m.externalId },
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

    // -------- STRATEGI 1: Single Match --------
    const singleCandidate = await prisma.invoice.findFirst({
      where: {
        status: 'PENDING',
        totalAmount: m.amount,
        providerId,
        expiredAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (singleCandidate) {
      await prisma.invoice.update({
        where: { id: singleCandidate.id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          matchedMutationId: created.id,
        },
      });
      matched += 1;
      console.log(
        `[matcher] SINGLE MATCH: mutation ${m.externalId} amount=${m.amount} → invoice ${singleCandidate.reference}`,
      );
      webhookService.sendForInvoice(singleCandidate.id).catch((e) => {
        console.error('[webhook] error', e.message);
      });
      continue; // done for this mutation
    }

    // -------- STRATEGI 2: Combo Match --------
    // Kalau single tidak ketemu, coba kombinasi 2-3 invoice PENDING.
    // Berguna untuk balance-delta detection ketika 2+ payment masuk
    // dalam 1 poll interval → delta = jumlah semua.
    const comboMatch = await findComboMatch(providerId, m.amount);
    if (comboMatch && comboMatch.length > 1) {
      console.log(
        `[matcher] COMBO MATCH (${comboMatch.length} invoice): mutation ${m.externalId} amount=${m.amount} → ${comboMatch.map((i) => i.reference).join(' + ')}`,
      );

      for (const inv of comboMatch) {
        // Create synthetic sub-mutation supaya matchedMutationId unique
        // constraint tidak konflik.
        const subMutation = await prisma.mutation.create({
          data: {
            providerId,
            externalId: `${m.externalId}-inv${inv.id}`,
            amount: inv.totalAmount,
            rawPayload: JSON.stringify({
              sourceMutationExternalId: m.externalId,
              sourceDelta: m.amount,
              comboMatch: true,
              comboSize: comboMatch.length,
              invoiceRef: inv.reference,
            }),
            occurredAt: m.occurredAt,
          },
        });
        await prisma.invoice.update({
          where: { id: inv.id },
          data: {
            status: 'PAID',
            paidAt: new Date(),
            matchedMutationId: subMutation.id,
          },
        });
        matched += 1;
        webhookService.sendForInvoice(inv.id).catch((e) => {
          console.error('[webhook] error', e.message);
        });
      }
      continue;
    }

    // -------- STRATEGI 3: No Match (unresolved) --------
    console.log(
      `[matcher] NO MATCH: mutation ${m.externalId} amount=${m.amount} (no single/combo invoice PENDING match)`,
    );
  }

  return { saved, matched };
}

/**
 * Cari kombinasi 2 atau 3 invoice PENDING yang totalAmount-nya === target.
 * Return array of invoices kalau ketemu, null kalau tidak.
 *
 * Algoritma: brute force karena umumnya invoice PENDING < 20 (max 15 menit
 * expiry). Untuk n=20, pairs = 190 combinations, triples = 1140. Fast enough.
 *
 * Prioritas: pairs dulu (paling umum), baru triples. Tidak coba 4+ karena
 * probabilitas 4 payment bersamaan dalam 10s sangat rendah.
 */
async function findComboMatch(providerId, targetAmount) {
  const pending = await prisma.invoice.findMany({
    where: {
      status: 'PENDING',
      providerId,
      expiredAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'asc' },
    take: 50, // safety cap
  });

  if (pending.length < 2) return null;

  const n = pending.length;

  // ---- Try PAIRS (2 invoice) ----
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pending[i].totalAmount + pending[j].totalAmount === targetAmount) {
        return [pending[i], pending[j]];
      }
    }
  }

  // ---- Try TRIPLES (3 invoice) ----
  if (n >= 3) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const partialSum = pending[i].totalAmount + pending[j].totalAmount;
        if (partialSum >= targetAmount) continue; // prune
        for (let k = j + 1; k < n; k++) {
          if (partialSum + pending[k].totalAmount === targetAmount) {
            return [pending[i], pending[j], pending[k]];
          }
        }
      }
    }
  }

  return null;
}

module.exports = { ingestMutations, findComboMatch };
