const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const PACO_SOURCE_NAME = "paco";
const TARGET_SCOPE = "paco_m001_master";
const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "storage", "thumbnails", "paco", "master");
const DEFAULT_MAX_DOWNLOADS = 5000;
const MIN_DELAY_MS = Math.max(Number(process.env.PACO_THUMB_MIN_DELAY_MS || 2500), 1000);
const MAX_DELAY_MS = Math.max(Number(process.env.PACO_THUMB_MAX_DELAY_MS || 5500), MIN_DELAY_MS);
const REQUEST_TIMEOUT_MS = Math.max(Number(process.env.PACO_THUMB_TIMEOUT_MS || 30000), 5000);
const MAX_BYTES = 10 * 1024 * 1024;
const APPROVED_HOSTS = new Set(["www.pacopacomama.com", "pacopacomama.com"]);

function parseArgs(argv) {
  const args = {
    source: PACO_SOURCE_NAME,
    step: "collect",
    dryRun: false,
    limit: 0,
    envFile: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--source") {
      args.source = argv[++i];
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg === "--step") {
      args.step = argv[++i];
    } else if (arg.startsWith("--step=")) {
      args.step = arg.slice("--step=".length);
    } else if (arg === "--limit") {
      args.limit = parseNonNegativeInt(argv[++i], "limit");
    } else if (arg.startsWith("--limit=")) {
      args.limit = parseNonNegativeInt(arg.slice("--limit=".length), "limit");
    } else if (arg === "--env-file") {
      args.envFile = argv[++i];
    } else if (arg.startsWith("--env-file=")) {
      args.envFile = arg.slice("--env-file=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseNonNegativeInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function loadEnvFile(envFile) {
  const candidates = [];

  if (envFile) {
    candidates.push(path.resolve(envFile));
  }

  candidates.push(path.resolve(__dirname, "..", "..", ".env"));

  const target = candidates.find((candidate) => fs.existsSync(candidate));
  if (!target) {
    return "";
  }

  const text = fs.readFileSync(target, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1).trim());

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return target;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function createPgClient() {
  const { Client } = require("pg");
  const database = process.env.PGDATABASE || process.env.DB_NAME;
  const user = process.env.PGUSER || process.env.DB_USER;

  if (!database || !user) {
    throw new Error("DB connection is not configured. Set PGDATABASE/PGUSER or DB_NAME/DB_USER.");
  }

  return new Client({
    host: process.env.PGHOST || process.env.DB_HOST || "localhost",
    port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
    database,
    user,
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD,
  });
}

function buildRunId() {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `paco_thumb_${stamp}_${process.pid}`;
}

function ensureOutputDir() {
  if (fs.existsSync(OUTPUT_DIR)) {
    const stat = fs.statSync(OUTPUT_DIR);
    if (!stat.isDirectory()) {
      throw new Error(`Output path exists but is not a directory: ${OUTPUT_DIR}`);
    }
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function isApprovedThumbnailUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      APPROVED_HOSTS.has(parsed.hostname) &&
      parsed.pathname.startsWith("/assets/sample/")
    );
  } catch {
    return false;
  }
}

function extensionFromUrl(url) {
  const cleanPath = new URL(url).pathname.toLowerCase();
  const ext = path.extname(cleanPath);
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return ext;
  return ".jpg";
}

function outputFileNameForMovieCode(movieCode, url) {
  return `${movieCode}${extensionFromUrl(url)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const tempPath = `${outputPath}.download-${process.pid}-${Date.now()}.tmp`;

    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) collection-ledger-thumbnail/1.0",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const contentType = response.headers["content-type"] || "";
        if (!String(contentType).startsWith("image/")) {
          response.resume();
          reject(new Error(`Unexpected content-type: ${contentType}`));
          return;
        }

        const file = fs.createWriteStream(tempPath, { flags: "wx" });

        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            request.destroy(new Error(`File too large: ${bytes}`));
            return;
          }
          hash.update(chunk);
        });

        response.pipe(file);

        file.on("finish", () => {
          file.close(() => {
            if (fs.existsSync(outputPath)) {
              reject(new Error(`Output file already exists: ${outputPath}`));
              return;
            }
            fs.renameSync(tempPath, outputPath);
            resolve({
              bytes,
              sha256: hash.digest("hex"),
              contentType,
            });
          });
        });

        file.on("error", (error) => {
          reject(error);
        });
      }
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Request timeout"));
    });

    request.on("error", (error) => {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Best effort cleanup for temp downloads only.
        }
      }
      reject(error);
    });
  });
}

async function initDb() {
  const sqlPath = path.resolve(__dirname, "..", "..", "ops", "sql", "020_paco_thumbnails.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = createPgClient();

  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function getStatus() {
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(`
      select
        (select count(*)::integer from cl.paco_m001_master_staging where coalesce(thumbnail_url, '') <> '') as master_with_url,
        (select count(*)::integer from cl.paco_m001_thumbnail_assets where thumbnail_status = 'collected') as collected,
        (select count(*)::integer from cl.paco_m001_thumbnail_assets where thumbnail_status = 'failed') as failed,
        (select count(*)::integer from cl.paco_m001_thumbnail_assets where thumbnail_status = 'missing_url') as missing_url,
        (select count(*)::integer from cl.paco_m001_thumbnail_assets where thumbnail_status = 'pending') as pending,
        (select count(*)::integer from cl.paco_m001_thumbnail_runs) as run_count
    `);
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function collectTargets(client, limit) {
  const effectiveLimit = limit > 0 ? limit : DEFAULT_MAX_DOWNLOADS;
  const result = await client.query(
    `
      select
        s.movie_code,
        s.thumbnail_url,
        coalesce(t.attempt_count, 0) as attempt_count,
        coalesce(t.thumbnail_status, '') as thumbnail_status
      from cl.paco_m001_master_staging s
      left join cl.paco_m001_thumbnail_assets t
        on t.movie_code = s.movie_code
      where coalesce(s.thumbnail_url, '') <> ''
        and coalesce(t.thumbnail_status, '') not in ('collected', 'missing_url')
      order by
        case coalesce(t.thumbnail_status, '')
          when 'failed' then 1
          when 'pending' then 0
          else 0
        end,
        t.downloaded_at nulls first,
        t.last_checked_at nulls first,
        s.movie_code
      limit $1
    `,
    [effectiveLimit]
  );
  return result.rows;
}

async function createRunLog(client, runId, args, targetsFound) {
  await client.query(
    `
      insert into cl.paco_m001_thumbnail_runs (
        run_id,
        run_status,
        target_scope,
        max_downloads,
        min_delay_ms,
        max_delay_ms,
        targets_found,
        updated_at
      )
      values ($1, 'running', $2, $3, $4, $5, $6, now())
    `,
    [runId, TARGET_SCOPE, args.limit || DEFAULT_MAX_DOWNLOADS, MIN_DELAY_MS, MAX_DELAY_MS, targetsFound]
  );
}

async function finishRunLog(client, runId, status, counts, lastError = "") {
  await client.query(
    `
      update cl.paco_m001_thumbnail_runs
      set
        run_finished_at = now(),
        run_status = $2,
        success_count = $3,
        failed_count = $4,
        existing_file_count = $5,
        last_error = nullif($6, ''),
        updated_at = now()
      where run_id = $1
    `,
    [runId, status, counts.success, counts.failed, counts.existing, String(lastError || "").slice(0, 1000)]
  );
}

async function markCollected(client, row, item) {
  await client.query(
    `
      insert into cl.paco_m001_thumbnail_assets (
        movie_code,
        thumbnail_url,
        local_thumbnail_path,
        local_thumbnail_file_name,
        thumbnail_status,
        bytes,
        sha256,
        content_type,
        attempt_count,
        last_error,
        last_checked_at,
        downloaded_at,
        updated_at
      )
      values ($1, $2, $3, $4, 'collected', $5, $6, $7, $8, null, now(), now(), now())
      on conflict (movie_code) do update set
        thumbnail_url = excluded.thumbnail_url,
        local_thumbnail_path = excluded.local_thumbnail_path,
        local_thumbnail_file_name = excluded.local_thumbnail_file_name,
        thumbnail_status = 'collected',
        bytes = excluded.bytes,
        sha256 = excluded.sha256,
        content_type = excluded.content_type,
        attempt_count = cl.paco_m001_thumbnail_assets.attempt_count + 1,
        last_error = null,
        last_checked_at = now(),
        downloaded_at = now(),
        updated_at = now()
    `,
    [
      row.movie_code,
      row.thumbnail_url,
      item.localThumbnailPath,
      item.localThumbnailFileName,
      item.bytes,
      item.sha256,
      item.contentType,
      Number(row.attempt_count || 0) + 1,
    ]
  );
}

async function markFailed(client, row, status, errorMessage) {
  await client.query(
    `
      insert into cl.paco_m001_thumbnail_assets (
        movie_code,
        thumbnail_url,
        thumbnail_status,
        attempt_count,
        last_error,
        last_checked_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, now(), now())
      on conflict (movie_code) do update set
        thumbnail_url = excluded.thumbnail_url,
        thumbnail_status = excluded.thumbnail_status,
        attempt_count = cl.paco_m001_thumbnail_assets.attempt_count + 1,
        last_error = excluded.last_error,
        last_checked_at = now(),
        updated_at = now()
    `,
    [
      row.movie_code,
      row.thumbnail_url || "",
      status,
      Number(row.attempt_count || 0) + 1,
      String(errorMessage || "").slice(0, 1000),
    ]
  );
}

async function logRunItem(client, runId, row, item) {
  await client.query(
    `
      insert into cl.paco_m001_thumbnail_run_items (
        run_id,
        movie_code,
        thumbnail_url,
        local_thumbnail_path,
        local_thumbnail_file_name,
        item_status,
        bytes,
        sha256,
        content_type,
        delay_ms,
        error_message,
        attempt_count
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, nullif($11, ''), $12)
    `,
    [
      runId,
      row.movie_code || "",
      row.thumbnail_url || "",
      item.localThumbnailPath || "",
      item.localThumbnailFileName || "",
      item.status,
      item.bytes || null,
      item.sha256 || "",
      item.contentType || "",
      item.delayMs || null,
      String(item.errorMessage || "").slice(0, 1000),
      Number(row.attempt_count || 0) + 1,
    ]
  );
}

async function collect(args) {
  ensureOutputDir();
  const runId = buildRunId();
  const client = createPgClient();
  const counts = { success: 0, failed: 0, existing: 0, processed: 0 };
  let runLogCreated = false;

  await client.connect();
  try {
    const targets = await collectTargets(client, args.limit);

    if (args.dryRun) {
      return {
        run_id: runId,
        dry_run: true,
        output_dir: OUTPUT_DIR,
        targets_found: targets.length,
        preview: targets.slice(0, 20).map((row) => ({
          movie_code: row.movie_code,
          thumbnail_url: row.thumbnail_url,
          output_file_name: outputFileNameForMovieCode(row.movie_code, row.thumbnail_url),
        })),
      };
    }

    await createRunLog(client, runId, args, targets.length);
    runLogCreated = true;

    for (const row of targets) {
      const movieCode = String(row.movie_code || "").trim();
      const thumbnailUrl = String(row.thumbnail_url || "").trim();

      try {
        if (!movieCode.match(/^[0-9]{6}_.+$/)) {
          await markFailed(client, row, "failed", "Invalid movie_code");
          counts.failed += 1;
          continue;
        }

        if (!isApprovedThumbnailUrl(thumbnailUrl)) {
          await markFailed(client, row, "missing_url", "Missing or unapproved thumbnail URL");
          await logRunItem(client, runId, row, {
            status: "missing_url",
            errorMessage: "Missing or unapproved thumbnail URL",
          });
          counts.failed += 1;
          continue;
        }

        const delay = randomDelayMs();
        await sleep(delay);

        const fileName = outputFileNameForMovieCode(movieCode, thumbnailUrl);
        const outputPath = path.join(OUTPUT_DIR, fileName);

        if (fs.existsSync(outputPath)) {
          const stat = fs.statSync(outputPath);
          if (!stat.isFile() || stat.size <= 0) {
            throw new Error(`Existing output is not a non-empty file: ${outputPath}`);
          }
          await markCollected(client, row, {
            localThumbnailPath: outputPath,
            localThumbnailFileName: fileName,
            bytes: stat.size,
            sha256: "existing_file",
            contentType: "",
          });
          await logRunItem(client, runId, row, {
            status: "collected_existing",
            localThumbnailPath: outputPath,
            localThumbnailFileName: fileName,
            bytes: stat.size,
            sha256: "existing_file",
            delayMs: delay,
          });
          counts.success += 1;
          counts.existing += 1;
          counts.processed += 1;
          process.stdout.write(`${movieCode} collected existing_file bytes=${stat.size}\n`);
          continue;
        }

        const result = await downloadFile(thumbnailUrl, outputPath);
        await markCollected(client, row, {
          localThumbnailPath: outputPath,
          localThumbnailFileName: fileName,
          bytes: result.bytes,
          sha256: result.sha256,
          contentType: result.contentType,
        });
        await logRunItem(client, runId, row, {
          status: "collected",
          localThumbnailPath: outputPath,
          localThumbnailFileName: fileName,
          bytes: result.bytes,
          sha256: result.sha256,
          contentType: result.contentType,
          delayMs: delay,
        });
        counts.success += 1;
        counts.processed += 1;
        process.stdout.write(`${movieCode} collected bytes=${result.bytes} delay=${delay}\n`);
      } catch (error) {
        await markFailed(client, row, "failed", error.message || error);
        await logRunItem(client, runId, row, {
          status: "failed",
          errorMessage: error.message || error,
        });
        counts.failed += 1;
        counts.processed += 1;
        process.stdout.write(`${movieCode} failed ${error.message || error}\n`);
      }
    }

    await finishRunLog(client, runId, "completed", counts);
    return { run_id: runId, dry_run: false, output_dir: OUTPUT_DIR, ...counts };
  } catch (error) {
    if (runLogCreated) {
      await finishRunLog(client, runId, "failed", counts, error.message || error);
    }
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);

  if (args.source !== PACO_SOURCE_NAME) {
    throw new Error(`Unsupported source: ${args.source}`);
  }

  if (args.step === "init-db") {
    await initDb();
    process.stdout.write(
      `${JSON.stringify({ ok: true, source: PACO_SOURCE_NAME, step: args.step, env_file_loaded: Boolean(loadedEnv) }, null, 2)}\n`
    );
    return;
  }

  if (args.step === "status") {
    const status = await getStatus();
    process.stdout.write(
      `${JSON.stringify({ ok: true, source: PACO_SOURCE_NAME, step: args.step, env_file_loaded: Boolean(loadedEnv), status }, null, 2)}\n`
    );
    return;
  }

  if (args.step !== "collect") {
    throw new Error(`Unsupported step: ${args.step}`);
  }

  const result = await collect(args);
  process.stdout.write(
    `${JSON.stringify({ ok: true, source: PACO_SOURCE_NAME, step: args.step, env_file_loaded: Boolean(loadedEnv), ...result }, null, 2)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
