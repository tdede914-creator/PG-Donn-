/**
 * OrderKuota URL/Payload Variant Explorer.
 *
 * Debug-only. Dipanggil dari dashboard route
 *   POST /providers/:id/explore-variants
 * untuk mencoba beberapa kombinasi endpoint + payload qris_history dan
 * melaporkan mana yang berhasil me-return array mutasi.
 *
 * File ini SEBELUMNYA berisi paste literal `OrderKuota.ts` (TypeScript)
 * dari repo jywa-orkut — akan melempar SyntaxError begitu di-`require()`
 * dan meng-crash handler explore-variants. Modul ini adalah replacement
 * CommonJS murni.
 */

const axios = require('axios');
const qs = require('querystring');

const OK_HEADERS = {
  'User-Agent': 'okhttp/4.12.0',
  Host: 'app.orderkuota.com',
  'Content-Type': 'application/x-www-form-urlencoded',
};

// Kandidat device profile: (Jywa emulator) vs (versi resmi user).
const PROFILES = {
  jywa: {
    app_reg_id:
      'e5aCENGrQOWvhQWYnv-uNc:APA91bFj3O_mv5Nf_2SM4Duz4Z8Ug3nBNaHlgodlY92CBuNIA9xmc0Dahev5xxqssPmnTdcie4mlhiG9ZAE1iCe1QbyhxcUyGXlenJxiUaXdfm1rklOEo9k',
    phone_uuid: 'e5aCENGrQOWvhQWYnv-uNc',
    phone_model: 'sdk_gphone64_x86_64',
    phone_android_version: '16',
    app_version_code: '250811',
    app_version_name: '25.08.11',
    ui_mode: 'light',
  },
  realDevice: {
    app_reg_id:
      'di309HvATsaiCppl5eDpoc:APA91bFUcTOH8h2XHdPRz2qQ5Bezn-3_TaycFcJ5pNLGWpmaxheQP9Ri0E56wLHz0_b1vcss55jbRQXZgc9loSfBdNa5nZJZVMlk7GS1JDMGyFUVvpcwXbMDg8tjKGZAurCGR4kDMDRJ',
    phone_uuid: 'di309HvATsaiCppl5eDpoc',
    phone_model: '25062RN2DY',
    phone_android_version: '15',
    app_version_code: '260627',
    app_version_name: '26.06.27',
    ui_mode: 'light',
  },
};

function buildQrisHistoryPayload(profile, creds, extras = {}) {
  const token = creds.authToken;
  const authUsername = creds.authUsername || creds.username;
  const payload = {
    ...profile,
    request_time: Date.now().toString(),
    auth_username: authUsername,
    auth_token: token,
    'requests[0]': 'account',
    'requests[qris_history][keterangan]': '',
    'requests[qris_history][jumlah]': '',
    'requests[qris_history][page]': '1',
    'requests[qris_history][dari_tanggal]': '',
    'requests[qris_history][ke_tanggal]': '',
    ...extras,
  };
  return payload;
}

/**
 * Coba semua kombinasi endpoint + profile + selected filter. Return array
 * of results untuk ditampilkan di UI.
 */
async function tryAllVariants(provider) {
  let creds = {};
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (_) {
    throw new Error('credentials JSON invalid');
  }

  const token = creds.authToken;
  if (!token) throw new Error('authToken kosong. Login OTP dulu.');
  const tokenId = String(token).split(':')[0];

  const variants = [
    {
      label: 'A. /api/v2/qris/mutasi/{tokenId} + Jywa profile',
      url: `https://app.orderkuota.com/api/v2/qris/mutasi/${encodeURIComponent(tokenId)}`,
      payload: buildQrisHistoryPayload(PROFILES.jywa, creds),
    },
    {
      label: 'B. /api/v2/qris/mutasi/{tokenId} + real-device profile',
      url: `https://app.orderkuota.com/api/v2/qris/mutasi/${encodeURIComponent(tokenId)}`,
      payload: buildQrisHistoryPayload(PROFILES.realDevice, creds),
    },
    {
      label: 'C. /api/v2/get + Jywa profile',
      url: 'https://app.orderkuota.com/api/v2/get',
      payload: buildQrisHistoryPayload(PROFILES.jywa, creds),
    },
    {
      label: 'D. /api/v2/get + real-device profile',
      url: 'https://app.orderkuota.com/api/v2/get',
      payload: buildQrisHistoryPayload(PROFILES.realDevice, creds),
    },
    {
      label: 'E. /api/v2/qris/mutasi/{tokenId} + Jywa profile + selected=kredit',
      url: `https://app.orderkuota.com/api/v2/qris/mutasi/${encodeURIComponent(tokenId)}`,
      payload: buildQrisHistoryPayload(PROFILES.jywa, creds, {
        'requests[qris_history][selected]': 'kredit',
      }),
    },
    {
      label: 'F. /api/v2/qris/mutasi/{tokenId} + Jywa profile + jumlah=30',
      url: `https://app.orderkuota.com/api/v2/qris/mutasi/${encodeURIComponent(tokenId)}`,
      payload: buildQrisHistoryPayload(PROFILES.jywa, creds, {
        'requests[qris_history][jumlah]': '30',
      }),
    },
    {
      label: 'G. /api/v2/get + Jywa profile + selected=kredit + jumlah=30',
      url: 'https://app.orderkuota.com/api/v2/get',
      payload: buildQrisHistoryPayload(PROFILES.jywa, creds, {
        'requests[qris_history][selected]': 'kredit',
        'requests[qris_history][jumlah]': '30',
      }),
    },
    {
      label: 'H. /api/v2/get + real-device profile + selected=kredit + jumlah=30',
      url: 'https://app.orderkuota.com/api/v2/get',
      payload: buildQrisHistoryPayload(PROFILES.realDevice, creds, {
        'requests[qris_history][selected]': 'kredit',
        'requests[qris_history][jumlah]': '30',
      }),
    },
  ];

  const results = [];
  for (const v of variants) {
    const started = Date.now();
    let res;
    try {
      res = await axios.post(v.url, qs.stringify(v.payload), {
        headers: OK_HEADERS,
        timeout: 15000,
        validateStatus: () => true,
        transformResponse: [(d) => d],
      });
    } catch (err) {
      results.push({
        label: v.label,
        url: v.url,
        httpStatus: null,
        error: err.message,
        rawPreview: '',
        qrisHistorySuccess: null,
        qrisHistoryMessage: '',
        mutasiCount: 0,
        elapsedMs: Date.now() - started,
      });
      continue;
    }

    const raw = String(res.data || '');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) {}

    // Lokasi array qris_history yang lazim.
    const qh =
      (parsed && (parsed.qris_history || parsed?.results?.qris_history)) || {};
    const items = Array.isArray(qh.results)
      ? qh.results
      : Array.isArray(qh.data)
        ? qh.data
        : [];

    results.push({
      label: v.label,
      url: v.url,
      httpStatus: res.status,
      qrisHistorySuccess:
        typeof qh.success === 'boolean' ? qh.success : null,
      qrisHistoryMessage: qh.message || '',
      mutasiCount: items.length,
      rawPreview: raw.slice(0, 400),
      elapsedMs: Date.now() - started,
    });
  }

  return results;
}

module.exports = { tryAllVariants };
