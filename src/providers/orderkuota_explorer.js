/**
 * URL Explorer untuk OrderKuota API.
 *
 * Adapter debugging yang coba MULTIPLE variant URL/payload buat cari
 * endpoint/param yang lolos anti-scraping OK. Tidak untuk polling production,
 * cuma untuk discovery. Dipanggil dari tombol "Try All Variants" di dashboard.
 *
 * Reuse credentials dari provider orderkuota_balance (authToken dll).
 */

const axios = require('axios');

const HOST = 'app.orderkuota.com';
const APP_VERSION_NAME = '26.06.27';
const APP_VERSION_CODE = '260627';

function baseHeaders() {
  return {
    Host: HOST,
    'User-Agent': 'okhttp/4.12.0',
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function buildBaseParams(creds) {
  const token = creds.authToken;
  const authUsername = creds.authUsername || creds.username;
  return {
    request_time: String(Math.floor(Date.now() / 1000)),
    app_reg_id: creds.appRegId || '',
    phone_android_version: creds.phoneAndroidVersion || '15',
    app_version_code: creds.appVersionCode || APP_VERSION_CODE,
    phone_uuid: creds.phoneUuid || '',
    auth_username: authUsername,
    auth_token: token,
    app_version_name: creds.appVersionName || APP_VERSION_NAME,
    ui_mode: 'light',
    phone_model: creds.phoneModel || '25062RN2DY',
  };
}

// Variant list — kombinasi endpoint URL + payload berbeda
const VARIANTS = [
  {
    name: 'V1: /api/v2/get requests[qris_history][jumlah]=30 (current)',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/get',
    extraParams: {
      'requests[0]': 'account',
      'requests[qris_history][jumlah]': '30',
      'requests[qris_history][selected]': 'kredit',
    },
  },
  {
    name: 'V2: /api/v2/get requests[2]=qris_history (simple)',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/get',
    extraParams: {
      'requests[0]': 'account',
      'requests[1]': 'point',
      'requests[2]': 'qris_history',
    },
  },
  {
    name: 'V3: /api/v2/get requests[qris_mutation][jumlah]=30',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/get',
    extraParams: {
      'requests[qris_mutation][jumlah]': '30',
    },
  },
  {
    name: 'V4: /api/v2/get requests[qris_transactions][limit]=30',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/get',
    extraParams: {
      'requests[qris_transactions][limit]': '30',
    },
  },
  {
    name: 'V5: /api/v2/get requests[mutasi_qris]=1',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/get',
    extraParams: {
      'requests[mutasi_qris]': '1',
    },
  },
  {
    name: 'V6: /api/v2/qris_history dedicated endpoint',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/qris_history',
    extraParams: { jumlah: '30' },
  },
  {
    name: 'V7: /api/v2/qris/mutation dedicated endpoint',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/qris/mutation',
    extraParams: { jumlah: '30' },
  },
  {
    name: 'V8: /api/v3/get (newer version)',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v3/get',
    extraParams: {
      'requests[0]': 'account',
      'requests[qris_history][jumlah]': '30',
    },
  },
];

async function tryVariant(creds, variant) {
  const params = { ...buildBaseParams(creds), ...variant.extraParams };
  const body = new URLSearchParams(params).toString();

  const started = Date.now();
  try {
    const res = await axios.post(variant.url, body, {
      headers: baseHeaders(),
      timeout: 15000,
      validateStatus: () => true,
      transformResponse: [(data) => data],
    });
    const raw = String(res.data ?? '');
    const took = Date.now() - started;

    // Try parse JSON, cek kalau qris_history-like data ada
    let hasMutasi = false;
    let subStatus = null;
    let mutasiCount = 0;
    try {
      const parsed = JSON.parse(raw);
      const qh = parsed.qris_history || parsed.qris_mutation || parsed.qris_transactions || parsed.mutasi_qris;
      if (qh) {
        subStatus = qh.success !== undefined ? qh.success : 'has-key';
        if (Array.isArray(qh.results) || Array.isArray(qh.data)) {
          const arr = qh.results || qh.data;
          hasMutasi = arr.length > 0;
          mutasiCount = arr.length;
        }
      }
    } catch (_) {}

    return {
      name: variant.name,
      url: variant.url,
      httpStatus: res.status,
      contentType: res.headers?.['content-type'] || '',
      bodyLength: raw.length,
      preview: raw.slice(0, 400),
      took,
      hasMutasi,
      mutasiCount,
      subStatus,
    };
  } catch (err) {
    return {
      name: variant.name,
      url: variant.url,
      error: err.message,
      took: Date.now() - started,
    };
  }
}

async function tryAllVariants(provider) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    throw new Error('credentials JSON invalid');
  }
  if (!creds.authToken) throw new Error('authToken kosong. Login OTP dulu.');

  const results = [];
  for (const variant of VARIANTS) {
    const r = await tryVariant(creds, variant);
    console.log(`[explorer] ${variant.name} → HTTP ${r.httpStatus} mutasi=${r.mutasiCount}`);
    results.push(r);
    // Sedikit delay biar ga rate-limited
    await new Promise((r) => setTimeout(r, 300));
  }
  return results;
}

module.exports = { tryAllVariants, VARIANTS };
