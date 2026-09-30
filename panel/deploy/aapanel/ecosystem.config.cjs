/**
 * PM2 configuration for aaPanel.
 *
 *   cd /www/wwwroot/csp-panel/panel
 *   pm2 start deploy/aapanel/ecosystem.config.cjs
 *   pm2 save && pm2 startup
 *
 * Values here are defaults; anything you put in panel/.env wins, because the
 * server loads that file at startup.
 */
module.exports = {
  apps: [
    {
      name: 'csp-panel',
      // Resolved relative to this file, so the project can live anywhere.
      cwd: __dirname + '/../..',
      script: 'server/dist/index.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      time: true,
      out_file: '/www/wwwlogs/csp-panel.out.log',
      error_file: '/www/wwwlogs/csp-panel.err.log',
      env: {
        NODE_ENV: 'production',
        PORT: '8090',
        // Listen on loopback only: nginx is the front door.
        HOST: '127.0.0.1',
        // BACKEND: 'oscam',
        // OSCAM_URL: 'http://192.168.1.10:8888',
        // BACKEND: 'csp',
        // CSP_URL: 'https://10.0.0.5:8082',
        SECURE_COOKIES: 'auto',
        TRUST_PROXY: 'loopback',
      },
    },
  ],
};
