/**
 * OrderKuota adapter — OrderKuota-KOBONGCLOUDSERVER flavor.
 *
 * Sekarang self-contained: OTP login + fetch qris_history + normalize
 * semuanya di sini. Tidak lagi bergantung ke adapter `orderkuota` lama.
 *
 * Endpoint yang dipakai:
 *   - POST /api/v2/login              → request OTP + verify OTP (dapat token)
 *   - POST /api/v2/qris/mutasi/{tokenId} → fetch mutasi qris_history real-time
 *
 * Attribution: pola request qris_history di endpoint /qris/mutasi/{tokenId}
 * mengikuti library open-source WJayadana/jywa-orkut (MIT). Lihat
 * LICENSE-3RD-PARTY.md untuk teks lisensi lengkap.
 */

const axios = require('axios');
const qs = require('querystring');
const crypto = require('crypto');

// -- Endpoints --------------------------------------------------------------
const API_BASE = 'https://app.orderkuota.com/api/v2';
const OK_LOGIN_ENDPOINT = `${API_BASE}/login`;

function buildQrisMutasiEndpoint(token) {
  const tokenId = String(token).split(':')[0];
  return `${API_BASE}/qris/mutasi/${encodeURIComponent(tokenId)}`;
}

// -- Device profile constants ----------------------------------------------
// Fingerprint default (Android emulator profile). User boleh override via
// credentials JSON pakai field: appRegId, phoneUuid, phoneModel,
// phoneAndroidVersion, appVersionCode, appVersionName.
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
  Host: 'app.orderkuota.com',
  'User-Agent': 'okhttp/4.12.0',
  'Accept-Encoding': 'gzip',
  'Content-Type': 'application/x-www-form-urlencoded',
};

function getConstants(creds = {}) {
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

function generatePhoneUuid() {
  return crypto.randomBytes(16).toString('base64url').slice(0, 22);
}

function generateAppRegId() {
  const uuid = generatePhoneUuid();
  const secret = crypto.randomBytes(140).toString('base64url');
  return `${uuid}:APA91b${secret.slice(0, 148)}`;
}

// -- Debug hook -------------------------------------------------------------
// Simpan snapshot response terakhir supaya dashboard /providers/:id/poll-now
// bisa nge-render raw response OrderKuota buat troubleshooting.
let _lastFetchDebug = null;
function getLastFetchDebug() {
  return _lastFetchDebug;
}

// -- HTTP helper toleran ---------------------------------------------------
async function callOkApi(endpoint, form, actionLabel) {
  const payloadStr = form.toString();
  let res;
  try {
    res = await axios.post(endpoint, payloadStr, {
      headers: OK_HEADERS,
      timeout: 25000,
      validateStatus: () => true,
      transformResponse: [(d) => d],
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
  const logLimit = actionLabel.includes('mutasi') ? 3000 : 500;
  console.log(
    `[OrderKuota ${actionLabel}] status=${res.status} ct="${contentType}" body_len=${rawBody.length} body_preview="${rawBody.slice(0, logLimit)}"`,
  );

  if (res.status === 469) {
    throw new Error(
      'HTTP 469 dari OrderKuota — IP VPS diblokir ("Gunakan Jaringan Internet Lainnya"). Solusi: pindah VPS Indonesia lain.',
    );
  }

  if (!rawBody.trim()) {
    throw new Error(
      `OrderKuota ${actionLabel}: response KOSONG (HTTP ${res.status}, content-type: ${contentType || 'none'}).`,
    );
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    throw new Error(
      `OrderKuota ${actionLabel}: response BUKAN JSON (HTTP ${res.status}). Preview: ${rawBody.slice(0, 300).replace(/\s+/g, ' ')}`,
    );
  }

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

// -- Step 1: request OTP (kirim OTP ke email user) -------------------------
async function requestOtp({ username, password, appRegId }) {
  if (!username || !password) throw new Error('username dan password wajib');
  const regId = appRegId || generateAppRegId();

  const constants = getConstants({ appRegId: regId });
  const form = new URLSearchParams();
  form.append('username', username);
  form.append('password', password);
  form.append('app_reg_id', regId);
  form.append('app_version_code', constants.app_version_code);
  form.append('app_version_name', constants.app_version_name);

  const { status, data } = await callOkApi(OK_LOGIN_ENDPOINT, form, 'request OTP');
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
      data.message || data.results?.message || 'OTP dikirim via email OrderKuota',
    appRegId: regId,
  };
}

// -- Step 2: verify OTP (dapat token) --------------------------------------
async function verifyOtp({ username, otp, appRegId }) {
  if (!otp) throw new Error('OTP wajib');
  const regId = appRegId || OK_CONSTANTS.app_reg_id;

  const constants = getConstants({ appRegId: regId });
  const form = new URLSearchParams();
  form.append('username', username);
  form.append('password', otp);
  form.append('app_reg_id', regId);
  form.append('app_version_code', constants.app_version_code);
  form.append('app_version_name', constants.app_version_name);

  const { status, data } = await callOkApi(OK_LOGIN_ENDPOINT, form, 'verify OTP');
  const success = data.success === true || data.status === true;
  if (!success) {
    const msg = data.message || JSON.stringify(data).slice(0, 400);
    throw new Error(`Verify OTP gagal (HTTP ${status}): ${msg}`);
  }

  const results = data.results || data.data || {};
  const token = results.token || results.auth_token || data.token;
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

// -- Step 3: fetch qris_history via /api/v2/qris/mutasi/{tokenId} ---------
async function fetchQrisHistory(creds, options = {}) {
  const token = creds.authToken;
  if (!token) {
    throw new Error(
      'authToken kosong. Login OTP dulu lewat menu Providers → Kirim OTP.',
    );
  }
  const username = creds.username || creds.authUsername;
  if (!username) {
    throw new Error(
      'credentials tidak punya "authUsername" atau "username". Login ulang lewat menu Providers → OTP.',
    );
  }
  const constants = getConstants(creds);

  const form = new URLSearchParams();
  form.append('app_reg_id', constants.app_reg_id);
  form.append('phone_uuid', constants.phone_uuid);
  form.append('phone_model', constants.phone_model);
  form.append('requests[qris_history][keterangan]', options.keterangan || '');
  form.append('requests[qris_history][jumlah]', options.jumlah || '');
  form.append('request_time', Date.now().toString());
  form.append('phone_android_version', constants.phone_android_version);
  form.append('app_version_code', constants.app_version_code);
  form.append('auth_username', username);
  form.append('requests[qris_history][page]', options.page || '1');
  form.append('auth_token', token);
  form.append('app_version_name', constants.app_version_name);
  form.append('ui_mode', constants.ui_mode);
  form.append('requests[qris_history][dari_tanggal]', options.dari_tanggal || '');
  form.append('requests[0]', 'account');
  form.append('requests[qris_history][ke_tanggal]', options.ke_tanggal || '');

  const endpoint = buildQrisMutasiEndpoint(token);
  const { data } = await callOkApi(endpoint, form, 'fetch mutasi');
  return data;
}

// -- Adapter interface: fetchMutations() -----------------------------------
async function fetchMutations(provider) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    throw new Error(`Provider ${provider.name}: credentials JSON invalid`);
  }

  const data = await fetchQrisHistory(creds, { jumlah: '', page: '1' });

  if (data.success === false || data.status === false) {
    const msg = String(data.message || '').toLowerCase();
    if (/token|login|auth|expired|otp/.test(msg)) {
      throw new Error(
        `Token OrderKuota expired: "${data.message}". Login ulang lewat menu Providers → OTP.`,
      );
    }
    throw new Error(
      `OrderKuota fetch mutasi gagal: ${data.message || JSON.stringify(data).slice(0, 300)}`,
    );
  }

  const qh = data.qris_history || data.results?.qris_history || {};
  if (qh.success === false) {
    if (/perbarui aplikasi|update.*version/i.test(String(qh.message || ''))) {
      throw new Error(
        `OrderKuota tolak fetch mutasi: "${qh.message}". Tambahkan/override "appVersionName" & "appVersionCode" di credentials JSON dengan versi lebih baru.`,
      );
    }
    throw new Error(
      `qris_history sub-request gagal: ${qh.message || JSON.stringify(qh).slice(0, 200)}`,
    );
  }

  const items = qh.results || qh.data || [];
  const normalized = normalize(items);
  console.log(
    `[OrderKuota fetch mutasi] normalized=${normalized.length} items` +
      (normalized[0]
        ? `, first={externalId:${normalized[0].externalId}, amount:${normalized[0].amount}}`
        : ''),
  );
  return normalized;
}

function normalize(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => {
      const status = String(it.status || it.type || 'IN').toUpperCase();
      const kredit = parseInt(String(it.kredit || 0).replace(/[^0-9]/g, ''), 10) || 0;
      const debet =
        parseInt(String(it.debet || it.debit || 0).replace(/[^0-9]/g, ''), 10) || 0;
      if (kredit > 0) return true;
      if (debet > 0) return false;
      return ['IN', 'CR', 'CREDIT', 'MASUK'].includes(status);
    })
    .map((it) => {
      const amount =
        parseInt(
          String(it.kredit || it.amount || it.nominal || 0).replace(/[^0-9]/g, ''),
          10,
        ) || 0;
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
      message: `Berhasil fetch mutasi OrderKuota. Ditemukan ${mutations.length} mutasi masuk terbaru.`,
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
  fetchQrisHistory,
  requestOtp,
  verifyOtp,
  generateAppRegId,
  getLastFetchDebug,
  OK_CONSTANTS,
};
