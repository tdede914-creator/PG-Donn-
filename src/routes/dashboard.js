const express = require('express');
const bcrypt = require('bcryptjs');
const { customAlphabet } = require('nanoid');
const prisma = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

const keyGen = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 32);
const secretGen = customAlphabet(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  48,
);

// ----- Dashboard -----
router.get('/', async (req, res) => {
  const [totalInvoices, paidInvoices, pendingInvoices, providers, recent] =
    await Promise.all([
      prisma.invoice.count(),
      prisma.invoice.count({ where: { status: 'PAID' } }),
      prisma.invoice.count({ where: { status: 'PENDING' } }),
      prisma.provider.count({ where: { isActive: true } }),
      prisma.invoice.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { provider: true },
      }),
    ]);
  const revenue = await prisma.invoice.aggregate({
    _sum: { amount: true },
    where: { status: 'PAID' },
  });
  res.render('dashboard', {
    stats: { totalInvoices, paidInvoices, pendingInvoices, providers, revenue: revenue._sum.amount || 0 },
    recent,
    session: req.session,
    active: 'dashboard',
  });
});

// ----- Invoices -----
router.get('/invoices', async (req, res) => {
  const status = req.query.status || '';
  const where = status ? { status } : {};
  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { provider: true },
  });
  res.render('invoices', { invoices, status, session: req.session, active: 'invoices' });
});

router.get('/invoices/:ref', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { reference: req.params.ref },
    include: { provider: true, apiKey: true, webhookLogs: { orderBy: { createdAt: 'desc' } } },
  });
  if (!invoice) return res.status(404).send('Invoice tidak ditemukan');
  res.render('invoice-detail', { invoice, session: req.session, active: 'invoices' });
});

// ----- Providers -----
router.get('/providers', async (req, res) => {
  const providers = await prisma.provider.findMany({ orderBy: { createdAt: 'desc' } });
  res.render('providers', {
    providers,
    session: req.session,
    active: 'providers',
    flash: req.flash('info')[0],
    error: req.flash('error')[0],
  });
});

router.post('/providers', async (req, res) => {
  const { name, type, qrisStatic, credentials } = req.body;
  try {
    // Validasi credentials JSON
    JSON.parse(credentials || '{}');
    await prisma.provider.create({
      data: {
        name: String(name).trim(),
        type: String(type),
        qrisStatic: String(qrisStatic).trim(),
        credentials: String(credentials || '{}'),
      },
    });
    req.flash('info', 'Provider ditambahkan');
  } catch (e) {
    req.flash('error', `Gagal simpan: ${e.message}`);
  }
  res.redirect('/providers');
});

router.post('/providers/:id/toggle', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = await prisma.provider.findUnique({ where: { id } });
  if (p) {
    await prisma.provider.update({ where: { id }, data: { isActive: !p.isActive } });
  }
  res.redirect('/providers');
});

router.post('/providers/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    // Cascade delete: hapus invoice + mutation dulu (FK), baru provider.
    // Tanpa ini, delete FAIL diam-diam karena FK constraint dan user
    // heran "kenapa provider ga bisa dihapus?".
    await prisma.$transaction([
      prisma.webhookLog.deleteMany({
        where: { invoice: { providerId: id } },
      }),
      prisma.invoice.deleteMany({ where: { providerId: id } }),
      prisma.mutation.deleteMany({ where: { providerId: id } }),
      prisma.provider.delete({ where: { id } }),
    ]);
    req.flash('info', 'Provider berhasil dihapus (termasuk invoice & mutation terkait).');
  } catch (e) {
    console.error('[provider delete] error:', e);
    req.flash('error', `Gagal hapus provider: ${e.message}`);
  }
  res.redirect('/providers');
});

// Update credentials JSON provider tanpa harus hapus + bikin ulang.
router.post('/providers/:id/update-credentials', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { credentials } = req.body;
  try {
    JSON.parse(credentials || '{}');   // validate
    await prisma.provider.update({
      where: { id },
      data: { credentials: String(credentials || '{}') },
    });
    res.json({ ok: true, message: 'Credentials di-update.' });
  } catch (e) {
    res.json({ ok: false, message: `Gagal: ${e.message}` });
  }
});

// Ambil credentials existing (untuk pre-fill di UI Edit).
router.get('/providers/:id/credentials', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = await prisma.provider.findUnique({
    where: { id },
    select: { credentials: true, type: true, name: true },
  });
  if (!p) return res.status(404).json({ ok: false });
  res.json({ ok: true, ...p });
});

// Test connection ke provider (JSON response biar UI bisa render feedback).
router.post('/providers/:id/test', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const provider = await prisma.provider.findUnique({ where: { id } });
  if (!provider) return res.status(404).json({ ok: false, message: 'Provider tidak ditemukan' });
  try {
    const { getAdapter } = require('../providers');
    const adapter = getAdapter(provider.type);
    if (typeof adapter.testConnection !== 'function') {
      return res.json({ ok: false, message: 'Adapter tidak mendukung test connection' });
    }
    const result = await adapter.testConnection(provider);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// Trigger POLLER manual + kembalikan raw response (debug).
// Berguna untuk melihat: apa yang OK balikin? Apakah normalize() bisa parse?
router.post('/providers/:id/poll-now', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const provider = await prisma.provider.findUnique({ where: { id } });
  if (!provider) return res.status(404).json({ ok: false, message: 'Provider tidak ditemukan' });
  try {
    const { getAdapter } = require('../providers');
    const adapter = getAdapter(provider.type);
    const mutations = await adapter.fetchMutations(provider);

    const matcher = require('../services/matcher');
    const { saved, matched } = await matcher.ingestMutations(provider.id, mutations);

    const prisma2 = require('../db');
    const pending = await prisma2.invoice.findMany({
      where: { providerId: provider.id, status: 'PENDING' },
      select: { reference: true, totalAmount: true, amount: true, uniqueCode: true, createdAt: true, expiredAt: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    // Expose debug info (raw response provider) supaya user bisa liat provider
    // balikin apa persisnya kalau normalize gagal detect. Generic: pakai
    // getLastFetchDebug() dari adapter yang sedang dipakai (OK / DANA / dll),
    // bukan hardcode satu provider.
    let debugInfo = null;
    try {
      if (typeof adapter.getLastFetchDebug === 'function') {
        const dbg = adapter.getLastFetchDebug();
        if (dbg) {
          debugInfo = {
            httpStatus: dbg.httpStatus,
            contentType: dbg.contentType,
            rawBodyLength: dbg.rawBodyLength,
            parsedTopKeys: dbg.parsedTopKeys,
            endpoint: dbg.endpoint || null,
            sentParams: dbg.sentParams || null,
            parsedDataPreview: JSON.stringify(dbg.parsedData, null, 2).slice(0, 4000),
          };
        }
      }
    } catch (_) {}

    res.json({
      ok: true,
      message: `Poll selesai. Fetched=${mutations.length}, Saved=${saved}, Matched=${matched}`,
      fetched: mutations.length,
      saved,
      matched,
      sampleMutations: mutations.slice(0, 5).map((m) => ({
        externalId: m.externalId,
        amount: m.amount,
        occurredAt: m.occurredAt,
        keterangan: m.raw?.keterangan || '',
        brand: m.raw?.brand?.name || '',
      })),
      pendingInvoices: pending,
      debug: debugInfo,
    });
  } catch (e) {
    res.json({ ok: false, message: e.message || String(e) });
  }
});

// Test credentials SEBELUM disimpan (dari form add provider).
router.post('/providers/test-preview', async (req, res) => {
  const { type, qrisStatic, credentials } = req.body;
  try {
    const { getAdapter } = require('../providers');
    const adapter = getAdapter(type);
    if (typeof adapter.testConnection !== 'function') {
      return res.json({ ok: false, message: 'Adapter tidak mendukung test' });
    }
    // Bangun provider "sementara" (tanpa disimpan) buat test.
    const fakeProvider = {
      id: 0,
      name: 'preview',
      type,
      qrisStatic: qrisStatic || '',
      credentials: credentials || '{}',
    };
    const result = await adapter.testConnection(fakeProvider);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ----- OrderKuota OTP-based Login (seperti JAGOPAY) -----
router.post('/providers/orderkuota/request-otp', async (req, res) => {
  try {
    const { username, password } = req.body;
    const orderkuota = require('../providers/orderkuota_jywa');
    const result = await orderkuota.requestOtp({ username, password });
    // Simpan info temporary di session buat step verify. Fingerprint WAJIB
    // disimpan utuh supaya verify OTP & fetch mutasi memakai device yang sama
    // persis dengan saat request OTP (kalau beda → "Sesi telah berakhir").
    req.session.okuOtp = {
      username,
      password,
      appRegId: result.appRegId,
      fingerprint: result.fingerprint,
      at: Date.now(),
    };
    res.json({ ok: true, message: result.message });
  } catch (e) {
    res.json({ ok: false, message: e.message || String(e) });
  }
});

router.post('/providers/orderkuota/verify-otp', async (req, res) => {
  try {
    const otpData = req.session.okuOtp;
    if (!otpData || Date.now() - otpData.at > 10 * 60 * 1000) {
      return res.json({
        ok: false,
        message: 'Sesi OTP expired (>10 menit). Klik "Kirim OTP" lagi.',
      });
    }
    const { otp } = req.body;
    const orderkuota = require('../providers/orderkuota_jywa');
    const result = await orderkuota.verifyOtp({
      username: otpData.username,
      otp: String(otp || '').trim(),
      appRegId: otpData.appRegId,
      fingerprint: otpData.fingerprint,
    });

    // Simpan credentials dengan fingerprint PERSIS seperti yang dipakai login.
    // Sebelumnya di sini di-hardcode versi/device yang BERBEDA dari saat login
    // (mis. appVersionName 26.06.27, phoneModel 25062RN2DY) — itu yang bikin
    // token langsung ditolak "Sesi telah berakhir" pas test connection.
    const fp = result.fingerprint || {};
    const credentialsJson = {
      username: otpData.username,
      authToken: result.token,
      authUsername: result.username || otpData.username,
      userId: result.userId,
      ...fp,
    };

    delete req.session.okuOtp;

    res.json({
      ok: true,
      message: `Login sukses sebagai ${result.name || result.username} (saldo: Rp ${Number(result.balance || 0).toLocaleString('id-ID')}). Credentials otomatis diisi — klik Simpan.`,
      credentials: JSON.stringify(credentialsJson, null, 2),
      info: {
        userId: result.userId,
        name: result.name,
        balance: result.balance,
        qrisName: result.qrisName,
      },
    });
  } catch (e) {
    res.json({ ok: false, message: e.message || String(e) });
  }
});

// ----- DANA Bisnis OTP-based Login -----
// Catatan: endpoint OTP DANA masih perlu diverifikasi (bukan API publik resmi).
// Kalau OTP gagal, user bisa pakai jalur "import token manual" (tempel
// accessToken/refreshToken/cookie langsung ke textarea credentials).
router.post('/providers/dana/request-otp', async (req, res) => {
  try {
    const { phone, credentials } = req.body;
    let creds = {};
    try {
      creds = JSON.parse(credentials || '{}');
    } catch (_) {
      // form mungkin belum berisi JSON valid; pakai default endpoint.
    }
    const dana = require('../providers/dana_bisnis');
    const result = await dana.requestOtp({ phone, creds });
    // Simpan konteks OTP (termasuk override endpoint dari form) untuk verify.
    req.session.danaOtp = {
      phone,
      otpToken: result.otpToken,
      creds,
      at: Date.now(),
    };
    res.json({ ok: true, message: result.message });
  } catch (e) {
    res.json({ ok: false, message: e.message || String(e) });
  }
});

router.post('/providers/dana/verify-otp', async (req, res) => {
  try {
    const otpData = req.session.danaOtp;
    if (!otpData || Date.now() - otpData.at > 10 * 60 * 1000) {
      return res.json({
        ok: false,
        message: 'Sesi OTP DANA expired (>10 menit). Klik "Kirim OTP" lagi.',
      });
    }
    const { otp } = req.body;
    const dana = require('../providers/dana_bisnis');
    const result = await dana.verifyOtp({
      phone: otpData.phone,
      otp: String(otp || '').trim(),
      otpToken: otpData.otpToken,
      creds: otpData.creds || {},
    });

    delete req.session.danaOtp;

    const nama = result.merchantName || result.merchantId || otpData.phone;
    res.json({
      ok: true,
      message:
        `Login DANA sukses (${nama}). Credentials otomatis diisi — cek lalu klik Simpan. ` +
        `Kalau nanti fetch mutasi 0/HTTP error, sesuaikan "txPath"/"fieldMap" (lihat DANA-SETUP.md).`,
      credentials: JSON.stringify(result.credentials, null, 2),
      info: { merchantId: result.merchantId, merchantName: result.merchantName },
    });
  } catch (e) {
    res.json({ ok: false, message: e.message || String(e) });
  }
});

// ----- API Keys -----
router.get('/apikeys', async (req, res) => {
  const config = require('../config');
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
  res.render('apikeys', {
    keys,
    baseUrl: config.baseUrl,
    session: req.session,
    active: 'apikeys',
    flash: req.flash('info')[0],
  });
});

router.post('/apikeys', async (req, res) => {
  const label = String(req.body.label || 'unnamed').trim();
  const key = `pk_${keyGen()}`;
  const secret = `sk_${secretGen()}`;
  await prisma.apiKey.create({ data: { label, key, secret } });
  req.flash('info', `API key dibuat: ${key} (secret hanya tampil sekali, catat baik-baik)`);
  res.redirect('/apikeys');
});

router.post('/apikeys/:id/toggle', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const k = await prisma.apiKey.findUnique({ where: { id } });
  if (k) await prisma.apiKey.update({ where: { id }, data: { isActive: !k.isActive } });
  res.redirect('/apikeys');
});

router.post('/apikeys/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await prisma.apiKey.delete({ where: { id } }).catch(() => {});
  res.redirect('/apikeys');
});

// ----- Password -----
router.get('/account', (req, res) => {
  res.render('account', {
    session: req.session,
    active: 'account',
    flash: req.flash('info')[0],
    error: req.flash('error')[0],
  });
});

router.post('/account/password', async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
  if (!bcrypt.compareSync(String(oldPassword || ''), user.passwordHash)) {
    req.flash('error', 'Password lama salah');
    return res.redirect('/account');
  }
  const hash = bcrypt.hashSync(String(newPassword), 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash } });
  req.flash('info', 'Password berhasil diubah');
  res.redirect('/account');
});

module.exports = router;
