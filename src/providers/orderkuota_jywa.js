/**
 * OrderKuota adapter — Jywa flavor.
 *
 * Port dari https://github.com/tdede914-creator/jywa-orkut (fork dari
 * WJayadana/jywa-orkut, MIT). Perbedaan penting vs adapter `orderkuota` lama:
 *
 *   1. Endpoint history: /api/v2/qris/mutasi/{tokenId}  ← bukan /api/v2/get
 *      (spelling: 'mutasi' bahasa Indonesia, bukan 'mutation')
 *      TokenId di URL PATH, bukan body.
 *
 *   2. Device fingerprint match Jywa (Android emulator):
 *        phone_model: "sdk_gphone64_x86_64"
 *        phone_android_version: "16"
 *        app_reg_id + phone_uuid dari FCM real Jywa
 *
 *   3. Payload qris_history semua fields ada (walau kosong):
 *        requests[qris_history][keterangan] = ""
 *        requests[qris_history][jumlah] = ""
 *        requests[qris_history][page] = "1"
 *        requests[qris_history][dari_tanggal] = ""
 *        requests[qris_history][ke_tanggal] = ""
 *        requests[0] = "account"
 *
 *   4. App version pake 25.08.11 / 250811 (Jywa masih di sini).
 *
 * Attribution:
 *   Original: WJayadana <https://github.com/WJayadana/jywa-orkut>
 *   Fork:     tdede914-creator <https://github.com/tdede914-creator/jywa-orkut>
 *   License:  MIT (see LICENSE-3RD-PARTY.md)
 */

const axios = require('axios');
const qs = require('querystring');
const orderkuotaAdapter = require('./orderkuota');

const OK_LOGIN_ENDPOINT = 'https://app.orderkuota.com/api/v2/login';
const OK_GET_ENDPOINT = 'https://app.orderkuota.com/api/v2/get';
// Note: endpoint qris/mutasi butuh {tokenId} di path, build dynamic per request

// Konstanta persis dari Jywa
const OK_CONSTANTS = {
  app_reg_id:
    'e5aCENGrQOWvhQWYnv-uNc:APA91bFj3O_mv5Nf_2SM4Duz4Z8Ug3nBNaHlgodlY92CBuNIA9xmc0Dahev5xxqssPmnTdcie4mlhiG9ZAE1iCe1QbyhxcUyGXlenJxiUaXdfm1rklOEo9k',
  phone_uuid: 'e5aCENGrQOWvhQWYnv-uNc',
  phone_model: 'sdk_gphone64_x86_64',
  phone_android_version: '16',
  app_version_code: '250811',
  app_version_name: '25.08.11',
  ui_mode: 'light',
};

const OK_HEADERS = {
  'User-Agent': 'okhttp/4.12.0',
  Host: 'app.orderkuota.com',
  'Content-Type': 'application/x-www-form-urlencoded',
};

function getConstants(creds) {
  // Allow override lewat credentials JSON, fallback ke Jywa defaults.
  return {
    app_reg_id: creds.appRegId || OK_CONSTANTS.app_reg_id,
    phone_uuid: creds.phoneUuid || OK_CONSTANTS.phone_uuid,
    phone_model: creds.phoneModel || OK_CONSTANTS.phone_model,
    phone_android_version:
      creds.phoneAndroidVersion || OK_CONSTANTS.phone_android_version,
    app_version_code: creds.appVersionCode || OK_CONSTANTS.app_version_code,
    app_version_name: creds.appVersionName || OK_CONSTANTS.app_version_name,
    ui_mode: OK_CONSTANTS.ui_mode,
  };
}

/**
 * Fetch qris_history via endpoint /api/v2/qris/mutasi/{tokenId}.
 * Payload PERSIS format Jywa.
 */
async function fetchQrisHistory(creds, options = {}) {
  const token = creds.authToken;
  if (!token) throw new Error('authToken kosong. Login OTP dulu.');
  const username = creds.username || creds.authUsername;
  const tokenId = String(token).split(':')[0];

  const constants = getConstants(creds);
  const payload = {
    app_reg_id: constants.app_reg_id,
    phone_uuid: constants.phone_uuid,
    phone_model: constants.phone_model,
    'requests[qris_history][keterangan]': options.keterangan || '',
    'requests[qris_history][jumlah]': options.jumlah || '',
    request_time: Date.now().toString(),
    phone_android_version: constants.phone_android_version,
    app_version_code: constants.app_version_code,
    auth_username: username,
    'requests[qris_history][page]': options.page || '1',
    auth_token: token,
    app_version_name: constants.app_version_name,
    ui_mode: constants.ui_mode,
    'requests[qris_history][dari_tanggal]': options.dari_tanggal || '',
    'requests[0]': 'account',
    'requests[qris_history][ke_tanggal]': options.ke_tanggal || '',
  };

  const url = `https://app.orderkuota.com/api/v2/qris/mutasi/${encodeURIComponent(tokenId)}`;
  const body = qs.stringify(payload);

  const res = await axios.post(url, body, {
    headers: OK_HEADERS,
    timeout: 20000,
    validateStatus: () => true,
    transformResponse: [(d) => d],
  });

  const raw = String(res.data || '');
  console.log(
    `[jywa qris_history] status=${res.status} body_len=${raw.length} preview=${raw.slice(0, 500)}`,
  );

  if (res.status === 469) {
    throw new Error('HTTP 469: IP VPS diblokir OrderKuota.');
  }

  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error(`Response bukan JSON: ${raw.slice(0, 300)}`); }

  return data;
}

/**
 * Adapter interface: fetchMutations()
 * Normalize response Jywa ke shape { externalId, amount, occurredAt, raw }.
 */
async function fetchMutations(provider) {
  let creds;
  try { creds = JSON.parse(provider.credentials || '{}'); }
  catch (e) { throw new Error('credentials JSON invalid'); }

  const data = await fetchQrisHistory(creds, { jumlah: '', page: '1' });

  // Deteksi failure
  if (data.success === false) {
    throw new Error(`Jywa QRIS history: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  }
  const qh = data.qris_history || data.results?.qris_history || {};
  if (qh.success === false) {
    throw new Error(`qris_history sub-request gagal: ${qh.message || JSON.stringify(qh).slice(0, 200)}`);
  }

  const items = qh.results || qh.data || [];
  if (!Array.isArray(items)) return [];

  return items
    .filter((it) => {
      const status = String(it.status || it.type || 'IN').toUpperCase();
      const kredit = parseInt(String(it.kredit || 0).replace(/[^0-9]/g, ''), 10) || 0;
      const debet = parseInt(String(it.debet || it.debit || 0).replace(/[^0-9]/g, ''), 10) || 0;
      if (kredit > 0) return true;
      if (debet > 0) return false;
      return ['IN', 'CR', 'CREDIT', 'MASUK'].includes(status);
    })
    .map((it) => {
      const amount =
        parseInt(String(it.kredit || it.amount || it.nominal || 0).replace(/[^0-9]/g, ''), 10) || 0;
      const externalId = String(
        it.id || it.trx_id || it.reference || `${it.tanggal || ''}-${amount}`,
      );
      const dateStr = String(it.tanggal || it.date || '');
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
      message: `Jywa endpoint /qris/mutasi WORKS! Dapat ${mutations.length} mutasi real-time.`,
      sample: mutations.slice(0, 3),
    };
  } catch (err) {
    return {
      ok: false,
      message: err.message,
      hint: 'Cek: (1) authToken valid? (2) device profile match Jywa (sdk_gphone64 + Android 16)? (3) IP VPS ga di-block?',
    };
  }
}

module.exports = {
  fetchMutations,
  testConnection,
  fetchQrisHistory,
  requestOtp: orderkuotaAdapter.requestOtp,
  verifyOtp: orderkuotaAdapter.verifyOtp,
  OK_CONSTANTS,
};
