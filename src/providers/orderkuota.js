/**
 * OrderKuota adapter — port ke Node.js dari PHP wrapper
 * https://github.com/tdede914-creator/orderkuota-api (fork dari yuf1dev/orderkuota-api).
 *
 * Original PHP: MIT License (c) 2023 YuF1Dev.
 * Node.js port: 2026 tdede914-creator. License: MIT.
 * See LICENSE-3RD-PARTY.md di root project.
 *
 * FLOW:
 *   1. requestOtp(username, password) -> OK kirim OTP ke email user
 *   2. verifyOtp(username, otp) -> return {token, userId, name, balance}
 *   3. Token disimpan di Provider.credentials
 *   4. fetchMutations() -> ambil qris_history real-time (bukan pencairan)
 *
 * ENDPOINT (dari analisa source PHP):
 *   - POST https://app.orderkuota.com/api/v2/login   (login + verify OTP, endpoint sama)
 *   - POST https://app.orderkuota.com/api/v2/get     (mutasi + info akun)
 *
 * Format `credentials` (JSON) SETELAH login:
 * {
 *   "username":     "08xxxx",                // no HP / username OK
 *   "authToken":    "20xxxxx:9AySmJYLq...",  // token dari verify OTP
 *   "authUsername": "20xxxxx",               // user_id (bagian sebelum ":" di token)
 *   "appRegId":     "<FCM_reg_id>",          // device id
 *   "phoneUuid":    "<uuid>"                 // phone uuid
 * }
 */

const axios = require('axios');
const crypto = require('crypto');

// Endpoint OrderKuota (dari analisa PHP source YuF1Dev + fork).
const API_BASE = 'https://app.orderkuota.com/api/v2';
const LOGIN_ENDPOINT = `${API_BASE}/login`;      // step 1 & 2 pakai endpoint sama
const GET_ENDPOINT = `${API_BASE}/get`;          // mutasi + saldo

// Default versi app OK. OK server nolak akses qris_history kalau versi
// terlalu lama ("Silakan perbarui aplikasi Order Kuota terlebih dahulu").
// Kalau OK naik versi lagi, user bisa override lewat credentials JSON:
//   { "appVersionName": "26.09.14", "appVersionCode": "260914" }
// Format: YY.MM.DD / YYMMDD (year 2-digit, month, day).
// Bump versi jauh di atas 26.06.27 (yang di Play Store user) karena OK server
// tampaknya cek minimum version untuk qris_history lebih strict — bisa jadi
// versi belum rollout ke device user tapi sudah aktif di server. Kalau
// 26.12.31 masih ditolak, user bisa tune manual di dashboard.
const APP_VERSION_NAME = '26.12.31';
const APP_VERSION_CODE = '261231';
// Bump juga device profile ke modern (Galaxy S24 + Android 14) karena
// SM-G960N (Galaxy S9 2018) + Android 9 kelihatan sangat "outdated" dan
// mungkin di-flag OK anti-scraping.
const PHONE_MODEL = 'SM-S928B';
const PHONE_ANDROID_VERSION = '14';

// Debug: simpan info fetch terakhir supaya bisa di-inspect via Poll Now.
let _lastFetchDebug = null;
function getLastFetchDebug() {
  return _lastFetchDebug;
}
// APP_REG_ID default dari kode PHP (FCM registration ID). Bisa di-override
// via credentials untuk masing-masing user.
const DEFAULT_APP_REG_ID =
  'di309HvATsaiCppl5eDpoc:APA91bFUcTOH8h2XHdPRz2qQ5Bezn-3_TaycFcJ5pNLGWpmaxheQP9Ri0E56wLHz0_b1vcss55jbRQXZgc9loSfBdNa5nZJZVMlk7GS1JDMGyFUVvpcwXbMDg8tjKGZAurCGR4kDMDRJ';
const DEFAULT_PHONE_UUID = 'di309HvATsaiCppl5eDpoc';

function baseHeaders() {
  return {
    Host: 'app.orderkuota.com',
    'User-Agent': 'okhttp/4.12.0',
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function generateAppRegId() {
  const uuid = crypto.randomBytes(16).toString('base64url').slice(0, 22);
  const secret = crypto.randomBytes(140).toString('base64url');
  return `${uuid}:APA91b${secret.slice(0, 148)}`;
}

// ---------------------------------------------------------------------------
// Helper: HTTP call + parsing yang toleran (JSON / text / empty)
// ---------------------------------------------------------------------------
async function callOkApi(endpoint, form, actionLabel) {
  const payloadStr = form.toString();
  let res;
  try {
    res = await axios.post(endpoint, payloadStr, {
      headers: baseHeaders(),
      timeout: 25000,
      validateStatus: () => true,
      transformResponse: [(data) => data],
    });
  } catch (err) {
    if (/ENOTFOUND|ECONNREFUSED|timeout|ETIMEDOUT/i.test(err.message)) {
      throw new Error(
        `OrderKuota ${actionLabel}: koneksi gagal (${err.message}). Cek internet VPS.`,
      );
    }
    throw err;
  }

  const contentType = String(res.headers?.['content-type'] || '');
  const rawBody = String(res.data ?? '');
  // Log agak panjang khusus untuk fetch mutasi supaya kelihatan seluruh struktur data
  const logLimit = actionLabel.includes('mutasi') ? 3000 : 500;
  console.log(
    `[OrderKuota ${actionLabel}] status=${res.status} ct="${contentType}" body_len=${rawBody.length} body_preview="${rawBody.slice(0, logLimit)}"`,
  );

  if (res.status === 469) {
    throw new Error(
      `HTTP 469 dari OrderKuota — "Gunakan Jaringan Internet Lainnya". IP VPS diblokir. Solusi: pindah VPS Indonesia lain (Niagahoster/IDCloudHost) atau pakai OkConnect adapter.`,
    );
  }

  if (!rawBody.trim()) {
    throw new Error(
      `OrderKuota ${actionLabel}: response KOSONG (HTTP ${res.status}, content-type: ${contentType || 'none'}). Endpoint mungkin salah / diblokir.`,
    );
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    const preview = rawBody.slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(
      `OrderKuota ${actionLabel}: response BUKAN JSON (HTTP ${res.status}, content-type: ${contentType}). Preview: ${preview}`,
    );
  }

  // Simpan debug info khusus fetch mutasi
  if (actionLabel.includes('mutasi')) {
    _lastFetchDebug = {
      timestamp: new Date().toISOString(),
      endpoint,
      httpStatus: res.status,
      contentType,
      sentPayload: payloadStr.replace(/(auth_token|password)=[^&]+/g, '$1=***REDACTED***'),
      rawBodyLength: rawBody.length,
      rawBody: rawBody.length > 20000 ? rawBody.slice(0, 20000) + '...[TRUNCATED]' : rawBody,
      parsedTopKeys: data && typeof data === 'object' ? Object.keys(data) : [],
      parsedData: data,
    };
  }

  return { status: res.status, data, rawBody, contentType };
}

// ---------------------------------------------------------------------------
// STEP 1: Login request (kirim OTP ke email)
// ---------------------------------------------------------------------------
// Payload sesuai PHP loginRequest($username, $password):
//   username, password, app_reg_id, app_version_code, app_version_name
// ---------------------------------------------------------------------------
async function requestOtp({ username, password, appRegId }) {
  if (!username || !password) throw new Error('username dan password wajib');
  const regId = appRegId || DEFAULT_APP_REG_ID;

  const form = new URLSearchParams();
  form.append('username', username);
  form.append('password', password);
  form.append('app_reg_id', regId);
  form.append('app_version_code', APP_VERSION_CODE);
  form.append('app_version_name', APP_VERSION_NAME);

  const { status, data } = await callOkApi(LOGIN_ENDPOINT, form, 'request OTP');

  const success = data.success === true || data.status === true;
  if (!success) {
    const msg =
      data.message ||
      data.error ||
      (data.errors && JSON.stringify(data.errors)) ||
      JSON.stringify(data).slice(0, 400);
    throw new Error(`Login OrderKuota gagal (HTTP ${status}): ${msg}`);
  }

  return {
    success: true,
    message:
      data.message ||
      data.results?.message ||
      'OTP dikirim via email OrderKuota',
    appRegId: regId,
  };
}

// ---------------------------------------------------------------------------
// STEP 2: Verify OTP (dapat token)
// ---------------------------------------------------------------------------
// Endpoint sama /api/v2/login. Beda-nya field password diisi OTP.
// ---------------------------------------------------------------------------
async function verifyOtp({ username, otp, appRegId }) {
  if (!otp) throw new Error('OTP wajib');
  const regId = appRegId || DEFAULT_APP_REG_ID;

  const form = new URLSearchParams();
  form.append('username', username);
  form.append('password', otp);
  form.append('app_reg_id', regId);
  form.append('app_version_code', APP_VERSION_CODE);
  form.append('app_version_name', APP_VERSION_NAME);

  const { status, data } = await callOkApi(LOGIN_ENDPOINT, form, 'verify OTP');

  const success = data.success === true || data.status === true;
  if (!success) {
    const msg = data.message || JSON.stringify(data).slice(0, 400);
    throw new Error(`Verify OTP gagal (HTTP ${status}): ${msg}`);
  }

  // Token format standar OrderKuota: "user_id:hash"
  const results = data.results || data.data || {};
  const token =
    results.token ||
    results.auth_token ||
    data.token;
  if (!token) {
    throw new Error(`Response tidak berisi token: ${JSON.stringify(data).slice(0, 400)}`);
  }
  const userId = String(token).split(':')[0];

  return {
    success: true,
    token,
    userId,
    name: results.name || results.nama || '',
    username: results.username || username,
    balance: results.balance || results.saldo || 0,
    qrisName: results.qris_name || '',
    appRegId: regId,
  };
}

// ---------------------------------------------------------------------------
// STEP 3: Fetch mutasi QRIS (dipakai poller)
// ---------------------------------------------------------------------------
// Sesuai PHP getTransactionQris(). Payload minta:
//   requests[0]=account, requests[1]=point,
//   requests[qris_history][jumlah]=30
//   requests[qris_history][selected]=<type>  (opsional: kredit/debet)
// ---------------------------------------------------------------------------
async function fetchMutations(provider) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    throw new Error(`Provider ${provider.name}: credentials JSON invalid`);
  }

  const token = creds.authToken;
  if (!token) {
    throw new Error(
      `Provider ${provider.name}: belum login OrderKuota. Buka menu Providers → Login OrderKuota (OTP).`,
    );
  }
  // auth_username HARUS username STRING (mis. "xxdonn" / "08xxx"),
  // BUKAN user_id numeric. Kalau salah kirim -> OK balas "User tidak ditemukan".
  const authUsername = creds.authUsername || creds.username;
  if (!authUsername) {
    throw new Error(
      `Provider ${provider.name}: credentials tidak punya "authUsername" atau "username". Login ulang lewat menu Providers → OTP.`,
    );
  }
  const appRegId = creds.appRegId || DEFAULT_APP_REG_ID;
  const phoneUuid = creds.phoneUuid || DEFAULT_PHONE_UUID;
  // Version bisa di-override di credentials JSON supaya user bisa update
  // waktu OK naikin versi minimum, tanpa perlu deploy ulang.
  const appVersionName = creds.appVersionName || APP_VERSION_NAME;
  const appVersionCode = creds.appVersionCode || APP_VERSION_CODE;

  const phoneAndroidVersion = creds.phoneAndroidVersion || PHONE_ANDROID_VERSION;
  const phoneModel = creds.phoneModel || PHONE_MODEL;

  const form = new URLSearchParams();
  form.append('request_time', String(Math.floor(Date.now() / 1000)));
  form.append('app_reg_id', appRegId);
  form.append('phone_android_version', phoneAndroidVersion);
  form.append('app_version_code', appVersionCode);
  form.append('phone_uuid', phoneUuid);
  form.append('auth_username', authUsername);
  form.append('requests[0]', 'account');
  form.append('requests[1]', 'point');
  form.append('requests[qris_history][jumlah]', '30');
  form.append('requests[qris_history][selected]', 'kredit'); // hanya masuk
  form.append('auth_token', token);
  form.append('app_version_name', appVersionName);
  form.append('ui_mode', 'light');
  form.append('phone_model', phoneModel);

  const { status, data } = await callOkApi(GET_ENDPOINT, form, 'fetch mutasi');

  // Deteksi token expired.
  if (data.success === false || data.status === false) {
    const msg = String(data.message || '').toLowerCase();
    if (/token|login|auth|expired|otp/.test(msg)) {
      throw new Error(
        `Token OrderKuota expired: "${data.message}". Login ulang lewat menu Providers → OTP.`,
      );
    }
    throw new Error(
      `OrderKuota error (HTTP ${status}): ${data.message || JSON.stringify(data).slice(0, 300)}`,
    );
  }

  // Deteksi khusus: OK nolak qris_history karena versi app ketinggalan.
  const qh = data.qris_history;
  if (qh && qh.success === false && /perbarui aplikasi|update.*version/i.test(String(qh.message || ''))) {
    throw new Error(
      `OrderKuota tolak fetch mutasi: "${qh.message}". ` +
      `Versi app "${appVersionName}" (${appVersionCode}) sudah dianggap outdated. ` +
      `Update credentials JSON di dashboard: tambahkan field "appVersionName" dan "appVersionCode" ` +
      `dengan versi lebih baru. Contoh: {"appVersionName":"26.09.14","appVersionCode":"260914"}. ` +
      `Cek versi terkini di Play Store OrderKuota, atau naikin bertahap sampai diterima OK.`,
    );
  }

  const normalized = normalize(data);
  console.log(
    `[OrderKuota fetch mutasi] normalized=${normalized.length} items` +
      (normalized[0]
        ? `, first={externalId:${normalized[0].externalId}, amount:${normalized[0].amount}}`
        : ''),
  );
  return normalized;
}

/**
 * Cari array mutasi di response OK yang bentuknya bisa bervariasi.
 * Kita coba semua key candidate + walk recursively kalau perlu.
 */
function findMutasiArray(data) {
  // Kandidat path yang umum ditemui di berbagai wrapper OK.
  const candidates = [
    'qris_history.results',
    'results.qris_history.results',
    'data.qris_history.results',
    'qris_history',
    'results.qris_history',
    'data.qris_history',
    'data.mutasi',
    'mutasi',
    'results.mutasi',
    'results',
  ];
  for (const path of candidates) {
    const val = path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), data);
    if (Array.isArray(val) && val.length >= 0) {
      // Prefer array yang isinya "look like" mutasi (punya kredit/keterangan/tanggal)
      if (val.length === 0) return val;
      const sample = val[0];
      if (sample && (sample.kredit !== undefined || sample.keterangan !== undefined || sample.tanggal !== undefined || sample.amount !== undefined)) {
        return val;
      }
    }
  }
  // Fallback: walk data cari array-of-objects yang punya field kredit/keterangan.
  function walk(obj, depth = 0) {
    if (depth > 6 || obj == null) return null;
    if (Array.isArray(obj)) {
      if (obj.length > 0 && typeof obj[0] === 'object' &&
          (obj[0].kredit !== undefined || obj[0].keterangan !== undefined || obj[0].tanggal !== undefined)) {
        return obj;
      }
      return null;
    }
    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        const found = walk(obj[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(data) || [];
}

/**
 * Normalisasi response OrderKuota.
 * Struktur item: { id, kredit, saldo_akhir, keterangan, tanggal, status, brand:{name,logo} }
 */
function normalize(data) {
  const items = findMutasiArray(data);
  if (!Array.isArray(items)) return [];

  return items
    .filter((it) => {
      // Hanya kredit (masuk). PHP fork sudah filter via 'selected=kredit',
      // tapi jaga-jaga kalau field 'status' tetap ada.
      const status = String(it.status || it.type || 'IN').toUpperCase();
      // Kalau kredit > 0, itu masuk. Kalau debit > 0, keluar - skip.
      const kredit = parseInt(String(it.kredit || 0).replace(/[^0-9]/g, ''), 10) || 0;
      const debet = parseInt(String(it.debet || it.debit || 0).replace(/[^0-9]/g, ''), 10) || 0;
      if (kredit > 0) return true;
      if (debet > 0) return false;
      // Fallback: berdasarkan status string
      return ['IN', 'CR', 'CREDIT', 'MASUK'].includes(status);
    })
    .map((it) => {
      const amount =
        parseInt(String(it.kredit || it.amount || it.nominal || 0).replace(/[^0-9]/g, ''), 10) ||
        0;
      const externalId = String(
        it.id ?? it.trx_id ?? it.reference ?? `${it.tanggal || ''}-${amount}`,
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
      message: `Berhasil fetch OrderKuota. Ditemukan ${mutations.length} mutasi masuk terbaru (real-time, sebelum pencairan).`,
      sample: mutations.slice(0, 3).map((m) => ({
        externalId: m.externalId,
        amount: m.amount,
        occurredAt: m.occurredAt,
        brand: m.raw?.brand?.name || '',
        keterangan: m.raw?.keterangan || '',
      })),
    };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

module.exports = {
  fetchMutations,
  testConnection,
  requestOtp,
  verifyOtp,
  generateAppRegId,
  getLastFetchDebug,
  DEFAULT_APP_REG_ID,
  DEFAULT_PHONE_UUID,
};
