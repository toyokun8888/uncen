// ============================================================
// ecosystem.ui.config.js
//
// PM2 config for Collection Ledger browser UI.
//
// Apps:
// - always-collection-ledger-api
//   Serves browser APIs on http://127.0.0.1:3103
// - always-collection-ledger-web
//   Serves the built Vite frontend on http://127.0.0.1:5173
//
// Build before starting:
//   cd C:/uncen/collection-ledger
//   npm --workspace @collection-ledger/web run build
//
// Start:
//   pm2 start C:/uncen/collection-ledger/ecosystem.ui.config.js
//   pm2 save
// ============================================================

module.exports = {
  apps: [
    {
      name: "always-collection-ledger-api",
      script: "C:/uncen/collection-ledger/apps/api/src/server.js",
      cwd: "C:/uncen/collection-ledger",
      args: ["--env-file", "C:/Users/toyoaki/Desktop/filedatachange/.env"],
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        API_HOST: "127.0.0.1",
        API_PORT: "3103",
        MEDIA_ALLOWED_ROOTS:
          "D:/uncen;E:/uncen;F:/uncen;G:/uncen;H:/uncen;I:/uncen;J:/uncen;K:/uncen;L:/uncen;N:/uncen;P:/uncen",
        THUMBNAIL_ALLOWED_ROOTS: "C:/uncen/collection-ledger/storage/thumbnails",
      },
      out_file: "C:/Users/toyoaki/.pm2/logs/collection-ledger-api-out.log",
      error_file: "C:/Users/toyoaki/.pm2/logs/collection-ledger-api-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "always-collection-ledger-web",
      script: "C:/uncen/collection-ledger/node_modules/vite/bin/vite.js",
      cwd: "C:/uncen/collection-ledger/apps/web",
      args: ["preview", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        VITE_API_BASE_URL: "http://127.0.0.1:3103",
      },
      out_file: "C:/Users/toyoaki/.pm2/logs/collection-ledger-web-out.log",
      error_file: "C:/Users/toyoaki/.pm2/logs/collection-ledger-web-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
