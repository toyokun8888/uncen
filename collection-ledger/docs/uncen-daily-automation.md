# R:\\uncen daily automation

`apps/jobs/uncen-daily-automation.js` is the non-interactive PM2 entry point. It
does not execute anything unless `UNCEN_AUTOMATION_EXECUTE=YES`; `--list` and
`--dry-run` only print the plan. A single shared lock prevents overlap between
all five stages. A later stage waits up to 12 hours for its predecessor and
recovers a lock whose owner process no longer exists. Each child process is sequential, checked by exit code, and
limited by `UNCEN_STEP_TIMEOUT_MS` (three hours by default).
PM2 startup itself is harmless: scheduled processes also require the current
time to be within their ten-minute execution window. A controlled manual live
run additionally sets `UNCEN_RUN_NOW=YES`.

## Schedule and duplicate handling

- 06:30 (`stage0`): place videos that completed overnight before the existing
  07:00 qB completed-registration cleanup. Ownership/DB registration still
  waits for 15:00; this stage only protects discoverability before cleanup.
- 13:00 (`stage1`): site master preflight, differential master update, common
  master synchronization and automatic thumbnail collection. This owns the
  master/automatic-thumbnail commands formerly embedded in `*_master_apply.bat`.
- 14:00 (`stage2`): import manual thumbnails, then search Sukebei independently
  for `10mu`, `1pon`, `carib`, `paco`, `heyzo` and `h0930`. Only exact codes
  still unowned in each site's completion view are reserved. Validated torrent
  files are placed in the dedicated `R:\\uncen\\torrent_automation\\inbox` and
  the existing `torrent_import.js` submits them to qBittorrent with
  `R:\\uncen\\torrent_automation\\downloads` as the save path. Existing FC2
  torrents keep their original Q-drive settings.
- 15:00 (`stage3`): stage completed qBittorrent videos into the matching
  `R:\\uncen\\*_new_mp4` directory without deleting the downloaded source. Then run
  each site's existing review/ready-plan/apply ownership workflow. Apply always
  receives the exact CSV created by its immediately preceding review step. The
  runner snapshots matching CSV files before each child process and stops unless
  exactly one new or changed CSV is produced during that process.
- 21:00 (`stage4`): repeat completed-video staging and ownership registration,
  refresh video metadata, then restart the existing API and Web PM2 services so
  the browser application sees the final state. There is no separate
  collection-ledger cache-clear job in the existing implementation.

This split prevents the 14:00 stage from repeating the master and automatic
thumbnail work already completed at 13:00. Completed-video staging removes a
qBittorrent registration only after every video has a verified outcome, always
with `deleteFiles=false`. The existing 07:00 qBittorrent cleanup is a fallback
registration cleanup and must also keep payload deletion disabled.

The acquisition and staging jobs have separate execute gates
(`UNCEN_TORRENT_EXECUTE=YES` and `UNCEN_VIDEO_STAGE_EXECUTE=YES`). Staging only
accepts completed torrents from the configured download directory, requires
every video in a torrent to classify safely, and verifies every new hard link or
cross-volume copy with SHA-256 before removing the qB registration.

The source video in `R:\\uncen\\torrent_automation\\downloads` is always retained.
Normal staging first attempts an NTFS hard link and falls back to an exclusive
copy when links are unsupported; an existing destination is never overwritten.
If a same-name destination has the same SHA-256, both existing files are kept and
the source is logged as a duplicate candidate. If the content differs, a
collision-safe review copy is created under
`R:\\uncen\\duplicate_review\\<site>\\<torrent-hash>`. The source remains in the
download directory in both cases. Deleting retained source payloads is a separate
manual cleanup task and requires explicit review and approval.

Each decision is appended as JSON Lines under
`R:\\uncen\\torrent_automation\\logs` (or `UNCEN_VIDEO_STAGE_LOG_DIR` when
explicitly configured). Before any qB removal request, the mandatory record
includes the torrent, every retained source, target paths, SHA-256 values,
verified results, and the fixed qB `deleteFiles=false` setting. If this mandatory
record cannot be written, the qB removal request is not sent. The external qB
result is appended afterward on a best-effort basis because it cannot be known
before the API call. When a video is unmatched, changes during inspection, or
fails verification, the torrent registration and every source file are retained.

## Commands

```powershell
node apps\jobs\uncen-daily-automation.js stage1 --list
node apps\jobs\uncen-daily-automation.js stage2 --dry-run
pm2.cmd start ecosystem.uncen.config.js
pm2.cmd save
```

Application logs are in `storage/logs/uncen-daily`; PM2 also writes one stdout
and stderr file per process there. The lock is
`storage/locks/uncen-daily-automation.lock`.

On this Windows host, preserve the same existing startup mechanism used for the
current PM2 process list. `pm2 save` writes the resurrect list, but `pm2 startup`
alone is not a complete Windows boot integration. Verify the existing Task
Scheduler or PM2 Windows service starts `pm2 resurrect` after reboot.
