const express = require('express');
const QRCode = require('qrcode');
const prisma = require('../db');

const router = express.Router();

router.get('/pay/:ref', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { reference: req.params.ref },
    include: { provider: true },
  });
  if (!invoice) return res.status(404).send('Invoice tidak ditemukan');
  const qrImage = await QRCode.toDataURL(invoice.qrisDynamic, { margin: 1, width: 400 });
  res.render('pay', { invoice, qrImage, layout: false });
});

// JSON status (untuk polling dari halaman pay)
router.get('/pay/:ref/status', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { reference: req.params.ref } });
  if (!invoice) return res.status(404).json({ error: 'not_found' });
  res.json({
    status: invoice.status,
    paid_at: invoice.paidAt,
    expired_at: invoice.expiredAt,
  });
});

module.exports = router;
