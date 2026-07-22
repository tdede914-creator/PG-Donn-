/**
 * OkConnect H2H API adapter.
 *
 * Pakai endpoint publik yang sama seperti bot Auto-Order-By-Rizz:
 *   GET https://gateway.okeconnect.com/api/mutasi/qris/{MERCHANT_ID}/{API_KEY}
 *
 * Endpoint ini legacy H2H OkConnect — untuk merchant yang sudah pernah
 * dapat API key sebelum OkConnect stop provide. Beda dari:
 *   - `okeconnect` (scrape session cookie okeconnect.com/mutasi)
 *   - `orderkuota` (mobile API app.orderkuota.com/api/v2 - versi-blocked)
 *
 * Format credentials (JSON):
 * {
 *   "merchantId": "OK2447815",
 *   "apiKey":     "442568617503335582447815OKCTA95085B7F6E675C6087EDA93EE038CCD",
 *   "baseUrl":    "https://gateway.okeconnect.com"    // opsional
 * }
 *
 * Response format OkConnect H2H:
 *   {
 *     "status": "success",
 *     "data": [
 *       {
 *         "id": "...",
 *         "date": "2026-07-22 18:22:00",
 *         "amount": "1628",
 *         "type": "CR",
 *         "qris": "static",
 *         "brand_name": "SeaBank",
 *         "issuer_reff": "..."
 *       },
 *       ...
 *     ]
 *   }
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
      `Provider ${provider.name}: field "merchantId" dan "apiKey" wajib diisi.`,
    );
  }

  const baseUrl = (creds.baseUrl || 'https://gateway.okeconnect.com').replace(/\/$/, '');
  const url = `${baseUrl}/api/mutasi/qris/${encodeURIComponent(merchantId)}/${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await axios.get(url, {
      timeout: 20000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PaymentGateway/PG-Donn-',
      },
      validateStatus: () => true,
    });
  } catch (err) {
    if (/ENOTFOUND|ECONNREFUSED|timeout|ETIMEDOUT/i.test(err.message)) {
      throw new Error(`OkConnect H2H koneksi gagal: ${err.message}`);
    }
    throw err;
  }

  // Log untuk debug
  const bodyLen = typeof res.data === 'string' ? res.data.length : JSON.stringify(res.data || {}).length;
  console.log(`[OkConnect H2H] status=${res.status} body_len=${bodyLen}`);

  if (res.status >= 400) {
    const preview = typeof res.data === 'string'
      ? res.data.slice(0, 300)
      : JSON.stringify(res.data).slice(0, 300);
    throw new Error(`OkConnect H2H HTTP ${res.status}: ${preview}`);
  }

  const data = res.data || {};
  // Cek status success
  if (data.status && data.status !== 'success' && data.status !== 'Success' && data.status !== true) {
    throw new Error(
      `OkConnect H2H response tidak sukses: ${data.message || JSON.stringify(data).slice(0, 300)}`,
    );
  }

  return normalize(data);
}

/**
 * Normalisasi response OkConnect H2H ke format seragam kita.
 * Item OkConnect: { id, date, amount, type: "CR", qris, brand_name, issuer_reff }
 */
function normalize(data) {
  const items = Array.isArray(data) ? data : (data?.data || data?.results || []);
  if (!Array.isArray(items)) return [];

  return items
    .filter((it) => {
      // Hanya kredit (masuk)
      const type = String(it.type || 'CR').toUpperCase();
      return type === 'CR' || type === 'IN' || type === 'CREDIT' || type === 'MASUK';
    })
    .map((it) => {
      const amountRaw = it.amount ?? it.nominal ?? it.jumlah ?? 0;
      const amount = parseInt(String(amountRaw).replace(/[^0-9]/g, ''), 10) || 0;

      // externalId untuk dedup — prefer issuer_reff / id / kombinasi
      const externalId = String(
        it.issuer_reff ||
          it.id ||
          it.trx_id ||
          it.reference ||
          `${it.date || ''}-${amount}-${it.brand_name || ''}`,
      );

      const dateStr = String(it.date || it.tanggal || '');
      const occurredAt = dateStr ? new Date(dateStr.replace(' ', 'T')) : new Date();

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
      message: `Berhasil terhubung ke OkConnect H2H. Ditemukan ${mutations.length} mutasi masuk terbaru.`,
      sample: mutations.slice(0, 3).map((m) => ({
        externalId: m.externalId,
        amount: m.amount,
        occurredAt: m.occurredAt,
        brand: m.raw?.brand_name || '',
      })),
    };
  } catch (err) {
    const msg = err.message || String(err);
    let hint = '';
    if (/401|403|forbidden|unauthor/i.test(msg)) {
      hint = ' — API key salah atau nonaktif. Cek nilai apiKey di credentials JSON.';
    } else if (/404/i.test(msg)) {
      hint = ' — merchantId tidak dikenal atau URL endpoint berubah.';
    } else if (/ENOTFOUND|ECONNREFUSED|timeout|ETIMEDOUT/i.test(msg)) {
      hint = ' — VPS ga bisa akses gateway.okeconnect.com.';
    }
    return { ok: false, message: msg + hint };
  }
}

module.exports = { fetchMutations, testConnection };
