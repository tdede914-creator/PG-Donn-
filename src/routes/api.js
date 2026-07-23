/**
 * Public REST API untuk merchant.
 *
 * Auth: header  X-API-Key: pk_xxx
 *
 * Endpoints:
 *   POST /api/v1/invoices           -> create invoice
 *   GET  /api/v1/invoices/:ref      -> get invoice status
 *   POST /api/v1/invoices/:ref/cancel
 */

const express = require('express');
const QRCode = require('qrcode');
const prisma = require('../db');
const { requireApiKey } = require('../middleware/apikey');
const invoiceService = require('../services/invoice');
const config = require('../config');

const router = express.Router();

router.use(requireApiKey);

// Map error code dari invoiceService ke HTTP status yang tepat.
const ERROR_HTTP_MAP = {
  invalid_amount:            400,
  provider_not_found:        400,
  provider_inactive:         400,
  merchant_ref_conflict:     409,
  unique_code_pool_exhausted: 429, // 429 → bot: backoff & retry
};

router.post('/invoices', async (req, res) => {
  try {
    const { amount, provider_id, merchant_ref, description, callback_url } = req.body || {};

    // Kalau provider_id tidak dikirim, pakai provider aktif pertama.
    let providerId = parseInt(provider_id, 10);
    if (!providerId) {
      const p = await prisma.provider.findFirst({ where: { isActive: true } });
      if (!p) return res.status(400).json({ error: 'no_active_provider' });
      providerId = p.id;
    }

    const { invoice, idempotent } = await invoiceService.createInvoice({
      amount: parseInt(amount, 10),
      providerId,
      apiKeyId: req.apiKey.id,
      merchantRef: merchant_ref,
      description,
      callbackUrl: callback_url,
    });

    const qrImage = await QRCode.toDataURL(invoice.qrisDynamic, { margin: 1, width: 400 });

    // Bila invoice dikembalikan lewat jalur idempotency, tandai lewat header.
    // Body tetap identik dengan create biasa supaya klien tidak perlu case
    // handling apa-apa.
    if (idempotent) {
      res.setHeader('X-Idempotent-Replay', 'true');
    }

    res.json({
      reference: invoice.reference,
      merchant_ref: invoice.merchantRef,
      amount: invoice.amount,
      unique_code: invoice.uniqueCode,
      total_amount: invoice.totalAmount,
      status: invoice.status,
      qris_string: invoice.qrisDynamic,
      qris_image: qrImage, // data URL PNG
      expired_at: invoice.expiredAt,
      pay_url: `${config.baseUrl}/pay/${invoice.reference}`,
      idempotent_replay: idempotent, // supaya klien tanpa akses header tetap tahu
    });
  } catch (e) {
    // InvoiceCreateError → map ke HTTP + error code yang lebih spesifik.
    if (e && e.name === 'InvoiceCreateError' && ERROR_HTTP_MAP[e.code]) {
      const status = ERROR_HTTP_MAP[e.code];
      // Untuk 429 (pool exhausted), kasih hint retry-after.
      if (status === 429) res.setHeader('Retry-After', '10');
      return res.status(status).json({ error: e.code, message: e.message });
    }
    res.status(400).json({ error: 'bad_request', message: e.message });
  }
});

router.get('/invoices/:ref', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { reference: req.params.ref },
  });
  if (!invoice) return res.status(404).json({ error: 'not_found' });
  if (invoice.apiKeyId && invoice.apiKeyId !== req.apiKey.id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({
    reference: invoice.reference,
    merchant_ref: invoice.merchantRef,
    amount: invoice.amount,
    unique_code: invoice.uniqueCode,
    total_amount: invoice.totalAmount,
    status: invoice.status,
    paid_at: invoice.paidAt,
    expired_at: invoice.expiredAt,
    pay_url: `${config.baseUrl}/pay/${invoice.reference}`,
  });
});

router.post('/invoices/:ref/cancel', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { reference: req.params.ref } });
  if (!invoice) return res.status(404).json({ error: 'not_found' });
  if (invoice.apiKeyId && invoice.apiKeyId !== req.apiKey.id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (invoice.status !== 'PENDING') {
    return res.status(400).json({ error: 'invalid_state', status: invoice.status });
  }
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: 'CANCELLED' },
  });
  res.json({ ok: true });
});

module.exports = router;
