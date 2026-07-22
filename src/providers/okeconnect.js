/**
 * OkConnect adapter (okeconnect.com).
 *
 * OkConnect punya API publik untuk merchant: kamu ambil MERCHANT_ID + API_KEY
 * dari dashboard OkConnect, ga perlu sniff/DevTools sama sekali.
 *
 * Endpoint standar:
 *   https://gateway.okeconnect.com/api/mutasi/qris/{MERCHANT_ID}/{API_KEY}
 *
 * Format `credentials` (JSON di kolom Provider.credentials):
 * {
 *   "merchantId": "OK123456",
 *   "apiKey":     "abcdef123456xxxxxxxxxxxxxxx",
 *   "endpoint":   "https://gateway.okeconnect.com/api/mutasi/qris"  // opsional
 * }
 *
 * Response OkConnect biasanya:
 * {
 *   "status": "success",
 *   "data": [
 *     {
 *       "date": "2026-07-21 12:34:56",
 *       "amount": "10001",
 *       "type": "CR",              // "CR" masuk / "DB" keluar
 *       "qris": "static",
 *       "brand_name": "DANA",
 *       "issuer_reff": "..."
 *     }
 *   ]
 * }
 */

const axios = require('axios');

async function fetchMutations(provider) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    throw new Error(`Provider ${provider.name}: credentials JSON invalid`);
  }

  const merchantId = creds.merchantId || creds.merchant_id;
  const apiKey = creds.apiKey || creds.api_key;
  if (!merchantId || !apiKey) {
    throw new Error(
      `Provider ${provider.name}: merchantId dan apiKey wajib diisi di credentials.`,
    );
  }

  const base = (creds.endpoint || 'https://gateway.okeconnect.com/api/mutasi/qris').replace(/\/$/, '');
  const url = `${base}/${encodeURIComponent(merchantId)}/${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await axios.get(url, {
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PaymentGateway/1.0',
      },
    });
  } catch (err) {
    const msg = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}`
      : err.message;
    throw new Error(`OkConnect fetch gagal (${provider.name}): ${msg}`);
  }

  if (res.data && res.data.status && res.data.status !== 'success' && res.data.status !== 'Success') {
    throw new Error(
      `OkConnect response tidak sukses: ${JSON.stringify(res.data).slice(0, 300)}`,
    );
  }

  return normalize(res.data);
}

function normalize(data) {
  // Bisa di root `data` atau langsung array.
  const items = Array.isArray(data) ? data : data?.data || [];
  if (!Array.isArray(items)) return [];

  return items
    .filter((it) => {
      // Hanya kredit / transaksi masuk.
      const type = String(it.type || it.tipe || 'CR').toUpperCase();
      return type === 'CR' || type === 'IN' || type === 'MASUK' || type === 'CREDIT';
    })
    .map((it) => {
      const amountRaw = it.amount ?? it.nominal ?? it.value ?? 0;
      const amount = parseInt(String(amountRaw).replace(/[^0-9]/g, ''), 10) || 0;
      const externalId = String(
        it.issuer_reff ||
          it.reff ||
          it.reference ||
          it.id ||
          `${it.date || ''}-${amount}-${it.brand_name || ''}`,
      );
      const occurredAt = it.date ? new Date(String(it.date).replace(' ', 'T')) : new Date();
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
      message: `Berhasil terhubung ke OkConnect. Ditemukan ${mutations.length} mutasi terbaru.`,
      sample: mutations.slice(0, 3).map((m) => ({
        externalId: m.externalId,
        amount: m.amount,
        occurredAt: m.occurredAt,
      })),
    };
  } catch (err) {
    const msg = err.message || String(err);
    let hint = '';
    if (/401|403|forbidden|unauthor/i.test(msg)) {
      hint = ' — Cek MERCHANT_ID dan API_KEY di dashboard OkConnect (menu Profile/Setting → API).';
    } else if (/404/i.test(msg)) {
      hint = ' — MERCHANT_ID tidak dikenal. Pastikan tepat sesuai dashboard.';
    } else if (/ENOTFOUND|ECONNREFUSED|timeout|ETIMEDOUT/i.test(msg)) {
      hint = ' — VPS ga bisa akses gateway.okeconnect.com. Cek koneksi internet VPS.';
    } else if (/JSON invalid/i.test(msg)) {
      hint = ' — Format credentials bukan JSON valid.';
    } else if (/merchantId dan apiKey wajib/i.test(msg)) {
      hint = ' — Isi 2 field: "merchantId" dan "apiKey" di credentials JSON.';
    }
    return { ok: false, message: msg + hint };
  }
}

module.exports = { fetchMutations, testConnection };
