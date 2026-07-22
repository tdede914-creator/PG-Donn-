/**
 * OrderKuota adapter dengan OTP-based login (seperti JAGOPAY).
 *
 * FLOW:
 *   1. User isi username + password OrderKuota di dashboard
 *   2. requestOtp() → panggil app.orderkuota.com → OK kirim OTP ke email user
 *   3. User masukkan OTP
 *   4. verifyOtp() → dapat token format "user_id:hash..."
 *   5. Token disimpan di Provider.credentials
 *   6. fetchMutations() pakai token → hit /api/v2/get/qris_history
 *
 * Format `credentials` (JSON) SETELAH login:
 * {
 *   "username":     "08xxxx",              // no HP / username OK
 *   "authToken":    "20xxxxx:9AySmJYLq...",// token dari verify OTP
 *   "authUsername": "20xxxxx",             // user_id (bagian sebelum ":" di token)
 *   "appRegId":     "AABBCC..."            // device id (auto-generated)
 * }
 *
 * Endpoint bisa di-override di credentials:
 *   loginEndpoint, verifyEndpoint, historyEndpoint
 */

const axios = require('axios');
const crypto = require('crypto');

const DEFAULT_LOGIN_ENDPOINT = 'https://app.orderkuota.com/api/login';
const DEFAULT_VERIFY_ENDPOINT = 'https://app.orderkuota.com/api/login/verify';
const DEFAULT_HISTORY_ENDPOINT = 'https://app.orderkuota.com/api/v2/get/qris_history';

// User-agent + versi app mimic client Android OK terbaru (bisa outdated).
// Kalau OrderKuota update dan versi ini ditolak, user bisa override via credentials.
const APP_VERSION_NAME = '25.06.14';
const APP_VERSION_CODE = '250614';

function baseHeaders() {
  return {
    'User-Agent': 'okhttp/4.9.3',
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function generateAppRegId() {
  // 22 char base64url, mirip firebase reg id
  return crypto.randomBytes(16).toString('base64url');
}

function friendlyError(err, action) {
  if (err.response) {
    const status = err.response.status;
    let hint = '';
    if (status === 469) {
      hint =
        ' — IP VPS kamu diblokir OrderKuota. Solusi: (1) Pindah VPS ke provider Indonesia (Niagahoster, Biznet Gio, IDCloudHost), atau (2) pakai OkConnect adapter yang tidak kena block.';
    } else if (status === 401 || status === 403) {
      hint = ' — Username/password salah atau session expired.';
    }
    return new Error(
      `OrderKuota ${action}: HTTP ${status}: ${JSON.stringify(err.response.data).slice(0, 300)}${hint}`,
    );
  }
  if (/ENOTFOUND|ECONNREFUSED|timeout|ETIMEDOUT/i.test(err.message)) {
    return new Error(`OrderKuota ${action}: koneksi gagal (${err.message}). Cek internet VPS.`);
  }
  return err;
}

// ---------------------------------------------------------------------------
// Helper: HTTP call ke OrderKuota + parsing yang toleran (JSON / text / empty).
// ---------------------------------------------------------------------------
async function callOkApi(endpoint, form, actionLabel) {
  let res;
  try {
    res = await axios.post(endpoint, form.toString(), {
      headers: baseHeaders(),
      timeout: 25000,
      validateStatus: () => true,
      // Keep raw response as string so kita bisa parse manual (handle non-JSON)
      transformResponse: [(data) => data],
    });
  } catch (err) {
    throw friendlyError(err, actionLabel);
  }

  const contentType = String(res.headers?.['content-type'] || '');
  const rawBody = String(res.data ?? '');
  // Debug log ke stdout — muncul di pm2 logs
  console.log(
    `[OrderKuota ${actionLabel}] endpoint=${endpoint} status=${res.status} ct="${contentType}" body="${rawBody.slice(0, 400)}"`,
  );

  if (res.status === 469) {
    throw new Error(
      `HTTP 469 dari OrderKuota — "Gunakan Jaringan Internet Lainnya". IP VPS masih diblokir. Solusi: pindah provider VPS Indonesia lain, atau pakai OkConnect adapter.`,
    );
  }

  // Kosong / bukan JSON → error dengan detail
  if (!rawBody.trim()) {
    throw new Error(
      `OrderKuota ${actionLabel}: response KOSONG (HTTP ${res.status}, content-type: ${contentType || 'none'}). Endpoint mungkin salah / diblokir silently.`,
    );
  }
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    // Response bukan JSON — biasanya HTML (blocking page, login page, dsb)
    const preview = rawBody.slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(
      `OrderKuota ${actionLabel}: response BUKAN JSON (HTTP ${res.status}, content-type: ${contentType}). Preview: ${preview}`,
    );
  }

  return { status: res.status, data, rawBody, contentType };
}

// ---------------------------------------------------------------------------
// STEP 1: Request OTP
// ---------------------------------------------------------------------------
async function requestOtp({ username, password, appRegId }) {
  if (!username || !password) throw new Error('username dan password wajib');
  const regId = appRegId || generateAppRegId();

  const form = new URLSearchParams();
  form.append('username', username);
  form.append('password', password);
  form.append('app_reg_id', regId);
  form.append('app_version_name', APP_VERSION_NAME);
  form.append('app_version_code', APP_VERSION_CODE);

  const { status, data } = await callOkApi(DEFAULT_LOGIN_ENDPOINT, form, 'request OTP');

  const success = data.success === true || data.status === true;
  if (!success) {
    const msg =
      data.message ||
      data.error ||
      data.errors ||
      JSON.stringify(data).slice(0, 400);
    throw new Error(`Login OrderKuota gagal (HTTP ${status}): ${msg}`);
  }

  return {
    success: true,
    message: data.message || data.results?.message || 'OTP dikirim via email OrderKuota kamu',
    appRegId: regId,
  };
}

// ---------------------------------------------------------------------------
// STEP 2: Verify OTP
// ---------------------------------------------------------------------------
async function verifyOtp({ username, password, otp, appRegId }) {
  if (!otp) throw new Error('OTP wajib');
  if (!appRegId) throw new Error('appRegId hilang — request OTP dulu');

  const form = new URLSearchParams();
  form.append('username', username);
  form.append('password', password);
  form.append('otp', otp);
  form.append('app_reg_id', appRegId);
  form.append('app_version_name', APP_VERSION_NAME);
  form.append('app_version_code', APP_VERSION_CODE);

  const { status, data } = await callOkApi(DEFAULT_VERIFY_ENDPOINT, form, 'verify OTP');

  const success = data.success === true || data.status === true;
  if (!success) {
    const msg = data.message || JSON.stringify(data).slice(0, 400);
    throw new Error(`Verify OTP gagal (HTTP ${status}): ${msg}`);
  }

  const results = data.results || data.data || {};
  const token = results.token || results.auth_token;
  if (!token) {
    throw new Error(`Response tidak berisi token: ${JSON.stringify(data).slice(0, 400)}`);
  }

  // Token format standar OrderKuota: "user_id:hash"
  const userId = String(token).split(':')[0];

  return {
    success: true,
    token,
    userId,
    name: results.name || results.nama || '',
    username: results.username || username,
    balance: results.balance || results.saldo || 0,
    qrisName: results.qris_name || '',
  };
}

// ---------------------------------------------------------------------------
// STEP 3: Fetch mutasi (dipakai poller)
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
  const authUsername = creds.authUsername || String(token).split(':')[0];
  const endpoint = creds.historyEndpoint || DEFAULT_HISTORY_ENDPOINT;

  const form = new URLSearchParams();
  form.append('auth_token', token);
  form.append('auth_username', authUsername);
  form.append('app_reg_id', creds.appRegId || '');
  form.append('app_version_name', APP_VERSION_NAME);
  form.append('app_version_code', APP_VERSION_CODE);
  form.append(
    'requests',
    JSON.stringify({ qris_history: { jumlah: 30 } }),
  );

  let res;
  try {
    res = await axios.post(endpoint, form.toString(), {
      headers: baseHeaders(),
      timeout: 20000,
      validateStatus: () => true,
    });
  } catch (err) {
    throw friendlyError(err, 'fetch mutasi');
  }

  if (res.status === 469) {
    throw new Error(
      `HTTP 469: OrderKuota blokir VPS ini pada fetch mutasi. Pakai VPS Indonesia atau OkConnect.`,
    );
  }

  const data = res.data || {};

  // Deteksi token expired.
  if (data.success === false || data.status === false) {
    const msg = String(data.message || '').toLowerCase();
    if (/token|login|auth|expired|otp/i.test(msg)) {
      throw new Error(
        `Token OrderKuota expired: "${data.message}". Login ulang lewat menu Providers → Login OrderKuota.`,
      );
    }
    throw new Error(`OrderKuota response error: ${data.message || JSON.stringify(data).slice(0, 300)}`);
  }

  return normalize(data);
}

/**
 * Struktur mutasi OrderKuota (mengikuti format JAGOPAY docs & app OK):
 *   data.results.qris_history.results[]
 *   atau data.data.mutasi[]
 * Item:
 *   { id, kredit, saldo_akhir, keterangan, tanggal, status, brand: {name, logo} }
 */
function normalize(data) {
  const items =
    data?.results?.qris_history?.results ||
    data?.data?.mutasi ||
    data?.mutasi ||
    [];
  if (!Array.isArray(items)) return [];

  return items
    .filter((it) => {
      const status = String(it.status || it.type || 'IN').toUpperCase();
      return ['IN', 'CR', 'CREDIT', 'MASUK'].includes(status);
    })
    .map((it) => {
      const amountRaw = it.kredit ?? it.amount ?? it.nominal ?? 0;
      const amount = parseInt(String(amountRaw).replace(/[^0-9]/g, ''), 10) || 0;
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
      message: `Berhasil fetch OrderKuota. Ditemukan ${mutations.length} mutasi masuk terbaru.`,
      sample: mutations.slice(0, 3).map((m) => ({
        externalId: m.externalId,
        amount: m.amount,
        occurredAt: m.occurredAt,
        brand: m.raw?.brand?.name || m.raw?.keterangan || '',
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
};
