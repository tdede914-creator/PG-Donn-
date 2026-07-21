const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const flash = require('connect-flash');
const morgan = require('morgan');
const path = require('path');

const config = require('./config');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const payRoutes = require('./routes/pay');
const apiRoutes = require('./routes/api');
const poller = require('./workers/poller');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(morgan(config.env === 'development' ? 'dev' : 'combined'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 },
  }),
);
app.use(flash());

// ------ Routes ------
app.use('/', authRoutes);
app.use('/', payRoutes);
app.use('/api/v1', apiRoutes);
app.use('/', dashboardRoutes);

// 404
app.use((req, res) => res.status(404).send('Not Found'));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
  res.status(500).send('Internal Server Error');
});

app.listen(config.port, () => {
  console.log(`Payment gateway listening on ${config.baseUrl} (port ${config.port})`);
});

// Start embedded poller (bisa juga dijalankan terpisah dengan `npm run poller`)
if (process.env.EMBED_POLLER !== 'false') {
  poller.start();
}
