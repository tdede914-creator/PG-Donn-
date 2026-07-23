/**
 * Invoice service: buat invoice + generate QRIS dinamis dengan unique code.
 *
 * Prinsip matching pembayaran:
 * - QRIS dari bank / OrderKuota TIDAK membawa `merchant_ref` kita.
 *   Waktu customer bayar, mutasi yang masuk hanya berisi nominal & sedikit
 *   metadata (keterangan, brand, id transaksi bank). Jadi satu-satunya cara
 *   membedakan invoice adalah lewat NOMINAL YANG UNIK.
 *
 * - Untuk membuat nominal setiap invoice unik, kita tambahkan kode 1..999
 *   rupiah ke `amount` asli. Total yang dibayar = amount + uniqueCode.
 *
 * Guarantees dari file ini:
 * 1. Idempotency: kalau merchant kirim request dengan `merchantRef` yang
 *    SAMA (dan invoice PENDING-nya belum expire), kita balikin invoice yang
 *    sudah ada — tidak bikin duplikat. Ini penting untuk retry safety di
 *    bot Telegram / aplikasi merchant.
 *
 * 2. Race-safety: pemilihan uniqueCode + penulisan Invoice dilakukan
 *    di dalam satu `prisma.$transaction()`. SQLite men-serialize writer,
 *    jadi dua request bersamaan dengan `amount` sama TIDAK akan pernah
 *    menghasilkan totalAmount yang sama.
 *
 * 3. Pool exhaustion: kalau > 999 invoice PENDING dengan nominal dasar yang
 *    sama, kita throw error dengan `code = 'unique_code_pool_exhausted'`
 *    supaya bot bisa backoff & retry, bukan error generic.
 */

const { customAlphabet } = require('nanoid');
const prisma = require('../db');
const qris = require('./qris');
const config = require('../config');

const nano = customAlphabet('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 10);

function generateReference() {
  return `INV-${nano()}`;
}

/**
 * Error khusus supaya routes/api.js bisa map ke response code yang tepat
 * (mis. 409 untuk pool exhaustion → sinyal "retry later").
 */
class InvoiceCreateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InvoiceCreateError';
    this.code = code;
  }
}

/**
 * Pilih uniqueCode DI DALAM sebuah Prisma transaction, supaya check
 * "belum dipakai" + insert ke Invoice benar-benar atomik.
 *
 * `tx` = Prisma transactional client dari $transaction().
 */
async function pickUniqueCodeTx(tx, amount) {
  // 20 percobaan sudah cukup: probabilitas nabrak sangat rendah kecuali
  // pool 999 hampir habis.
  for (let i = 0; i < 20; i++) {
    const code = qris.generateUniqueCode();
    const total = amount + code;
    const conflict = await tx.invoice.findFirst({
      where: { totalAmount: total, status: 'PENDING' },
      select: { id: true },
    });
    if (!conflict) return code;
  }
  // Sudah 20× nabrak → pool 999 memang hampir habis untuk `amount` ini.
  // Cek berapa banyak invoice PENDING dengan amount ini biar pesan-nya
  // bisa memberi tahu user berapa slot yang masih tersisa.
  const pending = await tx.invoice.count({
    where: { amount, status: 'PENDING' },
  });
  throw new InvoiceCreateError(
    'unique_code_pool_exhausted',
    `Terlalu banyak invoice PENDING dengan amount=${amount} (${pending} aktif). ` +
      'Pool kode unik 1-999 hampir habis. Tunggu invoice existing dibayar/expired, ' +
      'atau varietasikan nominal (mis. Rp 1.001, Rp 1.002) untuk membedakan.',
  );
}

/**
 * Buat invoice baru.
 * @param {Object} opts
 * @param {number} opts.amount        Nominal asli (rupiah).
 * @param {number} opts.providerId
 * @param {number} [opts.apiKeyId]
 * @param {string} [opts.merchantRef] Reference dari sisi merchant.
 *                                    Kalau sama dgn PENDING invoice existing
 *                                    milik apiKey yang sama, invoice existing
 *                                    dikembalikan (idempotency).
 * @param {string} [opts.description]
 * @param {string} [opts.callbackUrl]
 * @returns {Promise<{invoice: Invoice, idempotent: boolean}>}
 */
async function createInvoice(opts) {
  const { amount, providerId, apiKeyId, merchantRef, description, callbackUrl } = opts;

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new InvoiceCreateError('invalid_amount', 'amount harus integer positif');
  }
  if (amount > 9_999_000) {
    throw new InvoiceCreateError('invalid_amount', 'amount terlalu besar');
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) throw new InvoiceCreateError('provider_not_found', 'Provider tidak ditemukan');
  if (!provider.isActive) throw new InvoiceCreateError('provider_inactive', 'Provider tidak aktif');

  // -----------------------------------------------------------------------
  // Idempotency: kalau merchantRef dikirim & sudah ada invoice PENDING
  // yang belum expire dengan merchantRef yang sama + apiKey yang sama,
  // balikin invoice existing itu. Ini standar praktek (Stripe, Xendit,
  // dst) — bot bisa retry request POST /api/v1/invoices sebanyak apapun
  // tanpa risiko bikin duplikat.
  //
  // Scope idempotency = (merchantRef, apiKeyId). Merchant yang berbeda
  // boleh punya merchantRef yang sama; itu invoice yang berbeda.
  // -----------------------------------------------------------------------
  if (merchantRef && apiKeyId) {
    const existing = await prisma.invoice.findFirst({
      where: {
        merchantRef,
        apiKeyId,
        status: 'PENDING',
        expiredAt: { gt: new Date() },
      },
    });
    if (existing) {
      // Sanity check: kalau amount berbeda dengan existing, JANGAN silently
      // balikin invoice lama — itu perilaku yang membingungkan. Tolak dulu.
      if (existing.amount !== amount) {
        throw new InvoiceCreateError(
          'merchant_ref_conflict',
          `merchant_ref "${merchantRef}" sudah dipakai oleh invoice PENDING lain ` +
            `dengan amount berbeda (${existing.amount} vs ${amount}). ` +
            `Cancel invoice ${existing.reference} dulu, atau pakai merchant_ref lain.`,
        );
      }
      return { invoice: existing, idempotent: true };
    }
  }

  const expireMinutes = config.invoice.expireMinutes;
  const expiredAt = new Date(Date.now() + expireMinutes * 60_000);
  const reference = generateReference();

  // -----------------------------------------------------------------------
  // Race-safe pemilihan uniqueCode + create Invoice. Kedua step dilakukan
  // di dalam SATU transaction; SQLite men-serialize writer, sehingga dua
  // request bersamaan dengan amount sama tidak akan pernah pick uniqueCode
  // yang sama.
  //
  // Transaction timeout dinaikkan ke 15 detik (default 5s) karena
  // findFirst bisa perlu multiple pass kalau tabel Invoice sudah besar.
  // -----------------------------------------------------------------------
  const invoice = await prisma.$transaction(
    async (tx) => {
      const uniqueCode = await pickUniqueCodeTx(tx, amount);
      const totalAmount = amount + uniqueCode;
      const qrisDynamic = qris.generateDynamicQris(provider.qrisStatic, totalAmount);

      return await tx.invoice.create({
        data: {
          reference,
          merchantRef: merchantRef || null,
          externalRef: null,
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
    },
    { timeout: 15_000 },
  );

  return { invoice, idempotent: false };
}

async function expireOverdue() {
  const now = new Date();
  const res = await prisma.invoice.updateMany({
    where: { status: 'PENDING', expiredAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });
  return res.count;
}

module.exports = {
  createInvoice,
  expireOverdue,
  generateReference,
  InvoiceCreateError,
};
