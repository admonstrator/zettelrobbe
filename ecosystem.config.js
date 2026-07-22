module.exports = {
  apps: [{
    name: 'zettelrobbe',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info'
    },
    exp_backoff_restart_delay: 100
  }]
};