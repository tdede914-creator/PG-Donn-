/**
 * OrderKuota adapter.
 *
 * OrderKuota tidak punya API publik resmi untuk mutasi QRIS, jadi umumnya
 * dipakai endpoint internal aplikasi mobile / dashboard. Endpoint bisa berubah,
 * karena itu di-config lewat credentials JSON supaya gampang ganti tanpa
 * ubah kode.
 *
 * Format `credentials` (JSON di kolom Provider.credentials):
 * {
 *   "authToken":   "TOKEN_LOGIN_ORDERKUOTA",       // Bearer / auth_token
 *   "authUsername":"USERNAME_ATAU_ID",              // opsional (dipakai app OK)
 *   "endpoint":    "https://app.orderkuota.com/api/v2/get/qris_history",
 *   "method":      "POST"                           // POST atau GET
 * }
 *
 * Cara dapat authToken:
 *   1. Login ke OrderKuota (via app) -> Settings -> API/Developer, atau
 *   2. Sniff request "qris_history" dari aplikasi mobile pakai proxy.
 *
 * Adapter ini mengembalikan mutasi ter-normalisasi. Bila response OrderKuota
 * berubah, cukup edit fungsi normalize() di bawah.
 */

const axios = require('axios');

async function fetchMutations(provider) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    throw new Error(`Provider ${provider.name}: credentials JSON invalid`);
  }

  const endpoint =
    creds.endpoint || 'https://app.orderkuota.com/api/v2/get/qris_history';
  const method = (creds.method || 'POST').toUpperCase();

  const params = {
    auth_token: creds.authToken,
    auth_username: creds.authUsername || '',
    // OrderKuota biasanya ambil N history terakhir; sesuaikan kalau perlu.
    requests: JSON.stringify({ qris_history: { jumlah: 30 } }),
  };

  let res;
  try {
    if (method === 'GET') {
      res = await axios.get(endpoint, { params, timeout: 15000 });
    } else {
      // OK umumnya pakai x-www-form-urlencoded.
      const form = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => form.append(k, String(v ?? '')));
      res = await axios.post(endpoint, form.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'okhttp/4.9.3',
        },
        timeout: 15000,
      });
    }
  } catch (err) {
    const msg = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}`
      : err.message;
    throw new Error(`OrderKuota fetch gagal (${provider.name}): ${msg}`);
  }

  return normalize(res.data);
}

/**
 * Normalisasi response OrderKuota.
 *
 * Struktur umum (bisa berbeda per versi):
 * {
 *   "success": true,
 *   "results": {
 *     "qris_history": {
 *       "results": [
 *         {
 *           "id": "12345",
 *           "amount": "10001",
 *           "type": "CR",           // "CR" = credit / masuk
 *           "date": "2026-07-21 12:34:56",
 *           "note": "..."
 *         }
 *       ]
 *     }
 *   }
 * }
 *
 * Jika struktur berubah, sesuaikan pemetaan di bawah.
 */
function normalize(data) {
  const items =
    data?.results?.qris_history?.results ||
    data?.qris_history ||
    data?.results ||
    [];

  if (!Array.isArray(items)) return [];

  return items
    .filter((it) => {
      // Hanya transaksi masuk (kredit). Sesuaikan kalau field beda.
      const type = String(it.type || it.transaction_type || '').toUpperCase();
      if (type && type !== 'CR' && type !== 'IN' && type !== 'MASUK') return false;
      return true;
    })
    .map((it) => {
      const amountRaw = it.amount ?? it.nominal ?? it.value ?? 0;
      const amount = parseInt(String(amountRaw).replace(/[^0-9]/g, ''), 10) || 0;
      const externalId = String(
        it.id ?? it.trx_id ?? it.reference ?? `${it.date}-${amount}`,
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

module.exports = { fetchMutations };
