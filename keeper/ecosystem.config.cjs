// pm2 process definition for the keeper.
//
// Run with:  pm2 start ecosystem.config.cjs
//
// IMPORTANT: instances is 1 and exec_mode is "fork" on purpose. Two keepers
// sharing one key collide on transaction nonces and silently drop trades. Never
// raise instances and never use cluster mode.
module.exports = {
  apps: [
    {
      name: "icaria-keeper",
      script: "dist/index.js",
      node_args: "--enable-source-maps",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: "500M",
      time: true, // timestamp every log line
    },
  ],
};
