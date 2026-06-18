"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SOURCE = "carib";
const DB_PREFIX = "carib";
const SEARCH_TEXT = "carib";
const EXCEPTION_DIR = "H:\\all\\保存\\2020.01.06\\月極\\カリビアン";
const DRIVES = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P", "Q"];
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
  if (result.status !== 0) throw new Error(`video metadata collect failed: ${result.stderr || result.stdout}`);
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
      if (config[name] === undefined) throw new Error(`Database ${name} is missing. Tried: ${keys.join(", ")} in --env-file or process environment.`);
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

function uniqueTargetPath(targetDir, fileName, reserved = new Set()) {
  const parsed = path.parse(fileName);
  let candidate = path.join(targetDir, fileName);
  let counter = 1;
  while (fs.existsSync(candidate) || reserved.has(candidate.toLowerCase())) {
    candidate = path.join(targetDir, `${parsed.name}(${counter})${parsed.ext}`);
    counter += 1;
  }
  return candidate;
}

function candidateCodes(fileName, allowRenamed = false) {
  const stem = path.parse(fileName).name;
  const lower = stem.toLowerCase();
  const hasCode = /[0-9]{6}[-_][0-9A-Za-z]{3}(?![0-9A-Za-z])/.test(stem);
  if (!lower.includes("carib") && !allowRenamed && !hasCode) return [];
  const result = [];
  const exactPrefix = allowRenamed ? stem.match(/^([0-9]{6})[-_]([0-9A-Za-z]{3})(?:_|$)/) : null;
  if (exactPrefix) result.push(`${exactPrefix[1]}-${exactPrefix[2]}`);
  for (const match of stem.matchAll(/([0-9]{6})[-_]([0-9A-Za-z]{3})(?![0-9A-Za-z])/g)) {
    result.push(`${match[1]}-${match[2]}`);
  }
  return [...new Set(result.map((item) => item.toLowerCase()))];
}

function normalizeMovieCode(value) {
  const match = String(value || "").match(/([0-9]{6})[-_]([0-9A-Za-z]{3})(?![0-9A-Za-z])/);
  return match ? `${match[1]}-${match[2]}`.toLowerCase() : "";
}

function parseExceptionDate(fileName) {
  const stem = path.parse(fileName).name;
  const patterns = [
    /^([0-9]{4})\.([0-9]{2})\.([0-9]{2})\s*(.+)$/,
    /^([0-9]{4})\.([0-9]{1,2})\.([0-9]{1,2})\s*(.+)$/,
    /^([0-9]{4})\.?\s*([0-9]{2})([0-9]{2})\s*(.+)$/,
  ];
  for (const pattern of patterns) {
    const match = stem.match(pattern);
    if (!match) continue;
    const year = match[1];
    const month = match[2].padStart(2, "0");
    const day = match[3].padStart(2, "0");
    const releaseDate = `${year}-${month}-${day}`;
    const maxDay = new Date(Number(year), Number(month), 0).getDate();
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > maxDay) continue;
    return { releaseDate, titleText: cleanName(match[4]) };
  }
  return { releaseDate: "", titleText: cleanName(stem) };
}

function normalizeForScore(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[【】\[\]（）()「」『』~〜・,、。.!！?？:：;；_\-‐‑–—―/\\|"'`´\s]/g, "");
}

function bigrams(value) {
  const text = normalizeForScore(value);
  if (text.length <= 1) return text ? [text] : [];
  const items = [];
  for (let i = 0; i < text.length - 1; i += 1) items.push(text.slice(i, i + 2));
  return items;
}

function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const item of a) counts.set(item, (counts.get(item) || 0) + 1);
  let intersection = 0;
  for (const item of b) {
    const count = counts.get(item) || 0;
    if (count > 0) {
      intersection += 1;
      counts.set(item, count - 1);
    }
  }
  return (2 * intersection) / (a.length + b.length);
}

async function fetchMasterMap(client) {
  const result = await client.query(`select movie_code, relation_key_mmddyy, to_char(release_date, 'YYYY-MM-DD') release_date_key, title, coalesce(actor_name,'') actor_name from cl.${DB_PREFIX}_m007_master`);
  const exact = new Map(result.rows.map((row) => [row.movie_code.toLowerCase(), row]));
  const relation = new Map();
  const byDate = new Map();
  for (const row of result.rows) {
    const relationItems = relation.get(row.relation_key_mmddyy) || [];
    relationItems.push(row);
    relation.set(row.relation_key_mmddyy, relationItems);
    const dateKey = row.release_date_key || "";
    if (dateKey) {
      const dateItems = byDate.get(dateKey) || [];
      dateItems.push(row);
      byDate.set(dateKey, dateItems);
    }
  }
  return { exact, relation, byDate };
}

function matchMaster(fileName, maps, allowRenamed = false) {
  const candidates = candidateCodes(fileName, allowRenamed);
  const exactMatches = [...new Map(candidates
    .map((candidate) => maps.exact.get(candidate.toLowerCase()))
    .filter(Boolean)
    .map((master) => [master.movie_code, master])).values()];
  if (exactMatches.length === 1) return { master: exactMatches[0], candidates, reason: "exact" };
  if (exactMatches.length > 1) return { master: null, candidates, reason: "multiple_exact_matches" };
  return { master: null, candidates, reason: candidates.length ? "explicit_code_not_matched" : "not_matched" };
}

function matchExceptionMaster(fileName, maps) {
  const parsed = parseExceptionDate(fileName);
  if (!parsed.releaseDate) return { master: null, releaseDate: "", titleText: parsed.titleText, score: 0, reason: "date_unreadable", candidateCount: 0, runnerUpScore: 0 };
  const candidates = maps.byDate.get(parsed.releaseDate) || [];
  if (!candidates.length) return { master: null, releaseDate: parsed.releaseDate, titleText: parsed.titleText, score: 0, reason: "date_not_matched", candidateCount: 0, runnerUpScore: 0 };
  const ranked = candidates
    .map((master) => ({
      master,
      score: similarity(parsed.titleText, `${master.title} ${master.actor_name || ""}`),
    }))
    .sort((a, b) => b.score - a.score || a.master.movie_code.localeCompare(b.master.movie_code));
  const best = ranked[0];
  const runnerUpScore = ranked[1]?.score || 0;
  if (candidates.length === 1 && best.score >= 0.25) {
    return { master: best.master, releaseDate: parsed.releaseDate, titleText: parsed.titleText, score: best.score, reason: "date_unique_title_match", candidateCount: candidates.length, runnerUpScore };
  }
  if (best.score >= 0.5 && best.score - runnerUpScore >= 0.1) {
    return { master: best.master, releaseDate: parsed.releaseDate, titleText: parsed.titleText, score: best.score, reason: "date_title_similarity", candidateCount: candidates.length, runnerUpScore };
  }
  return { master: null, releaseDate: parsed.releaseDate, titleText: parsed.titleText, score: best.score, reason: "needs_review_similarity", candidateCount: candidates.length, runnerUpScore };
}

function buildCollectPlan() {
  const rows = [];
  const plannedTargets = new Set();
  const exceptionRoot = path.resolve(EXCEPTION_DIR).toLowerCase();
  for (const drive of DRIVES) {
    const root = `${drive}:\\`;
    const targetDir = targetDirForDrive(drive);
    const inputDir = inputDirForDrive(drive);
    const trashDir = trashDirForDrive(drive);
    const scan = listFiles(
      root,
      (filePath) => isVideo(filePath) && path.basename(filePath).toLowerCase().includes(SEARCH_TEXT),
      [targetDir, inputDir, trashDir, EXCEPTION_DIR, `${drive}:\\System Volume Information`, `${drive}:\\$RECYCLE.BIN`]
    );
    for (const filePath of scan.files) {
      if (path.resolve(filePath).toLowerCase().startsWith(exceptionRoot)) continue;
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
      source_type: "normal",
      match_score: "",
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
      source_type: samePath ? "recovery" : "normal",
      match_score: "",
      error: "",
    });
    if (match.master) reservedTargets.add(targetPath.toLowerCase());
  }
  for (const error of scan.errors) rows.push({ status: "scan_error", operation: "", movie_code: "", match_reason: "", candidates: "", source_path: error.path, target_path: "", file_name: "", new_file_name: "", file_ext: "", drive_letter: drive, file_size_bytes: "", file_mtime: "", source_type: "normal", match_score: "", error: error.error });
  return rows;
}

async function buildExceptionPlan(client) {
  const maps = await fetchMasterMap(client);
  const ownedResult = await client.query(`select lower(file_path) file_path from cl.${DB_PREFIX}_owned_file`);
  const ownedPaths = new Set(ownedResult.rows.map((row) => row.file_path));
  const scan = listFiles(EXCEPTION_DIR, isVideo);
  const rows = [];
  for (const filePath of scan.files) {
    const stat = fs.statSync(filePath);
    const match = matchExceptionMaster(path.basename(filePath), maps);
    let status = match.master ? "ready_exception" : match.reason;
    if (!stat.size) status = "invalid_video_file";
    if (ownedPaths.has(path.resolve(filePath).toLowerCase())) status = "already_owned";
    rows.push({
      status,
      operation: match.master ? "register_owned_only" : "review_only",
      movie_code: match.master?.movie_code || "",
      match_reason: match.reason,
      release_date: match.releaseDate,
      title_text: match.titleText,
      master_title: match.master?.title || "",
      master_actor: match.master?.actor_name || "",
      candidate_count: match.candidateCount,
      match_score: match.score ? match.score.toFixed(4) : "",
      runner_up_score: match.runnerUpScore ? match.runnerUpScore.toFixed(4) : "",
      manual_movie_code: "",
      review_status: "",
      source_path: filePath,
      target_path: filePath,
      file_name: path.basename(filePath),
      new_file_name: "",
      file_ext: path.extname(filePath).toLowerCase().replace(/^\./, ""),
      drive_letter: driveOf(filePath),
      file_size_bytes: stat.size,
      file_mtime: stat.mtime.toISOString(),
      source_type: "exception_folder",
      error: "",
    });
  }
  for (const error of scan.errors) rows.push({ status: "scan_error", operation: "", movie_code: "", match_reason: "", release_date: "", title_text: "", manual_movie_code: "", review_status: "", source_path: error.path, target_path: "", file_name: "", new_file_name: "", file_ext: "", drive_letter: "H", file_size_bytes: "", file_mtime: "", source_type: "exception_folder", match_score: "", error: error.error });
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
    if (String(row[column] || "") !== String(expected[column] || "")) throw new Error(`Plan CSV ${column} changed for ${row.source_path}`);
  }
}

function canManuallyApproveExceptionStatus(status) {
  return ["needs_review_similarity", "date_not_matched", "date_unreadable"].includes(status);
}

async function assertMasterExists(client, movieCode) {
  const result = await client.query(`select 1 from cl.${DB_PREFIX}_m007_master where movie_code=$1`, [movieCode]);
  if (!result.rowCount) throw new Error(`Manual movie_code is not in master: ${movieCode}`);
}

async function readApprovedPlan(planCsv, mode, inputDir = "", client = null) {
  if (!planCsv) throw new Error("--plan-csv is required for apply");
  const rows = parseCsv(fs.readFileSync(path.resolve(planCsv), "utf8"));
  let expectedRows = [];
  if (mode === "collect") expectedRows = buildCollectPlan();
  else if (mode === "owned") expectedRows = await buildOwnedPlan(client, inputDir);
  else if (mode === "exception") expectedRows = await buildExceptionPlan(client);
  const expectedBySource = new Map(expectedRows.map((row) => [path.resolve(row.source_path).toLowerCase(), row]));
  const targetPaths = new Set();
  for (const row of rows) {
    const exceptionManualApproval = mode === "exception" &&
      row.review_status === "approved" &&
      normalizeMovieCode(row.manual_movie_code) &&
      canManuallyApproveExceptionStatus(row.status);
    if (!["ready", "ready_recover_owned", "ready_exception"].includes(row.status) && !exceptionManualApproval) throw new Error(`Plan CSV contains unsafe row: ${row.status}`);
    const stat = fs.statSync(row.source_path);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`Source file changed or is invalid: ${row.source_path}`);
    if (Number(row.file_size_bytes || stat.size) !== stat.size) throw new Error(`Source file size changed: ${row.source_path}`);
    if (row.file_mtime && new Date(row.file_mtime).getTime() !== stat.mtime.getTime()) throw new Error(`Source file mtime changed: ${row.source_path}`);
    const sourceDrive = driveOf(row.source_path);
    if (!DRIVES.includes(sourceDrive) || row.drive_letter !== sourceDrive) throw new Error(`Invalid drive mapping: ${row.source_path}`);
    const expected = expectedBySource.get(path.resolve(row.source_path).toLowerCase());
    if (!expected) throw new Error(`Plan row is no longer valid: ${row.source_path}`);
    if (mode === "exception") {
      const manualMovieCode = normalizeMovieCode(row.manual_movie_code);
      const manuallyApproved = row.review_status === "approved" && manualMovieCode && canManuallyApproveExceptionStatus(expected.status);
      if (manuallyApproved) {
        row.status = "ready_exception";
        row.operation = "register_owned_only";
        row.movie_code = manualMovieCode;
        row.target_path = row.source_path;
        row.source_type = "exception_folder";
        row.match_reason = `manual_approved:${expected.match_reason || row.match_reason || "review"}`;
      }
      if (row.operation !== "register_owned_only" || row.source_type !== "exception_folder") throw new Error(`Invalid exception row: ${row.source_path}`);
      if (row.status !== "ready_exception" || !row.movie_code) throw new Error(`Exception row is not approved: ${row.source_path}`);
      if (!isUnderDirectory(row.source_path, EXCEPTION_DIR) || path.resolve(row.source_path).toLowerCase() !== path.resolve(row.target_path).toLowerCase()) throw new Error(`Invalid exception paths: ${row.source_path}`);
      if (expected.status === "ready_exception") {
        assertSamePlanRow(row, expected, ["status", "operation", "movie_code", "match_reason", "release_date", "target_path", "file_name", "file_ext", "drive_letter", "file_size_bytes", "file_mtime", "source_type"]);
      } else {
        if (!manuallyApproved) throw new Error(`Exception row requires manual approval: ${row.source_path}`);
        assertSamePlanRow(row, expected, ["release_date", "target_path", "file_name", "file_ext", "drive_letter", "file_size_bytes", "file_mtime", "source_type"]);
        await assertMasterExists(client, row.movie_code);
      }
      continue;
    }
    if (row.operation !== "register_owned_only" && fs.existsSync(row.target_path)) throw new Error(`Target now exists: ${row.target_path}`);
    const targetDrive = driveOf(row.target_path);
    if (sourceDrive !== targetDrive) throw new Error(`Invalid drive mapping: ${row.source_path}`);
    const targetKey = path.resolve(row.target_path).toLowerCase();
    if (targetPaths.has(targetKey)) throw new Error(`Duplicate target in plan CSV: ${row.target_path}`);
    targetPaths.add(targetKey);
    if (mode === "collect") {
      if (row.operation !== "collect" || row.movie_code) throw new Error(`Invalid collect row: ${row.source_path}`);
      if (!isUnderDirectory(row.source_path, `${sourceDrive}:\\`) || !isUnderDirectory(row.target_path, targetDirForDrive(sourceDrive))) throw new Error(`Invalid collect paths: ${row.source_path}`);
      assertSamePlanRow(row, expected, ["status", "operation", "target_path", "file_name", "drive_letter", "file_size_bytes", "file_mtime"]);
    } else {
      if (!["rename_move_register", "register_owned_only"].includes(row.operation) || !row.movie_code) throw new Error(`Invalid owned row: ${row.source_path}`);
      const expectedInput = path.resolve(inputDirForDrive(sourceDrive));
      if (path.resolve(inputDir).toLowerCase() !== expectedInput.toLowerCase()) throw new Error(`Plan does not match input directory: ${inputDir}`);
      if (row.operation === "rename_move_register" && !isUnderDirectory(row.source_path, expectedInput) && !isUnderDirectory(row.source_path, targetDirForDrive(sourceDrive))) throw new Error(`Invalid owned source path: ${row.source_path}`);
      if (row.operation === "register_owned_only" && !isUnderDirectory(row.source_path, targetDirForDrive(sourceDrive))) throw new Error(`Invalid recovery source path: ${row.source_path}`);
      if (!isUnderDirectory(row.target_path, targetDirForDrive(sourceDrive))) throw new Error(`Invalid owned target path: ${row.target_path}`);
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
  const unsafe = rows.filter((row) => !["ready", "ready_recover_owned", "ready_exception"].includes(row.status));
  if (unsafe.length) throw new Error(`Owned import has unsafe rows: ${unsafe.length}`);
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
      await client.query(`insert into cl.${DB_PREFIX}_owned_file
        (movie_code,file_path,file_name,file_ext,drive_letter,file_size_bytes,file_mtime,source_type,match_method,match_score,original_file_name,last_seen_at,note)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),'Imported by carib-owned-operations')
        on conflict (file_path) do update set movie_code=excluded.movie_code,file_name=excluded.file_name,file_ext=excluded.file_ext,drive_letter=excluded.drive_letter,
        file_size_bytes=excluded.file_size_bytes,file_mtime=excluded.file_mtime,source_type=excluded.source_type,match_method=excluded.match_method,
        match_score=excluded.match_score,original_file_name=excluded.original_file_name,last_seen_at=now(),updated_at=now()`,
      [row.movie_code, row.target_path, path.basename(row.target_path), row.file_ext, row.drive_letter, stat.size, stat.mtime.toISOString(), row.source_type || "normal", row.match_reason || null, row.match_score || null, row.file_name || null]);
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
  return { moved, registered };
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
  const client = createPgClient();
  await client.connect();
  try {
    if (args.step === "exception-ready-plan") {
      if (!args.planCsv) throw new Error("--plan-csv is required");
      const rows = parseCsv(fs.readFileSync(path.resolve(args.planCsv), "utf8"))
        .filter((row) => row.status === "ready_exception" || (row.review_status === "approved" && normalizeMovieCode(row.manual_movie_code) && canManuallyApproveExceptionStatus(row.status)))
        .map((row) => {
          const manualMovieCode = normalizeMovieCode(row.manual_movie_code);
          if (manualMovieCode && row.status !== "ready_exception") {
            return {
              ...row,
              status: "ready_exception",
              operation: "register_owned_only",
              movie_code: manualMovieCode,
              target_path: row.source_path,
              source_type: "exception_folder",
              match_reason: `manual_approved:${row.match_reason || "review"}`,
            };
          }
          return row;
        });
      if (rows.length === 0) throw new Error("No ready exception rows in review CSV");
      for (const row of rows) {
        if (!isUnderDirectory(row.source_path, EXCEPTION_DIR)) throw new Error(`Plan row is outside exception folder: ${row.source_path}`);
      }
      const outputPath = writeCsv(rows, path.resolve(__dirname, "..", "..", "storage", "exports", SOURCE), args.step);
      process.stdout.write(`${JSON.stringify({ ok: true, step: args.step, output_path: outputPath, summary: summarize(rows), result: {} }, null, 2)}\n`);
      return;
    }
    if (args.step === "exception-review" || args.step === "exception-apply") {
      const rows = args.step === "exception-apply" ? await readApprovedPlan(args.planCsv, "exception", "", client) : await buildExceptionPlan(client);
      const outputPath = writeCsv(rows, path.resolve(__dirname, "..", "..", "storage", "exports", SOURCE), args.step);
      const result = args.step === "exception-apply" ? await applyOwned(client, rows) : {};
      if (args.step === "exception-apply" && result.registered > 0) result.video_metadata = runVideoMetadataCollect(args.envFile);
      process.stdout.write(`${JSON.stringify({ ok: true, step: args.step, output_path: outputPath, summary: summarize(rows), result }, null, 2)}\n`);
      return;
    }
    if (!args.inputDir) throw new Error("--input-dir is required");
    if (args.step === "owned-ready-plan") {
      if (!args.planCsv) throw new Error("--plan-csv is required");
      const inputDir = path.resolve(args.inputDir);
      const rows = parseCsv(fs.readFileSync(path.resolve(args.planCsv), "utf8")).filter((row) => ["ready", "ready_recover_owned"].includes(row.status));
      if (rows.length === 0) throw new Error("No ready owned rows in review CSV");
      for (const row of rows) {
        if (!isUnderDirectory(row.source_path, inputDir) && !isUnderDirectory(row.source_path, targetDirForDrive(driveOf(inputDir)))) throw new Error(`Plan row does not match input directory: ${row.source_path}`);
      }
      const outputPath = writeCsv(rows, args.inputDir, args.step);
      process.stdout.write(`${JSON.stringify({ ok: true, step: args.step, input_dir: args.inputDir, output_path: outputPath, summary: summarize(rows), result: {} }, null, 2)}\n`);
      return;
    }
    const rows = args.step === "owned-apply" ? await readApprovedPlan(args.planCsv, "owned", args.inputDir, client) : await buildOwnedPlan(client, args.inputDir);
    const outputPath = writeCsv(rows, args.inputDir, args.step);
    const result = args.step === "owned-apply" ? await applyOwned(client, rows) : {};
    if (args.step === "owned-apply" && result.registered > 0) result.video_metadata = runVideoMetadataCollect(args.envFile);
    if (!["owned-review", "owned-apply"].includes(args.step)) throw new Error(`Unsupported step: ${args.step}`);
    process.stdout.write(`${JSON.stringify({ ok: true, step: args.step, input_dir: args.inputDir, output_path: outputPath, summary: summarize(rows), result }, null, 2)}\n`);
  } finally { await client.end(); }
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
