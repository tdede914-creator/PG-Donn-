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

// Variant list — round 2 focused pada V7 breakthrough
const VARIANTS = [
  // ============ V7 DEEP DIVE (endpoint yang respond spesifik) ============
  {
    name: 'V7a: /qris/mutation + auth_username=<user_id_numeric>',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/qris/mutation',
    transformParams: (params, creds) => {
      const userId = String(creds.authToken || '').split(':')[0];
      return { ...params, auth_username: userId, jumlah: '30' };
    },
  },
  {
    name: 'V7b: /qris/mutation + user_id in body',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/qris/mutation',
    transformParams: (params, creds) => {
      const userId = String(creds.authToken || '').split(':')[0];
      return { ...params, user_id: userId, jumlah: '30' };
    },
  },
  {
    name: 'V7c: /qris/mutation + id in body',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/qris/mutation',
    transformParams: (params, creds) => {
      const userId = String(creds.authToken || '').split(':')[0];
      return { ...params, id: userId, jumlah: '30' };
    },
  },
  {
    name: 'V7d: /qris/mutation/<user_id> path param',
    method: 'POST',
    urlBuilder: (creds) => {
      const userId = String(creds.authToken || '').split(':')[0];
      return `https://app.orderkuota.com/api/v2/qris/mutation/${userId}`;
    },
    extraParams: { jumlah: '30' },
  },
  {
    name: 'V7e: /qris/mutation minimal (cuma auth_token + user_id)',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/qris/mutation',
    minimalParams: true,
    transformParams: (params, creds) => {
      const userId = String(creds.authToken || '').split(':')[0];
      return {
        auth_token: creds.authToken,
        user_id: userId,
        jumlah: '30',
      };
    },
  },
  {
    name: 'V7f: /qris/mutation + all + userid (no underscore)',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/qris/mutation',
    transformParams: (params, creds) => {
      const userId = String(creds.authToken || '').split(':')[0];
      return { ...params, userid: userId, jumlah: '30' };
    },
  },
  {
    name: 'V7g: /qris/mutation + username_id',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/qris/mutation',
    transformParams: (params, creds) => {
      const userId = String(creds.authToken || '').split(':')[0];
      return { ...params, username_id: userId, jumlah: '30' };
    },
  },
  // ============ Additional endpoint permutations ============
  {
    name: 'V9: /api/v2/qris/history + user_id',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/qris/history',
    transformParams: (params, creds) => {
      const userId = String(creds.authToken || '').split(':')[0];
      return { ...params, user_id: userId, jumlah: '30' };
    },
  },
  {
    name: 'V10: /api/v2/mutation/qris + user_id',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/mutation/qris',
    transformParams: (params, creds) => {
      const userId = String(creds.authToken || '').split(':')[0];
      return { ...params, user_id: userId, jumlah: '30' };
    },
  },
  {
    name: 'V11: /api/v2/qris/get_mutation',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/qris/get_mutation',
    transformParams: (params, creds) => {
      const userId = String(creds.authToken || '').split(':')[0];
      return { ...params, user_id: userId, jumlah: '30' };
    },
  },
  // ============ Original V1 for baseline comparison ============
  {
    name: 'V1: /api/v2/get requests[qris_history][jumlah]=30 (baseline)',
    method: 'POST',
    url: 'https://app.orderkuota.com/api/v2/get',
    extraParams: {
      'requests[0]': 'account',
      'requests[qris_history][jumlah]': '30',
      'requests[qris_history][selected]': 'kredit',
    },
  },
];

async function tryVariant(creds, variant) {
  let params;
  if (variant.transformParams) {
    if (variant.minimalParams) {
      params = variant.transformParams({}, creds);
    } else {
      params = variant.transformParams(buildBaseParams(creds), creds);
    }
  } else {
    params = { ...buildBaseParams(creds), ...(variant.extraParams || {}) };
  }
  const body = new URLSearchParams(params).toString();
  const url = variant.urlBuilder ? variant.urlBuilder(creds) : variant.url;

  const started = Date.now();
  try {
    const res = await axios.post(url, body, {
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

    // Deteksi respons yang "interesting" — bukan generic {success:true} kosong
    let responseType = 'unknown';
    try {
      const parsed = JSON.parse(raw);
      if (parsed.message) responseType = `error:${parsed.message.slice(0, 60)}`;
      else if (Object.keys(parsed).length > 1) responseType = 'has-data';
      else if (parsed.success !== undefined) responseType = 'empty-success';
    } catch (_) {
      if (raw.includes('Just a moment')) responseType = 'cloudflare-block';
      else if (res.status >= 400) responseType = `http-${res.status}`;
    }

    return {
      name: variant.name,
      url,
      httpStatus: res.status,
      contentType: res.headers?.['content-type'] || '',
      bodyLength: raw.length,
      preview: raw.slice(0, 400),
      took,
      hasMutasi,
      mutasiCount,
      subStatus,
      responseType,
    };
  } catch (err) {
    return {
      name: variant.name,
      url: variant.urlBuilder ? '(dynamic)' : variant.url,
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
