"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_TIMEOUT_MS = 30000;
const SOURCE_CONFIGS = {
  paco: {
    ownedTable: "cl.paco_owned_file",
    metadataTable: "cl.paco_owned_file_video_metadata",
    initSqlPaths: ["060_paco_browser_support.sql"],
  },
  heydouga_4017: {
    ownedTable: "cl.heydouga_4017_owned_file",
    metadataTable: "cl.heydouga_4017_owned_file_video_metadata",
    initSqlPaths: ["080_heydouga_4017_owned_file.sql"],
  },
  "10musume": {
    ownedTable: "cl.tenmusume_owned_file",
    metadataTable: "cl.tenmusume_owned_file_video_metadata",
    initSqlPaths: ["090_tenmusume_site.sql"],
  },
  heyzo: {
    ownedTable: "cl.heyzo_owned_file",
    metadataTable: "cl.heyzo_owned_file_video_metadata",
    initSqlPaths: ["100_heyzo_site.sql"],
  },
  "1pondo": {
    ownedTable: "cl.onepondo_owned_file",
    metadataTable: "cl.onepondo_owned_file_video_metadata",
    initSqlPaths: ["110_1pondo_site.sql"],
  },
};

function parseArgs(argv) {
  const args = {
    source: "paco",
    step: "collect",
    envFile: "",
    dryRun: false,
    all: false,
    limit: 0,
    concurrency: 4,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--all") {
      args.all = true;
    } else if (arg === "--source") {
      args.source = argv[++i];
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg === "--step") {
      args.step = argv[++i];
    } else if (arg.startsWith("--step=")) {
      args.step = arg.slice("--step=".length);
    } else if (arg === "--env-file") {
      args.envFile = argv[++i];
    } else if (arg.startsWith("--env-file=")) {
      args.envFile = arg.slice("--env-file=".length);
    } else if (arg === "--limit") {
      args.limit = parseNonNegativeInt(argv[++i], "limit");
    } else if (arg.startsWith("--limit=")) {
      args.limit = parseNonNegativeInt(arg.slice("--limit=".length), "limit");
    } else if (arg === "--concurrency") {
      args.concurrency = Math.max(1, Math.min(parsePositiveInt(argv[++i], "concurrency"), 8));
    } else if (arg.startsWith("--concurrency=")) {
      args.concurrency = Math.max(1, Math.min(parsePositiveInt(arg.slice("--concurrency=".length), "concurrency"), 8));
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Math.max(1000, parsePositiveInt(argv[++i], "timeout-ms"));
    } else if (arg.startsWith("--timeout-ms=")) {
      args.timeoutMs = Math.max(1000, parsePositiveInt(arg.slice("--timeout-ms=".length), "timeout-ms"));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function getSourceConfig(source) {
  const key = String(source || "paco").trim().toLowerCase();
  const config = SOURCE_CONFIGS[key];
  if (!config) {
    throw new Error(`Unsupported source: ${source}`);
  }
  return { source: key, ...config };
}

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
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

async function initDb(config) {
  const client = createPgClient();

  await client.connect();
  try {
    for (const sqlFileName of config.initSqlPaths) {
      const sqlPath = path.resolve(__dirname, "..", "..", "ops", "sql", sqlFileName);
      const sql = fs.readFileSync(sqlPath, "utf8");
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

async function loadTargets(args, config) {
  const client = createPgClient();
  const limitSql = args.limit > 0 ? "limit $1" : "";
  const params = args.limit > 0 ? [args.limit] : [];
  const missingOnlySql = args.all
    ? ""
    : `
      and not exists (
        select 1
        from ${config.metadataTable} metadata
        where metadata.owned_file_id = owned_file.owned_file_id
          and metadata.probe_status = 'ok'
      )
    `;

  await client.connect();
  try {
    const result = await client.query(
      `
        select
          owned_file.owned_file_id,
          owned_file.movie_code,
          owned_file.file_path,
          owned_file.file_name,
          owned_file.file_ext,
          owned_file.file_size_bytes,
          owned_file.file_mtime
        from ${config.ownedTable} owned_file
        where true
          ${missingOnlySql}
        order by owned_file.updated_at desc nulls last, owned_file.owned_file_id desc
        ${limitSql}
      `,
      params
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

function normalizeWindowsPath(targetPath) {
  const raw = String(targetPath || "").trim().replace(/\//g, "\\");
  const withoutLeadingSlash = raw.replace(/^[\\]+([A-Za-z]:)/, "$1");
  const fixedDrive = withoutLeadingSlash.replace(/^([A-Za-z]):(?![\\])/, "$1:\\");
  return path.normalize(fixedDrive).replace(/\//g, "\\");
}

function resolveAllowedRoots() {
  const raw = (process.env.MEDIA_ALLOWED_ROOTS || "").trim();
  const defaultRoots = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P"].map((drive) => `${drive}:\\uncen`);
  if (raw) {
    const configuredRoots = raw
      .split(";")
      .map((value) => normalizeWindowsPath(value.trim()))
      .filter(Boolean);
    return [...new Set([...configuredRoots, ...defaultRoots])];
  }

  return defaultRoots;
}

function isPathAllowed(targetPath) {
  const normalized = normalizeWindowsPath(targetPath).toLowerCase();
  return resolveAllowedRoots().some((root) => {
    const normalizedRoot = normalizeWindowsPath(root).toLowerCase().replace(/[\\]+$/, "");
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}\\`);
  });
}

async function inspectRow(row, args) {
  const filePath = normalizeWindowsPath(row.file_path);
  const fileExt = String(row.file_ext || path.extname(filePath)).toLowerCase().replace(/^\./, "");

  if (!["mp4", "mkv", "mov", "avi", "wmv", "ts", "m2ts"].includes(fileExt)) {
    return {
      probe_status: "unsupported",
      probe_error: `unsupported_extension:${fileExt || "none"}`,
    };
  }

  if (!isPathAllowed(filePath)) {
    return {
      probe_status: "path_not_allowed",
      probe_error: "path_not_allowed",
    };
  }

  if (!fs.existsSync(filePath)) {
    return {
      probe_status: "file_missing",
      probe_error: "file_missing",
    };
  }

  try {
    const metadata = await runFfprobe(filePath, args.timeoutMs);
    const videoStream = (metadata.streams || []).find((stream) => stream.codec_type === "video");
    const width = Number(videoStream?.width || 0);
    const height = Number(videoStream?.height || 0);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return {
        probe_status: "failed",
        probe_error: "video_dimensions_not_found",
      };
    }

    return {
      probe_status: "ok",
      video_width: width,
      video_height: height,
      resolution_class: classifyResolution(width, height),
    };
  } catch (error) {
    return {
      probe_status: "failed",
      probe_error: String(error?.message || error).slice(0, 1000),
    };
  }
}

function runFfprobe(filePath, timeoutMs) {
  const ffprobe = require("ffprobe-static");

  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobe.path,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_type,width,height",
        "-of",
        "json",
        filePath,
      ],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`ffprobe_timeout_${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `ffprobe_exit_${code}`));
        return;
      }
      try {
        finish(null, JSON.parse(stdout || "{}"));
      } catch (error) {
        finish(error);
      }
    });
  });
}

function classifyResolution(width, height) {
  const maxSide = Math.max(width, height);
  const minSide = Math.min(width, height);

  if (maxSide >= 3840 || minSide >= 2160) return "4k";
  if (maxSide >= 1280 || minSide >= 720) return "hd";
  return "low";
}

async function upsertResult(client, row, result, config) {
  await client.query(
    `
      insert into ${config.metadataTable} (
        owned_file_id,
        movie_code,
        file_path,
        file_name,
        file_size_bytes,
        file_mtime,
        video_width,
        video_height,
        resolution_class,
        probe_status,
        probe_error,
        probed_at,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), now())
      on conflict (owned_file_id) do update set
        movie_code = excluded.movie_code,
        file_path = excluded.file_path,
        file_name = excluded.file_name,
        file_size_bytes = excluded.file_size_bytes,
        file_mtime = excluded.file_mtime,
        video_width = excluded.video_width,
        video_height = excluded.video_height,
        resolution_class = excluded.resolution_class,
        probe_status = excluded.probe_status,
        probe_error = excluded.probe_error,
        probed_at = now(),
        updated_at = now()
    `,
    [
      row.owned_file_id,
      row.movie_code,
      normalizeWindowsPath(row.file_path),
      row.file_name || null,
      row.file_size_bytes || null,
      row.file_mtime || null,
      result.video_width || null,
      result.video_height || null,
      result.resolution_class || null,
      result.probe_status,
      result.probe_error || null,
    ]
  );
}

async function collect(args, config) {
  const rows = await loadTargets(args, config);
  const client = createPgClient();

  await client.connect();
  try {
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;

    for (let index = 0; index < rows.length; index += args.concurrency) {
      const chunk = rows.slice(index, index + args.concurrency);
      const results = await Promise.all(chunk.map((row) => inspectRow(row, args)));

      for (let i = 0; i < chunk.length; i += 1) {
        const row = chunk[i];
        const result = results[i];

        if (args.dryRun) {
          process.stdout.write(
            `[video-metadata] dry owned_file_id=${row.owned_file_id} movie_code=${row.movie_code} ` +
              `status=${result.probe_status} resolution=${result.resolution_class || ""} ` +
              `${result.video_width || ""}x${result.video_height || ""} path=${normalizeWindowsPath(row.file_path)}\n`
          );
        } else {
          await upsertResult(client, row, result, config);
        }

        if (result.probe_status === "ok") ok += 1;
        else if (result.probe_status === "path_not_allowed" || result.probe_status === "file_missing") skipped += 1;
        else failed += 1;

        processed += 1;
      }

      if (!args.dryRun && (processed % 50 === 0 || processed === rows.length)) {
        process.stdout.write(`[video-metadata] progress ${processed}/${rows.length} ok=${ok} skipped=${skipped} failed=${failed}\n`);
      }
    }

    return {
      target_count: rows.length,
      ok_count: ok,
      skipped_count: skipped,
      failed_count: failed,
      dry_run: args.dryRun,
    };
  } finally {
    await client.end();
  }
}

async function status(config) {
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(
      `
        select
          (select count(*)::integer from ${config.ownedTable}) as owned_file_count,
          (select count(*)::integer from ${config.metadataTable}) as metadata_count,
          (select count(*)::integer from ${config.metadataTable} where probe_status = 'ok') as ok_count,
          (select count(*)::integer from ${config.metadataTable} where probe_status = 'ok' and resolution_class = '4k') as resolution_4k_count,
          (select count(*)::integer from ${config.metadataTable} where probe_status = 'ok' and resolution_class = 'hd') as resolution_hd_count,
          (select count(*)::integer from ${config.metadataTable} where probe_status = 'ok' and resolution_class = 'low') as resolution_low_count
      `
    );
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const config = getSourceConfig(args.source);
  const loadedEnv = loadEnvFile(args.envFile);

  if (args.step === "init-db") {
    await initDb(config);
    process.stdout.write(`${JSON.stringify({ ok: true, source: config.source, step: args.step, env_file_loaded: Boolean(loadedEnv) }, null, 2)}\n`);
    return;
  }

  if (args.step === "status") {
    const currentStatus = await status(config);
    process.stdout.write(`${JSON.stringify({ ok: true, source: config.source, step: args.step, env_file_loaded: Boolean(loadedEnv), status: currentStatus }, null, 2)}\n`);
    return;
  }

  if (args.step !== "collect") {
    throw new Error(`Unsupported step: ${args.step}`);
  }

  const result = await collect(args, config);
  process.stdout.write(`${JSON.stringify({ ok: true, source: config.source, step: args.step, env_file_loaded: Boolean(loadedEnv), result }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
