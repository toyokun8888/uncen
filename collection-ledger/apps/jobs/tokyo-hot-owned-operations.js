"use strict";

const fs = require("fs");
const path = require("path");

const SOURCE = "tokyo_hot";
const MASTER_TABLE = "cl.tokyo_hot_m008_master";
const OWNED_TABLE = "cl.tokyo_hot_owned_file";
const PRIMARY_SPECIAL_FOLDER = "G:\\all\\お気に入りD(F)\\新規DL\\月極\\東熱";
const EXPLICIT_OWNED_FOLDERS = [
  { path: PRIMARY_SPECIAL_FOLDER, scope: "special_folder", allowMasterSupplement: true },
  { path: "N:\\NEWRG\\4K_TokyoHot", scope: "explicit_owned_folder", allowMasterSupplement: false },
  { path: "L:\\all\\LONG\\Tokyo-Hot-n0001-500", scope: "explicit_owned_folder", allowMasterSupplement: false },
  { path: "N:\\25.12\\newtokyohot\\N", scope: "explicit_owned_folder", allowMasterSupplement: false },
];
const SPECIAL_FOLDER = "G:\\all\\お気に入りD(F)\\新規DL\\月極\\東熱";
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".avi", ".wmv", ".ts", ".m2ts"]);
const NAS_DRIVES = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P", "Q"];

function parseArgs(argv) {
  const args = { step: "review", envFile: "", planCsv: "", outputDir: path.resolve("storage", "exports", SOURCE), limit: 0, explicitOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--step") args.step = argv[++i];
    else if (arg.startsWith("--step=")) args.step = arg.slice(7);
    else if (arg === "--env-file") args.envFile = argv[++i];
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice(11);
    else if (arg === "--plan-csv") args.planCsv = argv[++i];
    else if (arg.startsWith("--plan-csv=")) args.planCsv = arg.slice(11);
    else if (arg === "--output-dir") args.outputDir = argv[++i];
    else if (arg.startsWith("--output-dir=")) args.outputDir = arg.slice(13);
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice(8));
    else if (arg === "--explicit-only") args.explicitOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnvFile(envFile) {
  const target = [envFile, path.resolve(__dirname, "..", "..", ".env")]
    .filter(Boolean).map((candidate) => path.resolve(candidate)).find((candidate) => fs.existsSync(candidate));
  if (!target) return "";
  for (const raw of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim().replace(/^\uFEFF/, "");
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return target;
}

function envValue(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") return String(value);
  }
  return undefined;
}

function createPgClient() {
  const { Client } = require("pg");
  const connectionString = envValue("DATABASE_URL", "POSTGRES_URL");
  const config = connectionString ? { connectionString } : {
    host: envValue("PGHOST", "DB_HOST", "POSTGRES_HOST") || "localhost",
    port: Number(envValue("PGPORT", "DB_PORT", "POSTGRES_PORT") || 5432),
    database: envValue("PGDATABASE", "DB_NAME", "POSTGRES_DB", "POSTGRES_DATABASE", "DATABASE_NAME"),
    user: envValue("PGUSER", "DB_USER", "POSTGRES_USER"),
    password: envValue("PGPASSWORD", "DB_PASSWORD", "POSTGRES_PASSWORD", "DATABASE_PASSWORD", "POSTGRESQL_PASSWORD"),
  };
  if (!connectionString && (!config.database || !config.user)) throw new Error("Database connection is missing.");
  return new Client(config);
}

function normalizeWindowsPath(targetPath) {
  const raw = String(targetPath || "").trim().replace(/\//g, "\\");
  const fixed = raw.replace(/^[\\]+([A-Za-z]:)/, "$1").replace(/^([A-Za-z]):(?![\\])/, "$1:\\");
  return path.normalize(fixed).replace(/\//g, "\\");
}

function driveLetter(filePath) {
  const match = normalizeWindowsPath(filePath).match(/^([A-Za-z]):\\/);
  return match ? match[1].toUpperCase() : "";
}

function normalizeMovieCode(value) {
  const match = String(value || "").toLowerCase().match(/\bn[\s._-]*0*([0-9]{1,5})(?![0-9])/);
  if (!match) return "";
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number <= 0) return "";
  return `n${String(number).padStart(4, "0")}`;
}

function numericCode(movieCode) {
  const match = String(movieCode || "").match(/^n0*([0-9]+)$/);
  return match ? Number(match[1]) : null;
}

function parseSpecialFileName(filePath) {
  const base = path.parse(filePath).name;
  const code = normalizeMovieCode(base);
  let rest = base.replace(/^n[\s._-]*0*[0-9]{1,5}[\s._-]*/i, "").trim();
  rest = rest.replace(/^[a-z0-9]+(?:_[a-z0-9]+)*[\s._-]+/i, "").trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const separatedParts = rest.split(/[・･]/).map((part) => part.trim()).filter(Boolean);
  const actorName = parts.length > 1 ? parts[parts.length - 1] : separatedParts.length > 1 ? separatedParts[separatedParts.length - 1] : "";
  const title = parts.length > 1 ? parts.slice(0, -1).join(" ") : separatedParts.length > 1 ? separatedParts.slice(0, -1).join("・") : rest || code;
  return { movie_code: code, title, actor_name: actorName };
}

async function loadMasters(client) {
  const result = await client.query(`select movie_code,title,title_ja,actor_name,actor_name_ja from ${MASTER_TABLE}`);
  return new Map(result.rows.map((row) => [row.movie_code, row]));
}

async function loadOwnedPaths(client) {
  const result = await client.query(`select file_path from ${OWNED_TABLE}`);
  return new Set(result.rows.map((row) => normalizeWindowsPath(row.file_path).toLowerCase()));
}

function availableDriveRoots() {
  return NAS_DRIVES.map((drive) => `${drive}:\\`).filter((root) => fs.existsSync(root));
}

function listVideoFiles(root, scanErrors, limitRef) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      scanErrors.push({ drive: driveLetter(current), path: current, error: String(error.message || error) });
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
        limitRef.count += 1;
        if (limitRef.limit > 0 && limitRef.count >= limitRef.limit) return files;
      }
    }
  }
  return files;
}

function targetOwnedPath(filePath) {
  return `${driveLetter(filePath)}:\\uncen\\tokyo_hot\\${path.basename(filePath)}`;
}

function explicitFolderConfig(filePath) {
  const normalized = normalizeWindowsPath(filePath).toLowerCase();
  return EXPLICIT_OWNED_FOLDERS.find((folder) => {
    const root = normalizeWindowsPath(folder.path).toLowerCase().replace(/[\\]+$/, "");
    return normalized === root || normalized.startsWith(`${root}\\`);
  }) || null;
}

function fileRow(filePath, masters, ownedPaths, scope) {
  const normalizedPath = normalizeWindowsPath(filePath);
  const explicitConfig = explicitFolderConfig(normalizedPath);
  const effectiveScope = explicitConfig?.scope || scope;
  const stat = fs.statSync(normalizedPath);
  const movieCode = normalizeMovieCode(path.basename(filePath));
  let status = "ready";
  let operation = "move_and_register";
  let title = masters.get(movieCode)?.title_ja || masters.get(movieCode)?.title || "";
  let actorName = masters.get(movieCode)?.actor_name_ja || masters.get(movieCode)?.actor_name || "";
  let outputPath = targetOwnedPath(normalizedPath);
  let note = "";
  if (!movieCode) status = "not_tokyo_hot_candidate";
  else if (ownedPaths.has(normalizedPath.toLowerCase())) status = "already_registered";
  else if (!masters.has(movieCode)) status = "missing_master";
  if (explicitConfig) {
    operation = "register_owned_only";
    outputPath = normalizedPath;
    const parsed = parseSpecialFileName(normalizedPath);
    title = masters.get(movieCode)?.title_ja || masters.get(movieCode)?.title || parsed.title;
    actorName = masters.get(movieCode)?.actor_name_ja || masters.get(movieCode)?.actor_name || parsed.actor_name;
    if (!movieCode) status = "unreadable";
    else if (masters.has(movieCode)) status = ownedPaths.has(normalizedPath.toLowerCase()) ? "already_registered" : "ready";
    else if (explicitConfig.allowMasterSupplement) {
      status = title && actorName ? "ready_special_master_insert" : "missing_master_parse_failed";
      note = "special folder master supplement candidate";
    } else status = "missing_master";
  }
  return {
    status,
    scope: effectiveScope,
    operation,
    movie_code: movieCode,
    title,
    actor_name: actorName,
    source_path: normalizedPath,
    output_path: outputPath,
    file_name: path.basename(normalizedPath),
    file_ext: path.extname(normalizedPath).slice(1).toLowerCase(),
    drive_letter: driveLetter(normalizedPath),
    file_size_bytes: stat.size,
    file_mtime: stat.mtime.toISOString(),
    note,
  };
}

async function buildPlan(client, args) {
  const masters = await loadMasters(client);
  const ownedPaths = await loadOwnedPaths(client);
  const scanErrors = [];
  const rows = [];
  const perDrive = {};
  const limitRef = { limit: args.limit, count: 0 };
  for (const root of availableDriveRoots()) {
    const before = rows.length;
    const files = listVideoFiles(root, scanErrors, limitRef);
    for (const file of files) rows.push(fileRow(file, masters, ownedPaths, "nas_all"));
    perDrive[driveLetter(root)] = rows.length - before;
    if (args.limit > 0 && limitRef.count >= args.limit) break;
  }
  for (const folder of EXPLICIT_OWNED_FOLDERS) {
    if (fs.existsSync(folder.path)) {
      for (const file of listVideoFiles(folder.path, scanErrors, { limit: 0, count: 0 })) {
        rows.push(fileRow(file, masters, ownedPaths, folder.scope));
      }
    }
  }
  dedupeRowsBySourcePath(rows);
  markDuplicates(rows);
  return {
    rows,
    scanErrors,
    perDrive,
    available_roots: availableDriveRoots(),
    explicit_owned_folders: EXPLICIT_OWNED_FOLDERS.map((folder) => folder.path),
  };
}

function dedupeRowsBySourcePath(rows) {
  const seen = new Set();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const key = normalizeWindowsPath(rows[index].source_path).toLowerCase();
    if (seen.has(key)) {
      rows.splice(index, 1);
      continue;
    }
    seen.add(key);
  }
}

function markDuplicates(rows) {
  const bySource = new Map();
  for (const row of rows) {
    if (!row.movie_code) continue;
    const values = bySource.get(row.movie_code) || [];
    values.push(row);
    bySource.set(row.movie_code, values);
  }
  for (const values of bySource.values()) {
    if (values.length < 2) continue;
    for (const row of values) {
      if (row.status === "ready" && row.operation !== "register_owned_only") row.status = "duplicate_candidate";
    }
  }
}

function writeCsv(rows, outputDir, label) {
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, `${SOURCE}_owned_${label}_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}.csv`);
  const columns = ["status", "scope", "operation", "movie_code", "title", "actor_name", "source_path", "output_path", "file_name", "file_ext", "drive_letter", "file_size_bytes", "file_mtime", "note"];
  const escape = (value) => {
    const raw = String(value ?? "");
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  fs.writeFileSync(output, `${[columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\r\n")}\r\n`, "utf8");
  return output;
}

function parseCsv(text) {
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); records.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field); records.push(row); }
  const headers = records.shift() || [];
  return records.filter((record) => record.some(Boolean)).map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] || ""])));
}

async function readApprovedPlan(client, args) {
  if (!args.planCsv) throw new Error("--plan-csv is required for apply");
  const rows = parseCsv(fs.readFileSync(path.resolve(args.planCsv), "utf8"));
  const allowed = new Set(["ready", "ready_special_master_insert"]);
  for (const row of rows) {
    if (!allowed.has(row.status)) throw new Error(`Plan contains unsafe row: ${row.status} ${row.source_path}`);
    if (!["move_and_register", "register_owned_only"].includes(row.operation)) throw new Error(`Unsupported operation: ${row.operation}`);
    const source = normalizeWindowsPath(row.source_path);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Source file is missing: ${source}`);
    if (String(fs.statSync(source).size) !== String(row.file_size_bytes)) throw new Error(`File size changed: ${source}`);
    if (!row.movie_code || normalizeMovieCode(row.movie_code) !== row.movie_code) throw new Error(`Invalid movie_code: ${row.movie_code}`);
    if (row.operation === "move_and_register" && path.basename(row.output_path) !== path.basename(row.source_path)) throw new Error(`Rename is not allowed: ${row.source_path}`);
  }
  return rows;
}

async function applyPlan(client, rows) {
  let registered = 0;
  let moved = 0;
  let insertedMasters = 0;
  const movedFiles = [];
  await client.query("begin");
  try {
    for (const row of rows) {
      if (row.status === "ready_special_master_insert") {
        await client.query(`
          insert into ${MASTER_TABLE} (movie_code,relation_key_mmddyy,original_movie_code,movie_code_suffix,numeric_code,title,title_ja,actor_name,actor_name_ja,channel_name,review_status,note)
          values ($1,$1,$1,$2,$3,$4,$4,$5,$5,'Tokyo-Hot','manual_supplement','Inserted from special folder filename')
          on conflict (movie_code) do nothing`,
        [row.movie_code, String(numericCode(row.movie_code) || ""), numericCode(row.movie_code), row.title || row.movie_code, row.actor_name || null]);
        insertedMasters += 1;
      }
      let finalPath = normalizeWindowsPath(row.source_path);
      if (row.operation === "move_and_register") {
        const outputPath = normalizeWindowsPath(row.output_path);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        if (normalizeWindowsPath(row.source_path).toLowerCase() !== outputPath.toLowerCase()) {
          if (fs.existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
          fs.renameSync(row.source_path, outputPath);
          movedFiles.push({ from: outputPath, to: normalizeWindowsPath(row.source_path) });
          moved += 1;
        }
        finalPath = outputPath;
      }
      const stat = fs.statSync(finalPath);
      const sourceType = row.scope === "special_folder" ? "special_folder" : "normal";
      const matchMethod = row.scope === "special_folder"
        ? "special_filename"
        : row.scope === "explicit_owned_folder"
          ? "explicit_folder_filename"
          : "nas_all_filename";
      await client.query(`
        insert into ${OWNED_TABLE} (movie_code,file_path,file_name,file_ext,drive_letter,file_size_bytes,file_mtime,source_type,match_method,match_score,original_file_name,note,last_seen_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1.0,$10,$11,now())
        on conflict (file_path) do update set movie_code=excluded.movie_code,file_size_bytes=excluded.file_size_bytes,file_mtime=excluded.file_mtime,last_seen_at=now(),updated_at=now()`,
      [row.movie_code, finalPath, path.basename(finalPath), path.extname(finalPath).slice(1).toLowerCase(), driveLetter(finalPath), stat.size, stat.mtime, sourceType, matchMethod, row.file_name, row.note || null]);
      registered += 1;
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    for (const movedFile of movedFiles.reverse()) {
      try {
        if (fs.existsSync(movedFile.from) && !fs.existsSync(movedFile.to)) fs.renameSync(movedFile.from, movedFile.to);
      } catch (rollbackError) {
        process.stderr.write(`warning: failed to restore moved file ${movedFile.from}: ${rollbackError.message}\n`);
      }
    }
    throw error;
  }
  return { registered, moved, inserted_masters: insertedMasters };
}

function summarize(rows, scanErrors, perDrive, availableRoots, explicitOwnedFolders, outputPath) {
  const count = (status) => rows.filter((row) => row.status === status).length;
  return {
    output_path: outputPath,
    search_scope: "NAS_ALL_ROOTS",
    available_roots: availableRoots,
    explicit_owned_folders: explicitOwnedFolders,
    per_drive_video_count: perDrive,
    scan_error_count: scanErrors.length,
    scan_errors: scanErrors.slice(0, 100),
    row_count: rows.length,
    ready_count: count("ready"),
    special_master_insert_ready_count: count("ready_special_master_insert"),
    missing_master_count: count("missing_master"),
    duplicate_candidate_count: count("duplicate_candidate"),
    unreadable_count: count("unreadable"),
    already_registered_count: count("already_registered"),
    not_tokyo_hot_candidate_count: count("not_tokyo_hot_candidate"),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  loadEnvFile(args.envFile);
  const client = createPgClient();
  await client.connect();
  try {
    if (args.step === "review") {
      const plan = await buildPlan(client, args);
      const outputPath = writeCsv(plan.rows, args.outputDir, "review");
      process.stdout.write(`${JSON.stringify({ ok: true, source: SOURCE, step: "review", result: summarize(plan.rows, plan.scanErrors, plan.perDrive, plan.available_roots, plan.explicit_owned_folders, outputPath) }, null, 2)}\n`);
      return;
    }
    if (args.step === "ready-plan") {
      const sourceRows = args.planCsv ? parseCsv(fs.readFileSync(path.resolve(args.planCsv), "utf8")) : (await buildPlan(client, args)).rows;
      const rows = sourceRows.filter((row) => {
        if (row.status !== "ready" && row.status !== "ready_special_master_insert") return false;
        return !args.explicitOnly || row.operation === "register_owned_only";
      });
      const outputPath = writeCsv(rows, args.outputDir, "ready-plan");
      process.stdout.write(`${JSON.stringify({ ok: true, source: SOURCE, step: "ready-plan", output_path: outputPath, result: { ready_count: rows.length, explicit_only: args.explicitOnly } }, null, 2)}\n`);
      return;
    }
    if (args.step === "apply") {
      const rows = await readApprovedPlan(client, args);
      const result = await applyPlan(client, rows);
      const outputPath = writeCsv(rows, args.outputDir, "apply");
      process.stdout.write(`${JSON.stringify({ ok: true, source: SOURCE, step: "apply", output_path: outputPath, result }, null, 2)}\n`);
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
