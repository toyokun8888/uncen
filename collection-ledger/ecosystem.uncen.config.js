const runner = "C:/uncen/collection-ledger/apps/jobs/uncen-daily-automation.js";
const cwd = "C:/uncen/collection-ledger";
const logDir = "C:/uncen/collection-ledger/storage/logs/uncen-daily";

function scheduled(name, hour, args, minute = 0) {
  return {
    name,
    script: runner,
    args,
    cwd,
    cron_restart: `${minute} ${hour} * * *`,
    autorestart: false,
    watch: false,
    kill_timeout: 30000,
    env: {
      NODE_ENV: "production",
      UNCEN_AUTOMATION_EXECUTE: "YES",
      UNCEN_TORRENT_EXECUTE: "YES",
      UNCEN_VIDEO_STAGE_EXECUTE: "YES",
      UNCEN_P_ROOT: "T:\\uncen",
      UNCEN_DUPLICATE_REVIEW_DIR: "T:\\uncen\\duplicate_review",
      UNCEN_SCHEDULE_HOUR: String(hour),
      UNCEN_SCHEDULE_MINUTE: String(minute),
      UNCEN_SCHEDULE_WINDOW_MINUTES: "10",
    },
    out_file: `${logDir}/${name}-out.log`,
    error_file: `${logDir}/${name}-error.log`,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
  };
}

module.exports = {
  apps: [
    scheduled("daily-0630-uncen-video-stage", 6, ["stage0"], 30),
    scheduled("daily-1300-uncen-acquire", 13, ["stage1"]),
    scheduled("daily-1400-uncen-p-batches", 14, ["stage2"]),
    scheduled("daily-1500-uncen-import", 15, ["stage3"]),
    scheduled("daily-2100-uncen-finalize", 21, ["stage4"]),
  ],
};
