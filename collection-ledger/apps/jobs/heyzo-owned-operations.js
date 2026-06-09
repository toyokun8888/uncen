"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SOURCE = "heyzo";
const DB_PREFIX = "heyzo";
const SEARCH_TEXT = "heyzo";
const DRIVES = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P"];
const VIDEO_EXTENSIONS = new Set([".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpg", ".mpeg", ".ts", ".wmv"]);

function parseArgs(argv) {
  const args = { step: "collect-review", inputDir: "", planCsv: "", envFile: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--step") args.step = argv[++i];
    else if (arg.startsWith("--step=")) args.step = arg.slice(7);
    else if (arg === "--input-dir") args.inputDir = argv[++i];
    else if (arg.startsWith("--input-dir=")) args.inputDir = arg.slice(12);
    else if (arg === "--plan-csv") args.planCsv = argv[++i];
    else if (arg.startsWith("--plan-csv=")) args.planCsv = arg.slice(11);
    else if (arg === "--env-file") args.envFile = argv[++i];
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice(11);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnvFile(envFile) {
  const target = [envFile, path.resolve(__dirname, "..", "..", ".env")]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => fs.existsSync(candidate));
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

function runVideoMetadataCollect(envFile) {
  const scriptPath = path.resolve(__dirname, "collect-video-metadata.js");
  const commandArgs = [scriptPath, "--source", SOURCE, "--step", "collect"];
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
  const databaseKeys = ["PGDATABASE", "DB_NAME", "POSTGRES_DB", "POSTGRES_DATABASE", "DATABASE_NAME"];
  const userKeys = ["PGUSER", "DB_USER", "POSTGRES_USER"];
  const passwordKeys = ["PGPASSWORD", "DB_PASSWORD", "POSTGRES_PASSWORD", "DATABASE_PASSWORD", "POSTGRESQL_PASSWORD"];
  const config = connectionString ? { connectionString } : {
    host: envValue("PGHOST", "DB_HOST", "POSTGRES_HOST") || "localhost",
    port: Number(envValue("PGPORT", "DB_PORT", "POSTGRES_PORT") || 5432),
    database: envValue(...databaseKeys),
    user: envValue(...userKeys),
    password: envValue(...passwordKeys),
  };
  if (!connectionString) {
    for (const [name, keys] of [["database", databaseKeys], ["user", userKeys], ["password", passwordKeys]]) {
      if (config[name] === undefined) {
        throw new Error(`Database ${name} is missing. Tried: ${keys.join(", ")} in --env-file or process environment.`);
      }
    }
  }
  return new Client(config);
}

function listFiles(root, predicate, excludedRoots = []) {
  const files = [];
  const errors = [];
  if (!fs.existsSync(root)) return { files, errors: [{ path: root, error: "root_not_found" }] };
  const excluded = excludedRoots.map((item) => path.resolve(item).toLowerCase());
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const currentPath = path.resolve(current).toLowerCase();
    if (excluded.some((item) => currentPath === item || currentPath.startsWith(`${item}${path.sep}`))) continue;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) { errors.push({ path: current, error: error.code || error.message }); continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && predicate(fullPath)) files.push(fullPath);
    }
  }
  return { files: files.sort((a, b) => a.localeCompare(b)), errors };
}

function isVideo(filePath) { return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase()); }
function cleanName(value) { return String(value || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 180); }
function driveOf(filePath) { return path.parse(path.resolve(filePath)).root.slice(0, 1).toUpperCase(); }
function targetDirForDrive(drive) { return `${drive}:\\uncen\\${SOURCE}`; }
function inputDirForDrive(drive) { return `${drive}:\\uncen\\${SOURCE}_new_mp4`; }
function trashDirForDrive(drive) { return `${drive}:\\uncen\\${SOURCE}_trash`; }

function normalizeMovieNumber(value) {
  const match = String(value || "").match(/([0-9]{1,6})/);
  if (!match) return "";
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? String(number) : "";
}

function normalizeMovieCode(value) {
  const number = normalizeMovieNumber(value);
  return number ? `heyzo-${number}` : "";
}

function movieNumber(movieCode) {
  return normalizeMovieNumber(movieCode);
}

function uniqueTargetPath(targetDir, fileName, reserved = new Set()) {
  const parsed = path.parse(fileName);
  let candidate = path.join(targetDir, fileName);
  let counter = 1;
  while (fs.existsSync(candidate) || reserved.has(candidate.toLowerCase())) {
    candidate = path.join(targetDir, `${parsed.name} (${counter})${parsed.ext}`);
    counter += 1;
  }
  return candidate;
}

function buildCollectPlan() {
  const rows = [];
  const plannedTargets = new Set();
  for (const drive of DRIVES) {
    const root = `${drive}:\\`;
    const targetDir = targetDirForDrive(drive);
    const inputDir = inputDirForDrive(drive);
    const trashDir = trashDirForDrive(drive);
    const scan = listFiles(
      root,
      (filePath) => isVideo(filePath) && path.basename(filePath).toLowerCase().includes(SEARCH_TEXT),
      [targetDir, inputDir, trashDir, `${drive}:\\System Volume Information`, `${drive}:\\$RECYCLE.BIN`]
    );
    for (const filePath of scan.files) {
      const stat = fs.statSync(filePath);
      const targetPath = uniqueTargetPath(targetDir, path.basename(filePath), plannedTargets);
      const targetKey = targetPath.toLowerCase();
      rows.push({
        status: plannedTargets.has(targetKey) ? "duplicate_target_path" : "ready",
        operation: "collect",
        movie_code: "",
        source_path: filePath,
        target_path: targetPath,
        file_name: path.basename(filePath),
        drive_letter: drive,
        file_size_bytes: stat.size,
        file_mtime: stat.mtime.toISOString(),
        error: "",
      });
      plannedTargets.add(targetKey);
    }
    for (const error of scan.errors) rows.push({ status: "scan_error", operation: "", movie_code: "", source_path: error.path, target_path: "", file_name: "", drive_letter: drive, error: error.error });
  }
  return rows;
}

function candidateCodes(fileName, allowRenamed = false) {
  const stem = path.parse(fileName).name;
  const lower = stem.toLowerCase();
  if (!lower.includes("heyzo") && !allowRenamed) return [];
  const result = [];
  for (const match of stem.matchAll(/heyzo(?:[_\-\s]+(?:hd|fhd|full|lt|mb|sd))?[_\-\s]*(?:vol[_\-\s]*)?([0-9]{1,6})/gi)) {
    const code = normalizeMovieCode(match[1]);
    if (code) result.push(code);
  }
  if (allowRenamed) {
    const prefix = stem.match(/^heyzo[-_ ]?([0-9]{1,6})(?:[_ -]|$)/i);
    const code = prefix ? normalizeMovieCode(prefix[1]) : "";
    if (code) result.push(code);
  }
  return [...new Set(result)];
}

async function fetchMasterMap(client) {
  const result = await client.query(`select movie_code, relation_key_mmddyy, title, coalesce(actor_name,'') actor_name from cl.${DB_PREFIX}_m004_master`);
  const exact = new Map(result.rows.map((row) => [row.movie_code.toLowerCase(), row]));
  const relation = new Map();
  for (const row of result.rows) {
    const items = relation.get(row.relation_key_mmddyy) || [];
    items.push(row);
    relation.set(row.relation_key_mmddyy, items);
  }
  return { exact, relation };
}

function matchMaster(fileName, maps, allowRenamed = false) {
  const candidates = candidateCodes(fileName, allowRenamed);
  const exactMatches = [...new Map(candidates
    .map((candidate) => maps.exact.get(candidate.toLowerCase()))
    .filter(Boolean)
    .map((master) => [master.movie_code, master])).values()];
  if (exactMatches.length === 1) return { master: exactMatches[0], candidates, reason: "exact" };
  if (exactMatches.length > 1) return { master: null, candidates, reason: "multiple_exact_matches" };
  const relationMatches = [...new Map(candidates
    .map((candidate) => movieNumber(candidate))
    .filter(Boolean)
    .flatMap((candidate) => maps.relation.get(candidate) || [])
    .map((master) => [master.movie_code, master])).values()];
  if (relationMatches.length === 1) return { master: relationMatches[0], candidates, reason: "relation_unique" };
  if (relationMatches.length > 1) return { master: null, candidates, reason: "relation_ambiguous" };
  return { master: null, candidates, reason: "not_matched" };
}

async function buildOwnedPlan(client, inputDir) {
  const resolvedInput = path.resolve(inputDir);
  const drive = driveOf(resolvedInput);
  const expectedInput = path.resolve(inputDirForDrive(drive));
  if (!DRIVES.includes(drive) || resolvedInput.toLowerCase() !== expectedInput.toLowerCase()) {
    throw new Error(`Input directory must be exactly ${expectedInput}`);
  }
  const targetDir = targetDirForDrive(drive);
  const maps = await fetchMasterMap(client);
  const scan = listFiles(resolvedInput, isVideo);
  const rows = [];
  const targetCounts = new Map();
  const reservedTargets = new Set();
  for (const filePath of scan.files) {
    const stat = fs.statSync(filePath);
    const match = matchMaster(path.basename(filePath), maps, false);
    const master = match.master;
    const ext = path.extname(filePath).toLowerCase();
    const actor = master ? cleanName(master.actor_name) : "";
    const title = master ? cleanName(master.title) : "";
    const newName = master ? `${master.movie_code}_${title}${actor ? `_${actor}` : ""}${ext}` : path.basename(filePath);
    const targetPath = master ? uniqueTargetPath(targetDir, newName, reservedTargets) : path.join(trashDirForDrive(drive), path.basename(filePath));
    let status = master ? "ready" : match.reason;
    if (!stat.size) status = "invalid_video_file";
    if (master && fs.existsSync(targetPath) && path.resolve(targetPath).toLowerCase() !== path.resolve(filePath).toLowerCase()) status = "target_exists";
    rows.push({
      status,
      operation: master ? "rename_move_register" : "review_only",
      movie_code: master?.movie_code || "",
      match_reason: match.reason,
      candidates: match.candidates.join(" | "),
      source_path: filePath,
      target_path: targetPath,
      file_name: path.basename(filePath),
      new_file_name: master ? newName : "",
      file_ext: ext.replace(/^\./, ""),
      drive_letter: drive,
      file_size_bytes: stat.size,
      file_mtime: stat.mtime.toISOString(),
      error: "",
    });
    if (master) {
      reservedTargets.add(targetPath.toLowerCase());
      targetCounts.set(targetPath.toLowerCase(), (targetCounts.get(targetPath.toLowerCase()) || 0) + 1);
    }
  }
  for (const row of rows) {
    if (row.status !== "ready") continue;
    if ((targetCounts.get(row.target_path.toLowerCase()) || 0) > 1) row.status = "duplicate_target_path";
  }
  const ownedResult = await client.query(`select lower(file_path) file_path from cl.${DB_PREFIX}_owned_file`);
  const ownedPaths = new Set(ownedResult.rows.map((row) => row.file_path));
  const recovery = listFiles(targetDir, isVideo);
  for (const filePath of recovery.files) {
    if (ownedPaths.has(path.resolve(filePath).toLowerCase())) continue;
    const match = matchMaster(path.basename(filePath), maps, true);
    const stat = fs.statSync(filePath);
    const actor = match.master ? cleanName(match.master.actor_name) : "";
    const title = match.master ? cleanName(match.master.title) : "";
    const ext = path.extname(filePath).toLowerCase();
    const newName = match.master ? `${match.master.movie_code}_${title}${actor ? `_${actor}` : ""}${ext}` : path.basename(filePath);
    const baseTargetPath = path.join(targetDir, newName);
    const samePath = path.resolve(baseTargetPath).toLowerCase() === path.resolve(filePath).toLowerCase();
    const targetPath = samePath ? baseTargetPath : uniqueTargetPath(targetDir, newName, reservedTargets);
    let status = match.master && stat.size > 0 ? "ready" : "recovery_not_matched";
    if (match.master && fs.existsSync(targetPath) && !samePath) status = "target_exists";
    rows.push({
      status: samePath && status === "ready" ? "ready_recover_owned" : status,
      operation: samePath ? "register_owned_only" : "rename_move_register",
      movie_code: match.master?.movie_code || "",
      match_reason: match.reason,
      candidates: match.candidates.join(" | "),
      source_path: filePath,
      target_path: targetPath,
      file_name: path.basename(filePath),
      new_file_name: newName,
      file_ext: ext.replace(/^\./, ""),
      drive_letter: drive,
      file_size_bytes: stat.size,
      file_mtime: stat.mtime.toISOString(),
      error: "",
    });
    if (match.master) {
      reservedTargets.add(targetPath.toLowerCase());
      targetCounts.set(targetPath.toLowerCase(), (targetCounts.get(targetPath.toLowerCase()) || 0) + 1);
    }
  }
  for (const row of rows) {
    if (!["ready", "ready_recover_owned"].includes(row.status)) continue;
    if ((targetCounts.get(row.target_path.toLowerCase()) || 0) > 1) row.status = "duplicate_target_path";
  }
  for (const error of scan.errors) rows.push({ status: "scan_error", operation: "", movie_code: "", match_reason: "", candidates: "", source_path: error.path, target_path: "", file_name: "", new_file_name: "", file_ext: "", drive_letter: drive, file_size_bytes: "", file_mtime: "", error: error.error });
  return rows;
}

function writeCsv(rows, outputDir, label) {
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const outputPath = path.join(outputDir, `${SOURCE}_${label}_${stamp}.csv`);
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const escape = (value) => { const raw = String(value ?? ""); return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw; };
  const lines = [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))];
  fs.writeFileSync(outputPath, `${lines.join("\r\n")}\r\n`, "utf8");
  return outputPath;
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

function isUnderDirectory(filePath, directory) {
  const resolved = path.resolve(filePath).toLowerCase();
  const root = path.resolve(directory).toLowerCase();
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return resolved === root || resolved.startsWith(prefix);
}

function assertSamePlanRow(row, expected, columns) {
  for (const column of columns) {
    if (String(row[column] || "") !== String(expected[column] || "")) {
      throw new Error(`Plan CSV ${column} changed for ${row.source_path}`);
    }
  }
}

async function readApprovedPlan(planCsv, mode, inputDir = "", client = null) {
  if (!planCsv) throw new Error("--plan-csv is required for apply");
  const rows = parseCsv(fs.readFileSync(path.resolve(planCsv), "utf8"));
  let expectedRows = [];
  if (mode === "master-complement") expectedRows = await buildMissingMasterPlan(client);
  else if (mode === "owned") expectedRows = await buildOwnedPlan(client, inputDir);
  const expectedBySource = new Map(expectedRows.map((row) => [path.resolve(row.source_path).toLowerCase(), row]));
  const targetPaths = new Set();
  for (const row of rows) {
    if (!["ready", "ready_recover_owned"].includes(row.status)) throw new Error(`Plan CSV contains unsafe row: ${row.status}`);
    const stat = fs.statSync(row.source_path);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`Source file changed or is invalid: ${row.source_path}`);
    if (Number(row.file_size_bytes || stat.size) !== stat.size) throw new Error(`Source file size changed: ${row.source_path}`);
    if (row.file_mtime && new Date(row.file_mtime).getTime() !== stat.mtime.getTime()) throw new Error(`Source file mtime changed: ${row.source_path}`);
    const sourceDrive = driveOf(row.source_path);
    if (mode === "master-complement") {
      throw new Error("HEYZO master complement is intentionally disabled; collect the official master list instead.");
    }
    if (row.operation !== "register_owned_only" && fs.existsSync(row.target_path)) throw new Error(`Target now exists: ${row.target_path}`);
    const targetDrive = driveOf(row.target_path);
    if (!DRIVES.includes(sourceDrive) || sourceDrive !== targetDrive || row.drive_letter !== sourceDrive) throw new Error(`Invalid drive mapping: ${row.source_path}`);
    const targetKey = path.resolve(row.target_path).toLowerCase();
    if (targetPaths.has(targetKey)) throw new Error(`Duplicate target in plan CSV: ${row.target_path}`);
    targetPaths.add(targetKey);
    if (mode === "collect") {
      if (row.operation !== "collect" || row.movie_code) throw new Error(`Invalid collect row: ${row.source_path}`);
      if (!isUnderDirectory(row.source_path, `${sourceDrive}:\\`) || !isUnderDirectory(row.target_path, targetDirForDrive(sourceDrive))) throw new Error(`Invalid collect paths: ${row.source_path}`);
    } else {
      if (!["rename_move_register", "register_owned_only"].includes(row.operation) || !row.movie_code) throw new Error(`Invalid owned row: ${row.source_path}`);
      const expectedInput = path.resolve(inputDirForDrive(sourceDrive));
      if (path.resolve(inputDir).toLowerCase() !== expectedInput.toLowerCase()) throw new Error(`Plan does not match input directory: ${inputDir}`);
      if (row.operation === "rename_move_register" && !isUnderDirectory(row.source_path, expectedInput) && !isUnderDirectory(row.source_path, targetDirForDrive(sourceDrive))) throw new Error(`Invalid owned source path: ${row.source_path}`);
      if (row.operation === "register_owned_only" && !isUnderDirectory(row.source_path, targetDirForDrive(sourceDrive))) throw new Error(`Invalid recovery source path: ${row.source_path}`);
      if (!isUnderDirectory(row.target_path, targetDirForDrive(sourceDrive))) throw new Error(`Invalid owned target path: ${row.target_path}`);
      const expected = expectedBySource.get(path.resolve(row.source_path).toLowerCase());
      if (!expected) throw new Error(`Owned row is no longer valid: ${row.source_path}`);
      assertSamePlanRow(row, expected, ["status", "operation", "movie_code", "match_reason", "candidates", "target_path", "new_file_name", "file_ext", "drive_letter", "file_size_bytes", "file_mtime"]);
    }
  }
  return rows;
}

function summarize(rows) {
  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  return { total: rows.length, by_status: byStatus };
}

function releaseDateFromCode(movieCode) {
  const match = String(movieCode || "").match(/^([0-9]{2})([0-9]{2})([0-9]{2})_/);
  if (!match) return null;
  const value = `20${match[3]}-${match[1]}-${match[2]}`;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

async function buildMissingMasterPlan(client) {
  void client;
  return [];
}

async function applyMissingMasters(client, rows) {
  void client;
  const unsafe = rows.filter((row) => row.status !== "ready");
  if (unsafe.length) throw new Error(`Missing master plan has unsafe rows: ${unsafe.length}`);
  return { inserted: 0 };
}

function applyCollect(rows) {
  const unsafe = rows.filter((row) => row.status !== "ready");
  if (unsafe.length) throw new Error(`Collection has unsafe rows: ${unsafe.length}`);
  for (const row of rows) {
    fs.mkdirSync(path.dirname(row.target_path), { recursive: true });
    fs.renameSync(row.source_path, row.target_path);
  }
  return { moved: rows.length };
}

async function applyOwned(client, rows) {
  const unsafe = rows.filter((row) => !["ready", "ready_recover_owned"].includes(row.status));
  if (unsafe.length) throw new Error(`Owned import has unsafe rows: ${unsafe.length}`);
  const manifestPath = writeCsv(rows, path.resolve(__dirname, "..", "..", "storage", "exports", SOURCE), "owned-apply-recovery-manifest");
  let moved = 0;
  let registered = 0;
  const movedRows = [];
  await client.query("begin");
  try {
    for (const row of rows) {
      if (row.operation !== "register_owned_only") {
        fs.mkdirSync(path.dirname(row.target_path), { recursive: true });
        fs.renameSync(row.source_path, row.target_path);
        movedRows.push(row);
        moved += 1;
      }
      const stat = fs.statSync(row.target_path);
      await client.query(`insert into cl.${DB_PREFIX}_owned_file (movie_code,file_path,file_name,file_ext,drive_letter,file_size_bytes,file_mtime,last_seen_at,note)
        values ($1,$2,$3,$4,$5,$6,$7,now(),'Imported by heyzo-owned-operations')
        on conflict (file_path) do update set movie_code=excluded.movie_code,file_name=excluded.file_name,file_ext=excluded.file_ext,drive_letter=excluded.drive_letter,
        file_size_bytes=excluded.file_size_bytes,file_mtime=excluded.file_mtime,last_seen_at=now(),updated_at=now()`,
      [row.movie_code, row.target_path, path.basename(row.target_path), row.file_ext, row.drive_letter, stat.size, stat.mtime.toISOString()]);
      registered += 1;
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    for (const row of movedRows.reverse()) {
      if (fs.existsSync(row.target_path) && !fs.existsSync(row.source_path)) fs.renameSync(row.target_path, row.source_path);
    }
    throw error;
  }
  return { moved, registered, recovery_manifest_path: manifestPath };
}

async function main() {
  const args = parseArgs(process.argv);
  loadEnvFile(args.envFile);
  if (args.step === "collect-review" || args.step === "collect-apply") {
    const rows = args.step === "collect-apply" ? await readApprovedPlan(args.planCsv, "collect") : buildCollectPlan();
    const outputPath = writeCsv(rows, path.resolve(__dirname, "..", "..", "storage", "exports", SOURCE), args.step);
    const result = args.step === "collect-apply" ? applyCollect(rows) : {};
    process.stdout.write(`${JSON.stringify({ ok: true, step: args.step, output_path: outputPath, summary: summarize(rows), result }, null, 2)}\n`);
    return;
  }
  if (args.step === "master-complement-review" || args.step === "master-complement-apply") {
    const client = createPgClient();
    await client.connect();
    try {
      const rows = args.step === "master-complement-apply" ? await readApprovedPlan(args.planCsv, "master-complement", "", client) : await buildMissingMasterPlan(client);
      const outputPath = writeCsv(rows, path.resolve(__dirname, "..", "..", "storage", "exports", SOURCE), args.step);
      const result = args.step === "master-complement-apply" ? await applyMissingMasters(client, rows) : {};
      process.stdout.write(`${JSON.stringify({ ok: true, step: args.step, output_path: outputPath, summary: summarize(rows), result }, null, 2)}\n`);
    } finally { await client.end(); }
    return;
  }
  if (!args.inputDir) throw new Error("--input-dir is required");
  if (args.step === "owned-ready-plan") {
    if (!args.planCsv) throw new Error("--plan-csv is required");
    const inputDir = path.resolve(args.inputDir);
    const rows = parseCsv(fs.readFileSync(path.resolve(args.planCsv), "utf8"))
      .filter((row) => ["ready", "ready_recover_owned"].includes(row.status));
    for (const row of rows) {
      if (!isUnderDirectory(row.source_path, inputDir) && !isUnderDirectory(row.source_path, targetDirForDrive(driveOf(inputDir)))) {
        throw new Error(`Plan row does not match input directory: ${row.source_path}`);
      }
    }
    const outputPath = writeCsv(rows, args.inputDir, args.step);
    process.stdout.write(`${JSON.stringify({ ok: true, step: args.step, input_dir: args.inputDir, output_path: outputPath, summary: summarize(rows), result: {} }, null, 2)}\n`);
    return;
  }
  const client = createPgClient();
  await client.connect();
  try {
    const rows = args.step === "owned-apply" ? await readApprovedPlan(args.planCsv, "owned", args.inputDir, client) : await buildOwnedPlan(client, args.inputDir);
    const outputPath = writeCsv(rows, args.inputDir, args.step);
    const result = args.step === "owned-apply" ? await applyOwned(client, rows) : {};
    if (args.step === "owned-apply" && result.registered > 0) {
      result.video_metadata = runVideoMetadataCollect(args.envFile);
    }
    if (!["owned-review", "owned-apply"].includes(args.step)) throw new Error(`Unsupported step: ${args.step}`);
    process.stdout.write(`${JSON.stringify({ ok: true, step: args.step, input_dir: args.inputDir, output_path: outputPath, summary: summarize(rows), result }, null, 2)}\n`);
  } finally { await client.end(); }
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

