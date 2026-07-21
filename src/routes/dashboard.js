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
  await prisma.provider.delete({ where: { id } }).catch(() => {});
  res.redirect('/providers');
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

// ----- API Keys -----
router.get('/apikeys', async (req, res) => {
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
  res.render('apikeys', {
    keys,
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
