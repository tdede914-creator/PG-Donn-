require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret',
  webhookSecret: process.env.WEBHOOK_SECRET || 'insecure-webhook-secret',
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  },
  poller: {
    intervalSeconds: parseInt(process.env.POLLER_INTERVAL_SECONDS || '10', 10),
  },
  invoice: {
    expireMinutes: parseInt(process.env.INVOICE_EXPIRE_MINUTES || '15', 10),
  },
};

module.exports = config;
