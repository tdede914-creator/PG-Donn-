/**
 * PM2 config.
 *
 * Default: 1 proses (server + embedded poller).
 * Kalau mau pisah proses (skala lebih besar), set EMBED_POLLER=false di .env
 * lalu uncomment app kedua di bawah.
 */

module.exports = {
  apps: [
    {
      name: 'payment-gateway',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/out.log',
      error_file: './logs/err.log',
      merge_logs: true,
      time: true,
    },
    // Uncomment kalau EMBED_POLLER=false:
    // {
    //   name: 'payment-gateway-poller',
    //   script: 'src/workers/poller.js',
    //   cwd: __dirname,
    //   instances: 1,
    //   exec_mode: 'fork',
    //   autorestart: true,
    //   max_memory_restart: '256M',
    //   env: { NODE_ENV: 'production' },
    //   out_file: './logs/poller-out.log',
    //   error_file: './logs/poller-err.log',
    //   merge_logs: true,
    //   time: true,
    // },
  ],
};
