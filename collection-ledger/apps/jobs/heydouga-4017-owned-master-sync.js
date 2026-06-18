"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SOURCE_NAME = "heydouga_4017";
const DEFAULT_ROOTS = [
  "E:\\uncen\\heydouga_4017",
  "F:\\uncen\\heydouga_4017",
  "H:\\uncen\\heydouga_4017",
  "K:\\uncen\\heydouga_4017",
  "N:\\uncen\\heydouga_4017",
  "Q:\\uncen\\heydouga_4017",
];
const VIDEO_EXTENSIONS = new Set([".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpg", ".mpeg", ".ts", ".wmv"]);
const SQL_PATH = path.resolve(__dirname, "..", "..", "ops", "sql", "080_heydouga_4017_owned_file.sql");
const EXPORT_DIR = path.resolve(__dirname, "..", "..", "storage", "exports", SOURCE_NAME);

function parseArgs(argv) {
  const args = { step: "review", envFile: "", roots: DEFAULT_ROOTS };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--step") args.step = argv[++i];
    else if (arg.startsWith("--step=")) args.step = arg.slice("--step=".length);
    else if (arg === "--env-file") args.envFile = argv[++i];
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice("--env-file=".length);
    else if (arg === "--roots") args.roots = parseRoots(argv[++i]);
    else if (arg.startsWith("--roots=")) args.roots = parseRoots(arg.slice("--roots=".length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function parseRoots(value) {
  return String(value || "")
    .split(";")
    .map((root) => root.trim())
    .filter(Boolean);
}

function loadEnvFile(envFile) {
  const candidates = [];
  if (envFile) candidates.push(path.resolve(envFile));
  candidates.push(path.resolve(__dirname, "..", "..", ".env"));
  const target = candidates.find((candidate) => fs.existsSync(candidate));
  if (!target) return "";

  for (const rawLine of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  return target;
}

function runVideoMetadataCollect(envFile) {
  const scriptPath = path.resolve(__dirname, "collect-video-metadata.js");
  const commandArgs = [scriptPath, "--source", SOURCE_NAME, "--step", "collect"];
  if (envFile) commandArgs.push("--env-file", envFile);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: path.resolve(__dirname, "..", ".."),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`video metadata collect failed: ${result.stderr || result.stdout}`);
  }
  const output = String(result.stdout || "").trim();
  const jsonStart = output.indexOf("{");
  return jsonStart >= 0 ? JSON.parse(output.slice(jsonStart)) : {};
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function createPgClient() {
  const { Client } = require("pg");
  const database = process.env.PGDATABASE || process.env.DB_NAME;
  const user = process.env.PGUSER || process.env.DB_USER;
  if (!database || !user) throw new Error("DB connection is not configured. Set PGDATABASE/PGUSER or DB_NAME/DB_USER.");
  return new Client({
    host: process.env.PGHOST || process.env.DB_HOST || "localhost",
    port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
    database,
    user,
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD,
  });
}

async function applySchema(client) {
  await client.query(fs.readFileSync(SQL_PATH, "utf8"));
}

async function fetchMasterMaps(client) {
  const result = await client.query(
    `
      select unique_key, base_no, branch_no, title
      from cl.heydouga_4017_m002_master
    `
  );
  const byUnique = new Map();
  const branchlessByBase = new Map();
  for (const row of result.rows) {
    byUnique.set(row.unique_key, row);
    if (!row.branch_no) branchlessByBase.set(row.base_no, row);
  }
  return { byUnique, branchlessByBase };
}

function scanRoots(roots, masterMaps) {
  const rows = [];
  for (const root of roots) {
    for (const filePath of listVideoFiles(root)) {
      rows.push(buildOwnedRow(root, filePath, masterMaps));
    }
  }
  return rows.sort((a, b) => a.file_path.localeCompare(b.file_path));
}

function listVideoFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
    }
  }
  return files;
}

function buildOwnedRow(root, filePath, masterMaps) {
  const parsed = path.parse(filePath);
  const haystack = `${parsed.name} ${path.dirname(filePath)}`;
  let extraction = extractHeydouga4017Key(parsed.name);
  if (!extraction.baseNo) extraction = extractHeydouga4017Key(haystack);

  let master = extraction.uniqueKey ? masterMaps.byUnique.get(extraction.uniqueKey) : null;
  if (!master && extraction.baseNo && !extraction.branchNo) {
    master = masterMaps.branchlessByBase.get(extraction.baseNo) || null;
  }

  const stat = safeStat(filePath);
  return {
    verify_status: master ? "matched_master" : "not_matched",
    root,
    movie_code: master?.unique_key || extraction.uniqueKey || "",
    base_no: master?.base_no || extraction.baseNo || "",
    branch_no: master?.branch_no || extraction.branchNo || "",
    master_title: master?.title || "",
    file_path: filePath,
    file_name: path.basename(filePath),
    file_ext: parsed.ext.replace(/^\./, "").toLowerCase(),
    drive_letter: parsed.root.replace(/[:\\]/g, "").toUpperCase(),
    file_size_bytes: stat?.size || "",
    file_mtime: stat?.mtime ? stat.mtime.toISOString() : "",
  };
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function extractHeydouga4017Key(value) {
  const normalized = normalizeForMatch(value);
  const lower = normalized.toLowerCase();
  const siteMatch = lower.match(/(?:heydouga|hey)[\s_.-]*4017/);
  const heydougaPpvMatch = lower.match(/(?:heydouga|hey)[\s_.-]*ppv/);
  const bare4017Match = lower.match(/\b4017\b/);
  if (!siteMatch && !heydougaPpvMatch && !bare4017Match) return {};

  const anchorMatch = siteMatch || bare4017Match || heydougaPpvMatch;
  const afterAnchor = normalized.slice(anchorMatch.index + anchorMatch[0].length);
  const windowText = afterAnchor.slice(0, 140);
  const baseMatch = windowText.match(/^[\s_.-]*(?:ppv[\s_.-]*)?([0-9]{1,5})/i);
  if (!baseMatch) return {};

  const baseNo = baseMatch[1];
  const afterBase = windowText.slice(baseMatch[0].length);
  const branchNo = extractBranchNoAfterBase(afterBase);
  if (!branchNo) return { baseNo, branchNo: "", uniqueKey: "" };

  const normalizedBranchNo = normalizeBranchNo(branchNo);
  return { baseNo, branchNo: normalizedBranchNo, uniqueKey: `${baseNo}-${normalizedBranchNo}` };
}

function extractBranchNoAfterBase(value) {
  const text = String(value || "");
  const partMatch = text.match(/^[\s_.-]*(?:part)[\s_.-]*([0-9]{1,5})/i);
  if (partMatch) return partMatch[1];

  const ppvBranchMatch = text.match(/^[\s_.-]*(?:ppv)[\s_.-]*([0-9]{1,5})/i);
  if (ppvBranchMatch) return ppvBranchMatch[1];

  const qualityMatch = text.match(/^[\s_.-]*(?:fhd|hd|4k)[\s_.-]*([0-9]{1,5})/i);
  if (qualityMatch) return qualityMatch[1];

  const directNumberMatch = text.match(/^[\s_.-]+([0-9]{1,5})(?=\s|$|fhd|hd|[^0-9A-Za-z])/i);
  if (directNumberMatch) return directNumberMatch[1];

  const trailingQualityMatch = text.match(/(?:^|[\s_.-])(?:fhd|hd|4k)[\s_.-]*([0-9]{1,5})(?=$|[\s_.-]|[^0-9A-Za-z])/i);
  if (trailingQualityMatch) return trailingQualityMatch[1];

  return "";
}

function normalizeBranchNo(branchNo) {
  const value = String(branchNo || "");
  if (/^[0-9]+$/.test(value)) return String(Number(value));
  return value;
}

function normalizeForMatch(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

async function upsertOwnedRows(client, rows) {
  await client.query("begin");
  try {
    let upserted = 0;
    for (const row of rows) {
      await client.query(
        `
          insert into cl.heydouga_4017_owned_file (
            movie_code,
            base_no,
            branch_no,
            file_path,
            file_name,
            file_ext,
            drive_letter,
            file_size_bytes,
            file_mtime,
            last_seen_at,
            note
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
          on conflict (file_path) do update
          set movie_code = excluded.movie_code,
              base_no = excluded.base_no,
              branch_no = excluded.branch_no,
              file_name = excluded.file_name,
              file_ext = excluded.file_ext,
              drive_letter = excluded.drive_letter,
              file_size_bytes = excluded.file_size_bytes,
              file_mtime = excluded.file_mtime,
              last_seen_at = now(),
              note = excluded.note,
              updated_at = now()
        `,
        [
          row.movie_code,
          row.base_no,
          row.branch_no,
          row.file_path,
          row.file_name,
          row.file_ext,
          row.drive_letter,
          row.file_size_bytes || null,
          row.file_mtime || null,
          "Synced from E/F/H/K/N heydouga_4017 collection folders.",
        ]
      );
      upserted += 1;
    }

    await client.query("commit");
    return { upserted, deleted_stale: 0, prune_stale: false };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function fetchOwnedSummary(client) {
  const totals = await client.query(
    `
      select
        count(*)::integer as total,
        count(distinct movie_code)::integer as unique_movies
      from cl.heydouga_4017_owned_file
    `
  );
  const drives = await client.query(
    `
      select drive_letter, count(*)::integer as drive_count
      from cl.heydouga_4017_owned_file
      group by drive_letter
      order by drive_letter
    `
  );
  const byDrive = {};
  for (const row of drives.rows) byDrive[row.drive_letter] = row.drive_count;
  return {
    total: totals.rows[0]?.total || 0,
    unique_movies: totals.rows[0]?.unique_movies || 0,
    by_drive: byDrive,
  };
}

function summarizeRows(rows) {
  const byStatus = {};
  const byDrive = {};
  for (const row of rows) {
    byStatus[row.verify_status] = (byStatus[row.verify_status] || 0) + 1;
    byDrive[row.drive_letter] = (byDrive[row.drive_letter] || 0) + 1;
  }
  return {
    total_video_files: rows.length,
    by_status: byStatus,
    by_drive: byDrive,
    not_matched_preview: rows
      .filter((row) => row.verify_status !== "matched_master")
      .slice(0, 20)
      .map((row) => ({
        file_name: row.file_name,
        file_path: row.file_path,
        base_no: row.base_no,
        branch_no: row.branch_no,
      })),
  };
}

function writeReviewCsv(rows) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const outputPath = path.join(EXPORT_DIR, `${SOURCE_NAME}_owned_master_sync_${stamp}.csv`);
  const columns = [
    "verify_status",
    "root",
    "movie_code",
    "base_no",
    "branch_no",
    "master_title",
    "file_path",
    "file_name",
    "file_ext",
    "drive_letter",
    "file_size_bytes",
    "file_mtime",
  ];
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => escapeCsv(row[column])).join(","));
  fs.writeFileSync(outputPath, `${lines.join("\r\n")}\r\n`, "utf8");
  return outputPath;
}

function escapeCsv(value) {
  const raw = String(value ?? "");
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);
  const client = createPgClient();
  await client.connect();
  try {
    if (args.step === "migrate") {
      await applySchema(client);
      process.stdout.write(`${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv) }, null, 2)}\n`);
      return;
    }

    if (args.step === "verify-db") {
      await applySchema(client);
      const ownedSummary = await fetchOwnedSummary(client);
      const library = await client.query("select count(*)::integer as total from cl.heydouga_4017_v_library_items");
      const completion = await client.query(
        `
          select
            count(*)::integer as total,
            count(*) filter (where is_owned)::integer as owned_total
          from cl.heydouga_4017_v_completion_items
        `
      );
      const sites = await client.query(
        `
          select site_id, site_code, site_name, note
          from cl.site_master
          where site_code in ('paco', 'heydouga_4017')
          order by site_id
        `
      );
      process.stdout.write(
        `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), owned_summary: ownedSummary, library_view_total: library.rows[0]?.total || 0, completion_view: completion.rows[0] || {}, sites: sites.rows }, null, 2)}\n`
      );
      return;
    }

    await applySchema(client);
    const masterMaps = await fetchMasterMaps(client);
    const rows = scanRoots(args.roots, masterMaps);
    const outputPath = writeReviewCsv(rows);
    const summary = summarizeRows(rows);

    if (args.step === "review") {
      process.stdout.write(
        `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), output_path: outputPath, roots: args.roots, summary }, null, 2)}\n`
      );
      return;
    }

    if (args.step === "apply") {
      const notMatched = rows.filter((row) => row.verify_status !== "matched_master");
      if (notMatched.length > 0) throw new Error(`Owned scan has not_matched rows: ${notMatched.length}`);
      const syncResult = await upsertOwnedRows(client, rows);
      if (syncResult.upserted > 0) {
        syncResult.video_metadata = runVideoMetadataCollect(args.envFile);
      }
      const ownedSummary = await fetchOwnedSummary(client);
      process.stdout.write(
        `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), output_path: outputPath, roots: args.roots, scan_summary: summary, sync_result: syncResult, owned_summary: ownedSummary }, null, 2)}\n`
      );
      return;
    }

    throw new Error(`Unsupported step: ${args.step}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
