/**
 * Kirim webhook ke merchant saat invoice PAID.
 *
 * Payload:
 *  {
 *    event: "invoice.paid",
 *    reference, merchantRef, amount, totalAmount, uniqueCode,
 *    status, paidAt, providerType
 *  }
 *
 * Header:
 *  X-Signature: HMAC-SHA256(body, apiKey.secret || WEBHOOK_SECRET)
 *  X-Event: invoice.paid
 */

const crypto = require('crypto');
const axios = require('axios');
const prisma = require('../db');
const config = require('../config');

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function sendForInvoice(invoiceId) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { apiKey: true, provider: true },
  });
  if (!invoice) return;
  if (!invoice.callbackUrl) return; // ga ada webhook -> skip

  const payload = {
    event: 'invoice.paid',
    reference: invoice.reference,
    merchantRef: invoice.merchantRef,
    amount: invoice.amount,
    uniqueCode: invoice.uniqueCode,
    totalAmount: invoice.totalAmount,
    status: invoice.status,
    paidAt: invoice.paidAt,
    providerType: invoice.provider?.type,
  };
  const body = JSON.stringify(payload);
  const secret = invoice.apiKey?.secret || config.webhookSecret;
  const signature = sign(body, secret);

  // Simple retry (3x, jarak 2 detik).
  let lastLog;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(invoice.callbackUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Event': 'invoice.paid',
        },
        timeout: 10000,
        validateStatus: () => true,
      });
      lastLog = await prisma.webhookLog.create({
        data: {
          invoiceId: invoice.id,
          url: invoice.callbackUrl,
          requestBody: body,
          responseStatus: res.status,
          responseBody: JSON.stringify(res.data).slice(0, 4000),
          success: res.status >= 200 && res.status < 300,
          attempt,
        },
      });
      if (lastLog.success) return lastLog;
    } catch (err) {
      lastLog = await prisma.webhookLog.create({
        data: {
          invoiceId: invoice.id,
          url: invoice.callbackUrl,
          requestBody: body,
          responseStatus: null,
          responseBody: String(err.message).slice(0, 4000),
          success: false,
          attempt,
        },
      });
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return lastLog;
}

module.exports = { sendForInvoice, sign };
