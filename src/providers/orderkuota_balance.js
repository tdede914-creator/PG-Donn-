/**
 * OrderKuota Balance-Delta adapter.
 *
 * Alternative untuk kondisi dimana `qris_history` diblok OK server (message
 * "Silakan perbarui aplikasi..." — anti-scraping via HMAC/attestation).
 *
 * Kita pakai endpoint `account` yang STILL WORKS untuk get `qris_balance`
 * (saldo QRIS OrderKuota real-time). Setiap poll:
 *   1. Ambil current qris_balance
 *   2. Compare dengan lastKnownBalance yang tersimpan di credentials
 *   3. Kalau naik: create "synthetic mutation" dengan amount = delta
 *   4. Update lastKnownBalance
 *
 * Setelah synthetic mutation di-ingest matcher, invoice PENDING dgn
 * totalAmount = delta akan otomatis di-match jadi PAID.
 *
 * Limitations:
 *   - Kalau 2+ payment masuk dalam interval poll yang sama, delta = jumlah
 *     total. Susah bedain jadi 2 mutation terpisah. Fallback: pecah delta
 *     ke kombinasi invoice PENDING yang totalnya = delta (best-effort).
 *   - Setelah user manual pencairan QRIS (saldo QRIS → saldo akun),
 *     qris_balance akan turun — kita ignore penurunan.
 *   - First run set baseline dari current, tidak deteksi apa-apa.
 *
 * Format credentials JSON (sama seperti adapter `orderkuota`, plus 1 field):
 * {
 *   "username":     "xxdonn",
 *   "authToken":    "20xxxxx:9AySmJYLq...",
 *   "authUsername": "xxdonn",
 *   "appRegId":     "...",
 *   "phoneUuid":    "...",
 *   "appVersionName": "26.06.27",
 *   "appVersionCode": "260627",
 *   "phoneModel":     "25062RN2DY",
 *   "phoneAndroidVersion": "15",
 *   "lastKnownBalance": 1662   // auto-managed by adapter
 * }
 */

const axios = require('axios');
const prisma = require('../db');
const orderkuotaAdapter = require('./orderkuota');

// Pinjam konstanta + helper dari adapter orderkuota untuk konsistensi.
// Karena adapter itu ga export semua internals, kita re-declare yang perlu.
const GET_ENDPOINT = 'https://app.orderkuota.com/api/v2/get';
const APP_VERSION_NAME = '26.06.27';
const APP_VERSION_CODE = '260627';
const PHONE_MODEL = '25062RN2DY';
const PHONE_ANDROID_VERSION = '15';
const DEFAULT_PHONE_UUID = 'di309HvATsaiCppl5eDpoc';
const DEFAULT_APP_REG_ID =
  'di309HvATsaiCppl5eDpoc:APA91bFUcTOH8h2XHdPRz2qQ5Bezn-3_TaycFcJ5pNLGWpmaxheQP9Ri0E56wLHz0_b1vcss55jbRQXZgc9loSfBdNa5nZJZVMlk7GS1JDMGyFUVvpcwXbMDg8tjKGZAurCGR4kDMDRJ';

function baseHeaders() {
  return {
    Host: 'app.orderkuota.com',
    'User-Agent': 'okhttp/4.12.0',
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/**
 * Fetch qris_balance dari endpoint `account`. Endpoint ini MASIH works
 * bahkan waktu qris_history diblok.
 */
async function fetchAccountBalance(creds) {
  const token = creds.authToken;
  if (!token) throw new Error('Belum login OrderKuota. Login OTP dulu.');
  const authUsername = creds.authUsername || creds.username;
  if (!authUsername) throw new Error('authUsername kosong. Login OTP ulang.');

  const form = new URLSearchParams();
  form.append('request_time', String(Math.floor(Date.now() / 1000)));
  form.append('app_reg_id', creds.appRegId || DEFAULT_APP_REG_ID);
  form.append('phone_android_version', creds.phoneAndroidVersion || PHONE_ANDROID_VERSION);
  form.append('app_version_code', creds.appVersionCode || APP_VERSION_CODE);
  form.append('phone_uuid', creds.phoneUuid || DEFAULT_PHONE_UUID);
  form.append('auth_username', authUsername);
  form.append('requests[0]', 'account');   // CUMA account, ga request qris_history
  form.append('auth_token', token);
  form.append('app_version_name', creds.appVersionName || APP_VERSION_NAME);
  form.append('ui_mode', 'light');
  form.append('phone_model', creds.phoneModel || PHONE_MODEL);

  const res = await axios.post(GET_ENDPOINT, form.toString(), {
    headers: baseHeaders(),
    timeout: 20000,
    validateStatus: () => true,
    transformResponse: [(data) => data],
  });

  const rawBody = String(res.data ?? '');
  console.log(`[OK Balance] status=${res.status} body=${rawBody.slice(0, 500)}`);

  if (res.status === 469) {
    throw new Error(`HTTP 469: OrderKuota blokir request. IP VPS di-flag.`);
  }
  if (!rawBody.trim()) {
    throw new Error(`Response kosong dari OrderKuota (HTTP ${res.status}).`);
  }

  let data;
  try { data = JSON.parse(rawBody); }
  catch (e) { throw new Error(`Response bukan JSON: ${rawBody.slice(0, 200)}`); }

  // Cek token expired
  if (data.success === false || data.status === false) {
    const msg = String(data.message || '').toLowerCase();
    if (/token|login|auth|expired|otp/.test(msg)) {
      throw new Error(`Token expired: "${data.message}". Login OTP ulang.`);
    }
    throw new Error(`OK error: ${data.message || rawBody.slice(0, 200)}`);
  }

  // Extract qris_balance dari beberapa kemungkinan struktur
  const accountData =
    data?.account?.results ||
    data?.results?.account ||
    data?.account ||
    {};

  const qrisBalance = parseInt(
    String(accountData.qris_balance ?? accountData.balance ?? 0).replace(/[^0-9]/g, ''),
    10,
  ) || 0;

  return {
    qrisBalance,
    accountRaw: accountData,
    fullResponse: data,
  };
}

/**
 * Main entry point untuk poller.
 * Return array of "synthetic mutations" berdasarkan delta balance.
 */
async function fetchMutations(provider) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    throw new Error(`Provider ${provider.name}: credentials JSON invalid`);
  }

  const { qrisBalance } = await fetchAccountBalance(creds);

  const lastKnownBalance =
    creds.lastKnownBalance !== undefined && creds.lastKnownBalance !== null
      ? parseInt(creds.lastKnownBalance, 10)
      : null;

  // First run: set baseline, no detection
  if (lastKnownBalance === null) {
    console.log(`[OK Balance] baseline set to ${qrisBalance} (first run, no mutation emitted)`);
    await saveLastBalance(provider.id, creds, qrisBalance);
    return [];
  }

  const delta = qrisBalance - lastKnownBalance;

  // Balance turun (pencairan / adjust) — update baseline, no mutation
  if (delta < 0) {
    console.log(`[OK Balance] balance turun ${lastKnownBalance} -> ${qrisBalance} (pencairan?), update baseline`);
    await saveLastBalance(provider.id, creds, qrisBalance);
    return [];
  }

  // No change
  if (delta === 0) {
    return [];
  }

  // Balance NAIK → payment masuk sebesar delta
  console.log(`[OK Balance] 💰 delta=${delta} (${lastKnownBalance} -> ${qrisBalance})`);
  await saveLastBalance(provider.id, creds, qrisBalance);

  // Simple: 1 synthetic mutation dgn amount = delta
  // Matcher nanti coba find invoice PENDING dgn totalAmount == delta.
  return [
    {
      externalId: `BAL-${Date.now()}-${delta}`,
      amount: delta,
      occurredAt: new Date(),
      raw: {
        source: 'balance-delta',
        from: lastKnownBalance,
        to: qrisBalance,
        delta,
      },
    },
  ];
}

/**
 * Update lastKnownBalance di credentials JSON provider.
 */
async function saveLastBalance(providerId, creds, newBalance) {
  const newCreds = { ...creds, lastKnownBalance: newBalance };
  await prisma.provider.update({
    where: { id: providerId },
    data: { credentials: JSON.stringify(newCreds) },
  });
}

async function testConnection(provider) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    return { ok: false, message: 'Credentials JSON invalid' };
  }
  try {
    const { qrisBalance, accountRaw } = await fetchAccountBalance(creds);
    const lastKnownBalance =
      creds.lastKnownBalance !== undefined && creds.lastKnownBalance !== null
        ? parseInt(creds.lastKnownBalance, 10)
        : null;
    return {
      ok: true,
      message:
        `Berhasil fetch saldo OrderKuota. QRIS balance sekarang: Rp ${qrisBalance.toLocaleString('id-ID')}. ` +
        (lastKnownBalance === null
          ? `Baseline BELUM diset — poll pertama akan set baseline, mulai deteksi setelah itu.`
          : `Baseline tersimpan: Rp ${lastKnownBalance.toLocaleString('id-ID')}. Delta: Rp ${(qrisBalance - lastKnownBalance).toLocaleString('id-ID')}.`),
      sample: [
        {
          currentQrisBalance: qrisBalance,
          lastKnownBalance,
          accountName: accountRaw?.name || accountRaw?.qris_name,
        },
      ],
    };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

// Re-export requestOtp/verifyOtp dari orderkuota adapter — flow login sama.
module.exports = {
  fetchMutations,
  testConnection,
  requestOtp: orderkuotaAdapter.requestOtp,
  verifyOtp: orderkuotaAdapter.verifyOtp,
};
