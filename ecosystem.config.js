module.exports = {
  apps: [
    {
      name: "bocadillo-whatsapp",
      script: "index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "350M",
      env: {
        NODE_ENV: "production",
        PORT: 3002
      }
    }
  ]
};
