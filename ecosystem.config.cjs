module.exports = {
  apps: [
    {
      name: "polymkt-arb",
      script: "dist/main.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
      output: "./data/pm2-out.log",
      error: "./data/pm2-err.log",
    },
  ],
};
