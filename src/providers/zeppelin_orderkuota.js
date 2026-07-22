/**
 * Zeppelin OrderKuota adapter.
 *
 * Pakai middleware service https://zeppelin-api.vercel.app yang udah handle
 * semua kompleksitas anti-scraping OrderKuota (HMAC signature, versi check,
 * Play Integrity attestation, dll) di sisi server mereka. Kita jadi client
 * aja — tinggal auth pakai username + auth_token.
 *
 * Refresh auth_token: kunjungi https://zeppelin-api.vercel.app/get-auth,
 * masukkan OrderKuota username, terima OTP, submit → dapat auth_token baru.
 *
 * Endpoints (dari repo zeppelin-orderkuota):
 *   POST /api/v1/payments/create         (bikin invoice, dapat QRIS dinamis)
 *   POST /api/v1/payments/{ref}/status   (cek status per invoice)
 *   POST /api/v1/payments/{ref}/cancel   (cancel)
 *
 * Format credentials (JSON):
 * {
 *   "authUsername": "xxdonn",
 *   "authToken":    "AUTH_TOKEN_DARI_ZEPPELIN",
 *   "apiUrl":       "https://zeppelin-api.vercel.app"   // opsional
 * }
 *
 * KEUNTUNGAN vs balance-delta:
 *   - Per-invoice tracking (no race condition kalau 2 payment bersamaan)
 *   - Zeppelin generate QRIS dinamis dengan exact amount (no unique code trick)
 *   - Anti-scraping OK sudah di-handle Zeppelin
 *
 * TRADE-OFF:
 *   - Depends on Zeppelin uptime (vercel.app)
 *   - Zeppelin server bisa liat semua transaksi kita (privacy)
 */

const axios = require('axios');
const prisma = require('../db');

function getClient(creds) {
  const apiUrl = (creds.apiUrl || 'https://zeppelin-api.vercel.app').replace(/\/$/, '');
  const auth = {
    auth_username: creds.authUsername || creds.username,
    auth_token: creds.authToken,
  };
  if (!auth.auth_username || !auth.auth_token) {
    throw new Error('authUsername dan authToken wajib ada di credentials JSON');
  }
  return { apiUrl, auth, client: axios.create({ baseURL: apiUrl, timeout: 20000 }) };
}

function generateNumericRef() {
  const t = Date.now().toString().slice(-9);
  const r = Math.floor(Math.random() * 900 + 100);
  return parseInt(`${t}${r}`, 10);
}

// ---------------------------------------------------------------------------
// createPaymentOnGateway(provider, amount, opts)
// ---------------------------------------------------------------------------
// Dipanggil dari services/invoice.js pas bikin invoice baru.
// Return normalized shape:
//   { qrisString, totalAmount, uniqueCode, externalRef, expiredAt, raw }
// ---------------------------------------------------------------------------
async function createPaymentOnGateway(provider, amount, opts = {}) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    throw new Error(`credentials JSON invalid`);
  }
  const { client, auth } = getClient(creds);

  const expiryMinutes = Math.max(1, parseInt(opts.expiryMinutes || 15, 10));
  const referenceId = opts.referenceId || generateNumericRef();

  const res = await client.post('/api/v1/payments/create', auth, {
    params: { reference_id: referenceId, amount, expiry: expiryMinutes },
    validateStatus: () => true,
  });
  const data = res.data || {};

  console.log(`[zeppelin create] status=${res.status} body=${JSON.stringify(data).slice(0, 400)}`);

  if (res.status >= 400 || data.status === 'failed' || data.status === false) {
    throw new Error(
      `Zeppelin createPayment gagal (HTTP ${res.status}): ${data.message || data.error || JSON.stringify(data).slice(0, 200)}`,
    );
  }

  // Parse response fleksibel — Zeppelin bisa balikin di root atau di data.data
  const body = data.data || data.result || data;
  const qrisString =
    body.qris_string || body.qris || body.qr_string ||
    body.qrisData || body.qrCode || null;
  if (!qrisString) {
    throw new Error(`Zeppelin ga return QRIS string. Response: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const totalAmount = parseInt(
    String(body.total_amount || body.totalAmount || body.amount || amount).replace(/[^0-9]/g, ''),
    10,
  ) || amount;

  const uniqueCode = parseInt(
    String(body.unique_code || body.uniqueCode || (totalAmount - amount) || 0).replace(/[^0-9]/g, ''),
    10,
  ) || 0;

  const externalRef = String(body.reference_id || body.referenceId || body.reference || referenceId);

  const expiredAt = body.expiry_at || body.expiredAt || body.expired_at
    ? new Date(body.expiry_at || body.expiredAt || body.expired_at)
    : new Date(Date.now() + expiryMinutes * 60_000);

  return {
    qrisString,
    totalAmount,
    uniqueCode,
    externalRef,
    expiredAt,
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// checkStatus(provider, externalRef)
// ---------------------------------------------------------------------------
async function checkStatus(provider, externalRef) {
  const creds = JSON.parse(provider.credentials || '{}');
  const { client, auth } = getClient(creds);

  const res = await client.post(
    `/api/v1/payments/${encodeURIComponent(externalRef)}/status`,
    auth,
    { validateStatus: () => true },
  );
  return { httpStatus: res.status, data: res.data || {} };
}

async function cancelPayment(provider, externalRef) {
  const creds = JSON.parse(provider.credentials || '{}');
  const { client, auth } = getClient(creds);
  const res = await client.post(
    `/api/v1/payments/${encodeURIComponent(externalRef)}/cancel`,
    auth,
    { validateStatus: () => true },
  );
  return { httpStatus: res.status, data: res.data || {} };
}

function isPaidStatus(raw) {
  // Cek beberapa kemungkinan format
  const status = String(
    raw?.status ||
      raw?.data?.status ||
      raw?.result?.status ||
      raw?.payment_status ||
      '',
  ).toLowerCase();
  return ['paid', 'success', 'completed', 'settled', 'ok'].includes(status);
}

// ---------------------------------------------------------------------------
// fetchMutations(provider) — dipanggil poller
// ---------------------------------------------------------------------------
// Untuk setiap invoice PENDING yang punya externalRef, cek status ke Zeppelin.
// Kalau PAID, emit synthetic mutation → matcher mark invoice PAID.
// ---------------------------------------------------------------------------
async function fetchMutations(provider) {
  const pending = await prisma.invoice.findMany({
    where: {
      providerId: provider.id,
      status: 'PENDING',
      expiredAt: { gt: new Date() },
      externalRef: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  if (pending.length === 0) return [];

  const mutations = [];
  for (const inv of pending) {
    try {
      const { httpStatus, data } = await checkStatus(provider, inv.externalRef);
      if (httpStatus >= 400) {
        console.log(`[zeppelin poll] ${inv.reference} HTTP ${httpStatus}: ${JSON.stringify(data).slice(0, 200)}`);
        continue;
      }
      if (isPaidStatus(data)) {
        console.log(`[zeppelin poll] ${inv.reference} → PAID (externalRef=${inv.externalRef})`);
        mutations.push({
          externalId: `ZEP-${inv.externalRef}`,
          amount: inv.totalAmount,
          occurredAt: new Date(),
          raw: { source: 'zeppelin', invoiceRef: inv.reference, statusResponse: data },
        });
      }
    } catch (e) {
      console.error(`[zeppelin poll] ${inv.reference} error: ${e.message}`);
    }
  }
  return mutations;
}

// ---------------------------------------------------------------------------
// testConnection — cek auth valid dgn bikin dummy payment kecil (bisa di-cancel)
// ---------------------------------------------------------------------------
async function testConnection(provider) {
  try {
    // Bikin dummy Rp 100 dengan expiry 1 menit, langsung cancel setelah verify
    const dummy = await createPaymentOnGateway(provider, 100, { expiryMinutes: 1 });
    // Best-effort cancel supaya ga bekas di sistem Zeppelin
    cancelPayment(provider, dummy.externalRef).catch(() => {});
    return {
      ok: true,
      message: `Berhasil auth ke Zeppelin. Dummy payment #${dummy.externalRef} berhasil dibuat & di-cancel. QRIS length: ${dummy.qrisString.length} char.`,
      sample: [
        {
          externalRef: dummy.externalRef,
          totalAmount: dummy.totalAmount,
          uniqueCode: dummy.uniqueCode,
          qrisPreview: dummy.qrisString.slice(0, 40) + '...',
        },
      ],
    };
  } catch (err) {
    const msg = err.message || String(err);
    let hint = '';
    if (/401|403|unauth|auth/i.test(msg)) {
      hint = ' — authToken salah/expired. Refresh di https://zeppelin-api.vercel.app/get-auth';
    } else if (/timeout|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
      hint = ' — VPS ga bisa akses zeppelin-api.vercel.app. Cek koneksi internet VPS.';
    }
    return { ok: false, message: msg + hint };
  }
}

module.exports = {
  fetchMutations,
  testConnection,
  createPaymentOnGateway,
  checkStatus,
  cancelPayment,
  isPaidStatus,
};
