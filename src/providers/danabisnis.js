/**
 * DANA Bisnis adapter.
 *
 * DANA punya 2 jalur:
 *  A. Official Merchant API (butuh onboarding sebagai merchant DANA, ada docs
 *     resmi & signature RSA). Endpoint biasanya di dashboard.dana.id.
 *  B. Scrape session dashboard bisnis (endpoint web internal). Rentan berubah.
 *
 * Adapter ini generic HTTP: kamu kasih endpoint + headers via credentials.
 *
 * Format `credentials` (JSON di kolom Provider.credentials):
 * {
 *   "endpoint": "https://api-partner.dana.id/v1/merchant/transaction/history",
 *   "method":   "POST",
 *   "headers":  { "Authorization": "Bearer xxx", "X-Signature": "..." },
 *   "body":     { "startDate": "AUTO_TODAY", "endDate": "AUTO_TODAY" },
 *   "resultsPath": "data.transactions"     // path ke array di response
 * }
 *
 * Field khusus:
 *  - AUTO_TODAY di body akan otomatis diganti tanggal hari ini (YYYY-MM-DD).
 *  - resultsPath: dot-path menuju array transaksi di response.
 */

const axios = require('axios');

function getByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function expandAuto(body) {
  if (!body || typeof body !== 'object') return body;
  const out = Array.isArray(body) ? [] : {};
  for (const [k, v] of Object.entries(body)) {
    if (v === 'AUTO_TODAY') out[k] = todayStr();
    else if (typeof v === 'object' && v !== null) out[k] = expandAuto(v);
    else out[k] = v;
  }
  return out;
}

async function fetchMutations(provider) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    throw new Error(`Provider ${provider.name}: credentials JSON invalid`);
  }

  if (!creds.endpoint) {
    throw new Error(`Provider ${provider.name}: endpoint DANA Bisnis belum di-set`);
  }

  const method = (creds.method || 'POST').toUpperCase();
  const headers = creds.headers || {};
  const body = expandAuto(creds.body || {});

  let res;
  try {
    if (method === 'GET') {
      res = await axios.get(creds.endpoint, { headers, params: body, timeout: 15000 });
    } else {
      res = await axios({
        method,
        url: creds.endpoint,
        headers: { 'Content-Type': 'application/json', ...headers },
        data: body,
        timeout: 15000,
      });
    }
  } catch (err) {
    const msg = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}`
      : err.message;
    throw new Error(`DANA Bisnis fetch gagal (${provider.name}): ${msg}`);
  }

  const items = getByPath(res.data, creds.resultsPath || 'data') || [];
  if (!Array.isArray(items)) return [];

  return items
    .filter((it) => {
      const type = String(it.transactionType || it.type || 'IN').toUpperCase();
      // Hanya transaksi masuk.
      return ['IN', 'CREDIT', 'CR', 'MASUK', 'RECEIVE'].includes(type) || !it.transactionType;
    })
    .map((it) => {
      const amountRaw = it.amount?.value ?? it.amount ?? it.nominal ?? 0;
      const amount = parseInt(String(amountRaw).replace(/[^0-9]/g, ''), 10) || 0;
      const externalId = String(
        it.transactionId || it.trxId || it.referenceNo || it.id || `${it.transactionTime}-${amount}`,
      );
      const occurredRaw = it.transactionTime || it.createdTime || it.time || Date.now();
      const occurredAt = new Date(occurredRaw);
      return {
        externalId,
        amount,
        occurredAt: isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
        raw: it,
      };
    })
    .filter((m) => m.amount > 0);
}

async function testConnection(provider) {
  try {
    const mutations = await fetchMutations(provider);
    return {
      ok: true,
      message: `Berhasil terhubung. Ditemukan ${mutations.length} mutasi terbaru.`,
      sample: mutations.slice(0, 3).map((m) => ({
        externalId: m.externalId,
        amount: m.amount,
        occurredAt: m.occurredAt,
      })),
    };
  } catch (err) {
    const msg = err.message || String(err);
    let hint = '';
    if (/401|403|token|signature/i.test(msg)) {
      hint = ' — Kemungkinan token/signature invalid atau kadaluarsa. Grab ulang dari dashboard.dana.id (F12 → Network → copy Authorization & X-Signature).';
    } else if (/endpoint DANA Bisnis belum/i.test(msg)) {
      hint = ' — Field "endpoint" wajib ada di credentials JSON.';
    } else if (/ENOTFOUND|ECONNREFUSED|timeout|ETIMEDOUT/i.test(msg)) {
      hint = ' — Cek koneksi internet VPS atau endpoint tidak valid.';
    } else if (/JSON invalid/i.test(msg)) {
      hint = ' — Format credentials bukan JSON valid.';
    }
    return { ok: false, message: msg + hint };
  }
}

module.exports = { fetchMutations, testConnection };
