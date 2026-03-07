module.exports = {
  apps: [
    {
      name: 'parlay-king',
      script: 'server_dist/index.js',
      cwd: '/home/ubuntu/parlay-king',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 2000,
      max_restarts: 20,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        PORT: '8080',
        TZ: 'America/Halifax',
      },
      env_file: '/home/ubuntu/parlay-king/.env',
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: '/home/ubuntu/parlay-king/logs/out.log',
      error_file: '/home/ubuntu/parlay-king/logs/error.log',
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 10000,
      // Health monitoring
      exp_backoff_restart_delay: 100,
    },
  ],
};
