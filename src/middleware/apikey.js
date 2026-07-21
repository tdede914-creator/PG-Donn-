const prisma = require('../db');

async function requireApiKey(req, res, next) {
  const key = req.header('X-API-Key') || req.query.api_key;
  if (!key) {
    return res.status(401).json({ error: 'unauthorized', message: 'X-API-Key header wajib' });
  }
  const apiKey = await prisma.apiKey.findUnique({ where: { key } });
  if (!apiKey || !apiKey.isActive) {
    return res.status(401).json({ error: 'unauthorized', message: 'API key invalid' });
  }
  req.apiKey = apiKey;
  next();
}

module.exports = { requireApiKey };
