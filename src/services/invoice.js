/**
 * Invoice service: buat invoice + generate QRIS dinamis dengan unique code.
 *
 * Strategi unique code:
 *  - Setiap invoice ditambahi kode 1..999 rupiah agar totalAmount unik saat
 *    dicek di mutasi.
 *  - Kita ambil kode yang belum dipakai invoice PENDING lain dengan base amount
 *    yang sama, supaya tidak tabrakan.
 */

const { customAlphabet } = require('nanoid');
const prisma = require('../db');
const qris = require('./qris');
const config = require('../config');

const nano = customAlphabet('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 10);

function generateReference() {
  return `INV-${nano()}`;
}

async function pickUniqueCode(amount) {
  // Coba maksimal 20x. Idealnya sangat jarang tabrakan karena kombinasi 999.
  for (let i = 0; i < 20; i++) {
    const code = qris.generateUniqueCode();
    const total = amount + code;
    const conflict = await prisma.invoice.findFirst({
      where: { totalAmount: total, status: 'PENDING' },
      select: { id: true },
    });
    if (!conflict) return code;
  }
  throw new Error('Gagal cari unique code (terlalu banyak invoice pending dengan nominal sama)');
}

/**
 * Buat invoice baru.
 * @param {Object} opts
 * @param {number} opts.amount      Nominal asli (rupiah).
 * @param {number} opts.providerId
 * @param {number} [opts.apiKeyId]
 * @param {string} [opts.merchantRef]
 * @param {string} [opts.description]
 * @param {string} [opts.callbackUrl]
 */
async function createInvoice(opts) {
  const { amount, providerId, apiKeyId, merchantRef, description, callbackUrl } = opts;

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount harus integer positif');
  }
  if (amount > 9_999_000) {
    throw new Error('amount terlalu besar');
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) throw new Error('Provider tidak ditemukan');
  if (!provider.isActive) throw new Error('Provider tidak aktif');

  const expireMinutes = config.invoice.expireMinutes;
  const expiredAt = new Date(Date.now() + expireMinutes * 60_000);

  // Generate QRIS lokal dari static QRIS provider + unique-code trick.
  const uniqueCode = await pickUniqueCode(amount);
  const totalAmount = amount + uniqueCode;
  const qrisDynamic = qris.generateDynamicQris(provider.qrisStatic, totalAmount);
  const externalRef = null;

  const invoice = await prisma.invoice.create({
    data: {
      reference: generateReference(),
      merchantRef: merchantRef || null,
      externalRef,
      amount,
      uniqueCode,
      totalAmount,
      description: description || null,
      qrisDynamic,
      expiredAt,
      callbackUrl: callbackUrl || null,
      providerId: provider.id,
      apiKeyId: apiKeyId || null,
    },
  });

  return invoice;
}

async function expireOverdue() {
  const now = new Date();
  const res = await prisma.invoice.updateMany({
    where: { status: 'PENDING', expiredAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });
  return res.count;
}

module.exports = { createInvoice, expireOverdue, generateReference };
