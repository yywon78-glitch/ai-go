// PM2 설정 — Docker 없이 VPS에 직접 배포할 때 사용
// 실행: pm2 start ecosystem.config.js --env production
// 재시작: pm2 reload smart-baduk
// 로그: pm2 logs smart-baduk

module.exports = {
  apps: [{
    name: 'smart-baduk',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '300M',

    env: {
      NODE_ENV: 'development',
      PORT: 3100,
      DATA_DIR: __dirname,
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3100,
      DATA_DIR: '/var/data/smart-baduk',
      SESSION_SECRET: 'change-me-in-production',
      CORS_ORIGIN: '*',
    },
  }],
};