const prisma = require('../db');

async function requireApiKey(req, res, next) {
  const key = req.header('X-API-Key') || req.query.api_key;
  if (!key) {
    // error code sesuai dokumentasi API (halaman API Keys).
    return res
      .status(401)
      .json({ error: 'missing_api_key', message: 'Header X-API-Key wajib disertakan.' });
  }
  const apiKey = await prisma.apiKey.findUnique({ where: { key } });
  if (!apiKey || !apiKey.isActive) {
    return res
      .status(401)
      .json({ error: 'invalid_api_key', message: 'API key tidak valid atau tidak aktif.' });
  }
  req.apiKey = apiKey;
  next();
}

module.exports = { requireApiKey };
