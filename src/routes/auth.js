const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: req.flash('error')[0], layout: false });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.user.findUnique({ where: { username: String(username || '') } });
  if (!user || !bcrypt.compareSync(String(password || ''), user.passwordHash)) {
    req.flash('error', 'Username atau password salah');
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
