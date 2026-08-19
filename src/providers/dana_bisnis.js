/**
 * DANA Bisnis (Dabis) adapter — pengganti OrderKuota QRIS.
 *
 * Membaca mutasi/riwayat transaksi merchant DANA Bisnis lalu menormalkannya
 * ke bentuk yang dipakai poller + matcher PG-Donn:
 *   { externalId, amount, occurredAt, raw }
 *
 * Model auth: access token (Bearer) + refresh token, ATAU cookie sesi.
 * TIDAK ada RSA signing (beda dengan kekhawatiran awal) — cukup header
 * Authorization/Cookie biasa, mirip yono99/dana-api-gateway (MIT). Lihat
 * LICENSE-3RD-PARTY.md untuk atribusi.
 *
 * PENTING — endpoint DANA di sini BUKAN API publik resmi & default-nya masih
 * TEBAKAN (warisan yono99). Semua bisa di-override lewat credentials JSON:
 *   apiBase, txPath, refreshPath, otpRequestPath, otpVerifyPath, dst.
 * Isi dengan nilai ASLI hasil capture (DevTools portal web / intercept app).
 * Pakai tombol "Poll Now (debug)" di halaman Providers untuk melihat raw
 * response DANA dan mengkalibrasi txPath + fieldMap sampai mutasi terbaca.
 */

const axios = require('axios');

// -- Default (placeholder, WAJIB diverifikasi) ------------------------------
const DEFAULTS = {
  apiBase: 'https://api.saas.dana.id',
  txPath: '/v1/merchant/transactions',
  refreshPath: '/v1/oauth/token/refresh',
  otpRequestPath: '/v1/oauth/otp/send',
  otpVerifyPath: '/v1/oauth/otp/verify',
  clientId: 'dana-business-web',
  authScheme: 'Bearer', // prefix header Authorization; kosongkan utk token mentah
  tokenHeader: 'Authorization',
  grantType: 'REFRESH_TOKEN',
  userAgent:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  pageSize: 25,
  lookbackMinutes: 3 * 24 * 60, // 3 hari
  statusFilter: 'SUCCESS,SETTLED,CAPTURE',
  dateFormat: 'iso', // 'iso' | 'unix' | 'unix_ms'
  timeoutMs: 15000,
};

// Kandidat field default utk parsing response (dibuat toleran seperti yono99,
// karena bentuk asli response DANA belum dikonfirmasi). Semua bisa ditimpa
// lewat credentials.fieldMap.
const FIELD_DEFAULTS = {
  listPaths: [
    'transactions',
    'data.transactions',
    'data.list',
    'data.records',
    'data.rows',
    'list',
    'records',
    'rows',
    'data',
  ],
  amount: [
    'gross_amount',
    'real_gross_amount',
    'amount.value',
    'amount',
    'totalAmount',
    'payAmount',
    'nominal',
    'value',
  ],
  id: [
    'id',
    'transactionId',
    'transaction_id',
    'acquirementId',
    'order_id',
    'orderId',
    'merchantOrderId',
    'wallstreet_transaction_id',
    'referenceNo',
  ],
  time: [
    'transaction_time',
    'transactionTime',
    'settlement_time',
    'created_at',
    'createdAt',
    'finishTime',
    'paidTime',
    'time',
  ],
  status: ['transaction_status', 'status', 'txnStatus', 'state'],
  direction: ['direction', 'type', 'txnType', 'creditDebitIndicator'],
};

const CONFIG_KEYS = Object.keys(DEFAULTS);

function getConfig(creds = {}) {
  const cfg = {};
  for (const k of CONFIG_KEYS) {
    cfg[k] = creds[k] != null && creds[k] !== '' ? creds[k] : DEFAULTS[k];
  }
  cfg.apiBase = String(cfg.apiBase).replace(/\/$/, '');
  cfg.fieldMap = { ...FIELD_DEFAULTS, ...(creds.fieldMap || {}) };
  cfg.extraHeaders = creds.extraHeaders || {};
  cfg.extraParams = creds.extraParams || {};
  cfg.includeAll = creds.includeAll === true; // true = jangan filter arah (debit/kredit)
  return cfg;
}

// -- util: ambil nilai dari object via daftar path (dukung "a.b.c") ---------
function getPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((o, key) => (o != null ? o[key] : undefined), obj);
}

function pick(obj, candidates) {
  for (const c of candidates || []) {
    const v = getPath(obj, c);
    if (v != null && v !== '') return v;
  }
  return undefined;
}

function toInt(v) {
  return parseInt(String(v == null ? 0 : v).replace(/[^0-9]/g, ''), 10) || 0;
}

// -- Header sesi ------------------------------------------------------------
function buildHeaders(creds, cfg) {
  const headers = {
    'User-Agent': creds.userAgent || cfg.userAgent,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Country-Code': 'ID',
    'X-Locale': 'id_ID',
    'X-Client-Id': creds.clientId || cfg.clientId,
    ...cfg.extraHeaders,
  };
  if (creds.accessToken) {
    const scheme = cfg.authScheme ? `${cfg.authScheme} ` : '';
    headers[cfg.tokenHeader || 'Authorization'] = `${scheme}${creds.accessToken}`;
  }
  if (creds.cookie) headers.Cookie = creds.cookie;
  if (creds.merchantId) headers['X-Merchant-Id'] = creds.merchantId;
  if (creds.deviceId) headers['X-Device-Id'] = creds.deviceId;
  return headers;
}

function isExpired(creds) {
  if (!creds || !creds.expiresAt) return false; // tak tahu → biar 401 yang menentukan
  const exp = new Date(creds.expiresAt).getTime();
  if (isNaN(exp)) return false;
  return Date.now() >= exp - 5 * 60 * 1000; // refresh 5 menit sebelum exp
}

// -- Debug hook (dipakai poll-now utk render raw response) ------------------
let _lastFetchDebug = null;
function getLastFetchDebug() {
  return _lastFetchDebug;
}

function redactHeaders(h) {
  const out = { ...h };
  if (out.Authorization) out.Authorization = '***REDACTED***';
  if (out.Cookie) out.Cookie = '***REDACTED***';
  return out;
}

// -- Persist credentials balik ke DB (setelah refresh token) ----------------
// Adapter menerima row Provider; kalau token di-refresh kita simpan lagi
// supaya poll berikutnya tidak refresh terus. Guard: hanya kalau ada id asli
// (>0). Untuk preview/test (id=0) tidak menyentuh DB.
async function persistCredentials(provider, credsObj) {
  if (!provider || !provider.id) return;
  try {
    const prisma = require('../db');
    await prisma.provider.update({
      where: { id: provider.id },
      data: { credentials: JSON.stringify(credsObj) },
    });
    provider.credentials = JSON.stringify(credsObj); // sinkron di memori
  } catch (e) {
    console.error('[DANA] gagal simpan credentials hasil refresh:', e.message);
  }
}

// -- Refresh access token ---------------------------------------------------
async function refreshSession(provider, creds, cfg) {
  if (!creds.refreshToken) {
    // Tanpa refresh_token: kalau masih ada token/cookie, pakai apa adanya.
    if (creds.accessToken || creds.cookie) return creds;
    throw new Error('Tidak ada refreshToken/accessToken/cookie. Login/import ulang.');
  }

  const url = `${cfg.apiBase}${cfg.refreshPath}`;
  let res;
  try {
    res = await axios.post(
      url,
      { grantType: cfg.grantType, refreshToken: creds.refreshToken },
      {
        headers: buildHeaders(creds, cfg),
        timeout: cfg.timeoutMs,
        validateStatus: () => true,
      },
    );
  } catch (err) {
    if (creds.accessToken || creds.cookie) {
      console.warn(`[DANA] refresh error (${err.message}); pakai token lama.`);
      return creds;
    }
    throw new Error(`DANA refresh gagal: ${err.message}`);
  }

  if (res.status >= 400) {
    // Beberapa deployment cuma pakai cookie panjang → token lama masih valid.
    if (creds.accessToken || creds.cookie) {
      console.warn(`[DANA] refresh ditolak (HTTP ${res.status}); pakai token lama.`);
      return creds;
    }
    throw new Error(
      `DANA refresh gagal HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`,
    );
  }

  const body = res.data?.data || res.data || {};
  const setCookie = res.headers?.['set-cookie'];
  const cookieFromSet = Array.isArray(setCookie)
    ? setCookie.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ')
    : null;
  const expiresIn = Number(body.expiresIn || body.expires_in || 6 * 60 * 60);

  const updated = {
    ...creds,
    accessToken: body.accessToken || body.access_token || body.token || creds.accessToken,
    refreshToken: body.refreshToken || body.refresh_token || creds.refreshToken,
    cookie: cookieFromSet || creds.cookie,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
  await persistCredentials(provider, updated);
  console.log('[DANA] access token di-refresh.');
  return updated;
}

// -- Bangun query param mutasi ----------------------------------------------
function fmtDate(d, dateFormat) {
  if (dateFormat === 'unix') return String(Math.floor(d.getTime() / 1000));
  if (dateFormat === 'unix_ms') return String(d.getTime());
  return d.toISOString();
}

function buildTxParams(cfg, creds) {
  const now = new Date();
  const from = new Date(now.getTime() - Number(cfg.lookbackMinutes) * 60 * 1000);
  const start = fmtDate(from, cfg.dateFormat);
  const end = fmtDate(now, cfg.dateFormat);
  const merchantId = creds.merchantId || '';
  const size = Number(cfg.pageSize);
  return {
    merchantId,
    merchant_id: merchantId,
    pageSize: size,
    size,
    startTime: start,
    endTime: end,
    start_time: start,
    end_time: end,
    status: cfg.statusFilter,
    ...cfg.extraParams,
  };
}

function extractRawTransactions(data, cfg) {
  if (Array.isArray(data)) return data;
  for (const p of cfg.fieldMap.listPaths) {
    const v = getPath(data, p);
    if (Array.isArray(v)) return v;
  }
  return [];
}

// -- Normalisasi → { externalId, amount, occurredAt, raw } ------------------
function normalize(items, cfg) {
  if (!Array.isArray(items)) return [];
  const fm = cfg.fieldMap;
  const seen = new Set();
  const out = [];

  for (const it of items) {
    // Filter arah transaksi: buang debit/refund/keluar kecuali includeAll.
    if (!cfg.includeAll) {
      const dir = String(pick(it, fm.direction) || '').toUpperCase();
      if (/DEBIT|OUT|REFUND|REVERS|WITHDRAW|KELUAR/.test(dir)) continue;
    }

    const amount = toInt(pick(it, fm.amount));
    if (amount <= 0) continue;

    const rawTime = pick(it, fm.time);
    let occurredAt = rawTime ? new Date(rawTime) : new Date();
    if (isNaN(occurredAt.getTime())) {
      // mungkin unix seconds
      const n = Number(rawTime);
      occurredAt = n > 1e12 ? new Date(n) : n > 1e9 ? new Date(n * 1000) : new Date();
    }

    const idVal = pick(it, fm.id);
    const externalId = String(
      idVal != null ? idVal : `${rawTime || occurredAt.toISOString()}-${amount}`,
    );

    if (seen.has(externalId)) continue; // dedup dalam satu batch
    seen.add(externalId);

    out.push({ externalId, amount, occurredAt, raw: it });
  }
  return out;
}

// -- GET transaksi (dengan snapshot debug) ----------------------------------
async function fetchTransactionsRaw(cfg, creds, headers) {
  const url = `${cfg.apiBase}${cfg.txPath}`;
  const params = buildTxParams(cfg, creds);
  const res = await axios.get(url, {
    headers,
    params,
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
  });

  _lastFetchDebug = {
    timestamp: new Date().toISOString(),
    endpoint: url,
    sentParams: params,
    sentHeaders: redactHeaders(headers),
    httpStatus: res.status,
    contentType: String(res.headers?.['content-type'] || ''),
    parsedTopKeys:
      res.data && typeof res.data === 'object' ? Object.keys(res.data) : [],
    parsedData: res.data,
    rawBodyLength:
      typeof res.data === 'string'
        ? res.data.length
        : JSON.stringify(res.data ?? '').length,
  };
  return res;
}

// -- Adapter interface: fetchMutations() ------------------------------------
async function fetchMutations(provider) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    throw new Error(`Provider ${provider.name}: credentials JSON invalid`);
  }

  let cfg = getConfig(creds);

  if (!creds.accessToken && !creds.cookie) {
    throw new Error(
      'DANA belum login: credentials tidak punya "accessToken" atau "cookie". ' +
        'Login lewat panel DANA (OTP) atau tempel token hasil capture.',
    );
  }

  // Refresh proaktif kalau tahu sudah/mau expired.
  if (isExpired(creds) && creds.refreshToken) {
    try {
      creds = await refreshSession(provider, creds, cfg);
      cfg = getConfig(creds);
    } catch (e) {
      console.warn('[DANA] refresh proaktif gagal:', e.message);
    }
  }

  let headers = buildHeaders(creds, cfg);
  let res = await fetchTransactionsRaw(cfg, creds, headers);

  // 401/403 → coba refresh sekali lalu ulang.
  if ((res.status === 401 || res.status === 403) && creds.refreshToken) {
    console.warn(`[DANA] sesi ditolak (HTTP ${res.status}). Auto-refresh...`);
    creds = await refreshSession(provider, creds, cfg);
    cfg = getConfig(creds);
    headers = buildHeaders(creds, cfg);
    res = await fetchTransactionsRaw(cfg, creds, headers);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `DANA sesi invalid (HTTP ${res.status}). Login/import ulang token DANA.`,
    );
  }
  if (res.status >= 400) {
    throw new Error(
      `DANA API HTTP ${res.status} di ${cfg.txPath}. ` +
        `Cek "apiBase"/"txPath" di credentials (endpoint masih perlu diverifikasi). ` +
        `Detail: ${JSON.stringify(res.data).slice(0, 200)}`,
    );
  }

  const items = extractRawTransactions(res.data, cfg);
  const normalized = normalize(items, cfg);
  console.log(
    `[DANA fetch mutasi] raw=${items.length} normalized=${normalized.length}` +
      (normalized[0]
        ? ` first={externalId:${normalized[0].externalId}, amount:${normalized[0].amount}}`
        : ''),
  );
  if (items.length && !normalized.length) {
    console.warn(
      '[DANA] ada transaksi tapi 0 ter-normalize — kemungkinan fieldMap (amount/id/time) ' +
        'belum cocok dengan bentuk response. Lihat "Poll Now (debug)".',
    );
  }
  return normalized;
}

async function testConnection(provider) {
  let cfg;
  try {
    cfg = getConfig(JSON.parse(provider.credentials || '{}'));
  } catch (_) {
    cfg = getConfig({});
  }
  try {
    const mutations = await fetchMutations(provider);
    return {
      ok: true,
      message:
        `Berhasil akses DANA (${cfg.apiBase}${cfg.txPath}). ` +
        `Ditemukan ${mutations.length} mutasi masuk terbaru.`,
      sample: mutations.slice(0, 3).map((m) => ({
        externalId: m.externalId,
        amount: m.amount,
        occurredAt: m.occurredAt,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      message:
        `${err.message}` +
        `\n(endpoint aktif: ${cfg.apiBase}${cfg.txPath} — sesuaikan di credentials bila salah)`,
    };
  }
}

// -- Login OTP (endpoint configurable; default masih tebakan) ---------------
function toMsisdn62(phone) {
  let p = String(phone).replace(/[\s\-]/g, '');
  if (p.startsWith('+62')) p = '0' + p.slice(3);
  if (p.startsWith('62') && p.length > 10) p = '0' + p.slice(2);
  return '62' + p.slice(1);
}

async function requestOtp({ phone, creds = {} }) {
  if (!phone) throw new Error('Nomor HP wajib');
  const cfg = getConfig(creds);
  const url = `${cfg.apiBase}${cfg.otpRequestPath}`;
  const body = {
    phoneNumber: toMsisdn62(phone),
    phone,
    channel: creds.otpChannel || 'SMS',
    clientId: cfg.clientId,
  };
  const res = await axios.post(url, body, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Country-Code': 'ID' },
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(
      `Request OTP DANA gagal HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}. ` +
        `Endpoint OTP mungkin beda — sesuaikan "otpRequestPath", atau pakai import token manual.`,
    );
  }
  const data = res.data?.data || res.data || {};
  return {
    otpToken: data.otpToken || data.otp_token || data.requestId || data.request_id || null,
    message: data.message || 'OTP dikirim (cek SMS/WA).',
  };
}

async function verifyOtp({ phone, otp, otpToken, creds = {} }) {
  if (!otp) throw new Error('OTP wajib');
  const cfg = getConfig(creds);
  const url = `${cfg.apiBase}${cfg.otpVerifyPath}`;
  const body = {
    phoneNumber: toMsisdn62(phone),
    phone,
    otp,
    otpToken,
    otp_token: otpToken,
    clientId: cfg.clientId,
  };
  const res = await axios.post(url, body, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Country-Code': 'ID' },
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(
      `Verifikasi OTP DANA gagal HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`,
    );
  }
  const data = res.data?.data || res.data || {};
  const setCookie = res.headers?.['set-cookie'];
  const cookie = Array.isArray(setCookie)
    ? setCookie.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ')
    : null;
  const accessToken = data.accessToken || data.access_token || data.token || null;
  if (!accessToken && !cookie) {
    throw new Error(
      'Login DANA gagal: token/cookie tidak ditemukan di response. ' +
        `Keys: ${Object.keys(data).join(', ') || '-'}. Coba import token manual.`,
    );
  }
  const expiresIn = Number(data.expiresIn || data.expires_in || 6 * 60 * 60);
  // Kembalikan objek credentials yang siap disimpan (endpoint dari cfg agar
  // konsisten dengan yang dipakai fetch mutasi).
  const credentials = {
    apiBase: cfg.apiBase,
    txPath: cfg.txPath,
    refreshPath: cfg.refreshPath,
    accessToken,
    refreshToken: data.refreshToken || data.refresh_token || null,
    cookie,
    merchantId:
      data.merchantId || data.merchant_id || data.shopId || creds.merchantId || null,
    phone,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
  return {
    credentials,
    merchantName: data.merchantName || data.merchant_name || data.shopName || null,
    merchantId: credentials.merchantId,
  };
}

module.exports = {
  fetchMutations,
  testConnection,
  requestOtp,
  verifyOtp,
  refreshSession,
  normalize,
  getConfig,
  getLastFetchDebug,
  DEFAULTS,
};
