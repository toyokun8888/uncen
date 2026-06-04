"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const SOURCE_NAME = "heydouga_4017";
const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "storage", "thumbnails", SOURCE_NAME, "master");
const DEFAULT_MAX_DOWNLOADS = 0;
const MIN_DELAY_MS = Math.max(Number(process.env.HEYDOUGA_4017_THUMB_MIN_DELAY_MS || 1500), 500);
const MAX_DELAY_MS = Math.max(Number(process.env.HEYDOUGA_4017_THUMB_MAX_DELAY_MS || 3500), MIN_DELAY_MS);
const REQUEST_TIMEOUT_MS = Math.max(Number(process.env.HEYDOUGA_4017_THUMB_TIMEOUT_MS || 30000), 5000);
const MAX_BYTES = 10 * 1024 * 1024;
const APPROVED_HOSTS = new Set([
  "avjoy.me",
  "www.avjoy.me",
  "ggjav.com",
  "www.ggjav.com",
  "img.ggjav.com",
  "cdn-1.ggjav.com",
  "pics.dmm.co.jp",
  "media-cdn2.avjoy.me",
]);

function parseArgs(argv) {
  const args = {
    step: "collect",
    dryRun: false,
    limit: DEFAULT_MAX_DOWNLOADS,
    envFile: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
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
  if (envFile) candidates.push(path.resolve(envFile));
  candidates.push(path.resolve(__dirname, "..", "..", ".env"));

  const target = candidates.find((candidate) => fs.existsSync(candidate));
  if (!target) return "";

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

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function extensionFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname.toLowerCase());
    if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return ext;
  } catch {
    // fall through
  }
  return ".jpg";
}

function outputFileNameForUniqueKey(uniqueKey, url) {
  return `${uniqueKey}${extensionFromUrl(url)}`;
}

function isApprovedThumbnailUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && APPROVED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

async function getSummary(client) {
  const result = await client.query(
    `
      select
        count(*)::integer as master_count,
        count(*) filter (where coalesce(thumbnail_url, '') <> '')::integer as with_thumbnail_url,
        count(*) filter (where coalesce(thumbnail_file_path, '') <> '')::integer as with_thumbnail_file_path,
        count(*) filter (where coalesce(thumbnail_url, '') <> '' and coalesce(thumbnail_file_path, '') = '')::integer as pending_file_path
      from cl.heydouga_4017_m002_master
    `
  );
  return result.rows[0];
}

async function getTargets(client, limit) {
  const result = await client.query(
    `
      select unique_key, thumbnail_url, thumbnail_file_path
      from cl.heydouga_4017_m002_master
      where coalesce(thumbnail_url, '') <> ''
      order by
        case when coalesce(thumbnail_file_path, '') = '' then 0 else 1 end,
        unique_key
    `
  );

  const targets = [];
  for (const row of result.rows) {
    const fileName = outputFileNameForUniqueKey(row.unique_key, row.thumbnail_url);
    const outputPath = path.join(OUTPUT_DIR, fileName);
    const existingPath = String(row.thumbnail_file_path || "").trim();
    const existingValid =
      existingPath &&
      fs.existsSync(existingPath) &&
      fs.statSync(existingPath).isFile() &&
      fs.statSync(existingPath).size > 0;

    if (existingValid) continue;
    targets.push({ ...row, output_file_name: fileName, output_path: outputPath });
    if (limit > 0 && targets.length >= limit) break;
  }
  return targets;
}

function isCertificateError(error) {
  return [
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "CERT_HAS_EXPIRED",
  ].includes(error.code);
}

function downloadFile(url, outputPath, redirectCount = 0, allowInsecureTls = false) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Too many redirects"));
      return;
    }

    const parsed = new URL(url);
    const transport = parsed.protocol === "http:" ? http : https;
    const tempPath = `${outputPath}.download-${process.pid}-${Date.now()}.tmp`;
    const hash = crypto.createHash("sha256");
    let bytes = 0;

    const request = transport.get(
      parsed,
      {
        rejectUnauthorized: !allowInsecureTls,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) collection-ledger-thumbnail/1.0",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          const nextUrl = new URL(response.headers.location, parsed).toString();
          downloadFile(nextUrl, outputPath, redirectCount + 1, allowInsecureTls).then(resolve, reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const contentType = String(response.headers["content-type"] || "");
        if (!contentType.startsWith("image/")) {
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
              fs.unlinkSync(tempPath);
              resolve({ bytes: fs.statSync(outputPath).size, sha256: "existing_file", contentType });
              return;
            }
            fs.renameSync(tempPath, outputPath);
            resolve({ bytes, sha256: hash.digest("hex"), contentType });
          });
        });

        file.on("error", reject);
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
          // best effort
        }
      }
      if (parsed.protocol === "https:" && !allowInsecureTls && isCertificateError(error)) {
        downloadFile(url, outputPath, redirectCount, true).then(resolve, reject);
        return;
      }
      reject(error);
    });
  });
}

async function updateMasterThumbnailPath(client, uniqueKey, outputPath) {
  await client.query(
    `
      update cl.heydouga_4017_m002_master
      set thumbnail_file_path = $2,
          updated_at = now()
      where unique_key = $1
    `,
    [uniqueKey, outputPath]
  );
}

async function collect(args) {
  ensureOutputDir();
  const client = createPgClient();
  await client.connect();

  try {
    const summary = await getSummary(client);
    const targets = await getTargets(client, args.limit);

    if (args.dryRun || args.step === "summary") {
      return {
        dry_run: true,
        output_dir: OUTPUT_DIR,
        summary,
        targets_found: targets.length,
        preview: targets.slice(0, 20).map((row) => ({
          unique_key: row.unique_key,
          thumbnail_url: row.thumbnail_url,
          output_file_name: row.output_file_name,
        })),
      };
    }

    const counts = { processed: 0, success: 0, existing: 0, failed: 0, skipped_unapproved: 0 };
    for (const row of targets) {
      const thumbnailUrl = String(row.thumbnail_url || "").trim();
      const outputPath = row.output_path;

      try {
        if (!isApprovedThumbnailUrl(thumbnailUrl)) {
          counts.skipped_unapproved += 1;
          counts.failed += 1;
          process.stdout.write(`${row.unique_key} skipped unapproved_url ${thumbnailUrl}\n`);
          continue;
        }

        const delay = randomDelayMs();
        await sleep(delay);

        let result;
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          result = { bytes: fs.statSync(outputPath).size, sha256: "existing_file", contentType: "" };
          counts.existing += 1;
        } else {
          result = await downloadFile(thumbnailUrl, outputPath);
        }

        await updateMasterThumbnailPath(client, row.unique_key, outputPath);
        counts.success += 1;
        counts.processed += 1;
        process.stdout.write(`${row.unique_key} collected bytes=${result.bytes} delay=${delay}\n`);
      } catch (error) {
        counts.failed += 1;
        counts.processed += 1;
        process.stdout.write(`${row.unique_key} failed ${error.message || error}\n`);
      }
    }

    return { dry_run: false, output_dir: OUTPUT_DIR, targets_found: targets.length, ...counts };
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);
  const result = await collect(args);
  process.stdout.write(
    `${JSON.stringify({ ok: true, source_name: SOURCE_NAME, step: args.step, env_file_loaded: Boolean(loadedEnv), result }, null, 2)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
