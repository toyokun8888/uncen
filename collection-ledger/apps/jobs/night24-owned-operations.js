"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildCatalogIndex, matchOwnedFile } = require("../../packages/domain/src/night24-catalog");

const ROOT = path.resolve(__dirname, "..", "..");
const IMPORT_DIR = path.join(ROOT, "storage", "imports", "night24");
const EXPORT_DIR = path.join(ROOT, "storage", "exports", "night24");
const DEFAULT_CATALOG = path.join(IMPORT_DIR, "night24-catalog-latest.json");
const DRIVES = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P", "Q", "R", "T"];
const EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".avi", ".wmv", ".m4v", ".ts", ".m2ts", ".rmvb", ".asf", ".mpg", ".mpeg", ".webm", ".flv", ".vob", ".mts", ".3gp", ".ogv", ".divx", ".f4v", ".qt"]);
const SKIP_DIRS = new Set(["system volume information", "$recycle.bin", "recycler", "found.000", "recovery", "$winreagent", "windows", "windowsapps", "program files", "program files (x86)"]);
const COLUMNS = [
  "run_id", "status", "classification", "match_method", "confidence", "movie_code", "title",
  "detail_url", "candidate_matches", "source_code", "source_record_id", "source_path", "target_path", "file_name",
  "file_size_bytes", "file_mtime", "drive_letter", "path_marker", "filename_marker", "provider_marker",
  "move_approved", "register_owned", "note",
];

function parseArgs(argv) {
  const args = { step: "", envFile: "", inputFile: "", catalogFile: DEFAULT_CATALOG, outputFile: "", apply: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--step") args.step = argv[++i] || "";
    else if (arg.startsWith("--step=")) args.step = arg.slice(7);
    else if (arg === "--env-file") args.envFile = argv[++i] || "";
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice(11);
    else if (arg === "--input-file") args.inputFile = argv[++i] || "";
    else if (arg.startsWith("--input-file=")) args.inputFile = arg.slice(13);
    else if (arg === "--catalog-file") args.catalogFile = argv[++i] || "";
    else if (arg.startsWith("--catalog-file=")) args.catalogFile = arg.slice(15);
    else if (arg === "--output-file") args.outputFile = argv[++i] || "";
    else if (arg.startsWith("--output-file=")) args.outputFile = arg.slice(14);
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else throw new Error("unknown_argument:" + arg);
  }
  if (!args.step) throw new Error("step_required");
  args.catalogFile = path.resolve(args.catalogFile || DEFAULT_CATALOG);
  if (args.inputFile) args.inputFile = path.resolve(args.inputFile);
  if (args.outputFile) args.outputFile = path.resolve(args.outputFile);
  return args;
}

function say(value) { process.stdout.write(String(value) + "\n"); }
function id() { return new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + crypto.randomBytes(4).toString("hex"); }
function inside(value, base) {
  const target = path.resolve(value).toLowerCase();
  const root = path.resolve(base).toLowerCase();
  return target === root || target.startsWith(root + path.sep.toLowerCase());
}
function normalize(value) {
  const raw = String(value || "").trim().replace(/\//g, "\\");
  return path.win32.normalize(raw.replace(/^\\+([A-Za-z]:)/, "$1").replace(/^([A-Za-z]):(?!\\)/, "$1:\\"));
}
function driveOf(value) { return normalize(value).match(/^([A-Za-z]):\\/)?.[1].toUpperCase() || ""; }
function allowedPath(value) { return DRIVES.includes(driveOf(value)); }
function targetPath(source, unmatched = false) {
  const pathValue = normalize(source);
  const drive = driveOf(pathValue);
  if (!DRIVES.includes(drive)) throw new Error("drive_not_allowed:" + drive);
  const root = path.win32.join(drive + ":\\uncen\\night24", unmatched ? "unmatched" : "");
  return path.win32.join(root, path.win32.basename(pathValue));
}
function atNight24Target(value) {
  const normalized = normalize(value).toLowerCase();
  const drive = driveOf(value);
  const root = drive + ":\\uncen\\night24";
  return DRIVES.includes(drive) && (normalized === root || normalized.startsWith(root + "\\"));
}
function catalogIndex(file) {
  if (!inside(file, IMPORT_DIR)) throw new Error("catalog_file_outside_import_dir");
  const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(data.rows) || !Array.isArray(data.pageLogs)) throw new Error("catalog_file_invalid");
  return buildCatalogIndex(data.rows);
}

function quote(value) { return '"' + String(value === null || value === undefined ? "" : value).replace(/"/g, '""') + '"'; }
function writeCsv(file, rows, columns) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [columns.map(quote).join(",")].concat(rows.map((row) => columns.map((column) => quote(row[column])).join(","))).join("\r\n") + "\r\n", "utf8");
}
function appendJsonLine(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  try { fs.writeSync(fd, JSON.stringify(record) + "\n", null, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* Ignore only a torn final record; prior fsynced lines remain usable. */ }
  }
  return records;
}
function expectedFileAt(file, row) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size !== Number(row.file_size_bytes)) return false;
    const expected = Date.parse(row.file_mtime);
    return !Number.isFinite(expected) || Math.abs(stat.mtimeMs - expected) <= 2000;
  } catch { return false; }
}
function readCsv(text) {
  const all = [];
  let row = [];
  let field = "";
  let quoted = false;
  const value = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted && char === '"' && value[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if (char === "\n" && !quoted) {
      row.push(field.replace(/\r$/, ""));
      if (row.some((item) => item !== "")) all.push(row);
      row = []; field = "";
    } else field += char;
  }
  if (row.length || field) { row.push(field.replace(/\r$/, "")); if (row.some((item) => item !== "")) all.push(row); }
  if (!all.length) return [];
  const headers = all.shift();
  return all.map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] || ""])));
}
function loadEnv(file) {
  const candidates = [file, process.env.NIGHT24_ENV_FILE, path.join(ROOT, ".env")].filter(Boolean);
  const selected = candidates.map((value) => path.resolve(value)).find((value) => fs.existsSync(value));
  if (!selected) throw new Error("database_env_file_not_found_pass_env_file");
  for (const raw of fs.readFileSync(selected, "utf8").split(/\r?\n/)) {
    const line = raw.trim();

    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const position = line.indexOf("=");
    const key = line.slice(0, position).trim().replace(/^\uFEFF/, "");
    let value = line.slice(position + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
function envValue(...keys) { for (const key of keys) if (process.env[key]) return String(process.env[key]); return undefined; }
function pgClient() {
  const { Client } = require("pg");
  const url = envValue("DATABASE_URL", "POSTGRES_URL");
  const config = url ? { connectionString: url } : {
    host: envValue("PGHOST", "DB_HOST", "POSTGRES_HOST") || "localhost",
    port: Number(envValue("PGPORT", "DB_PORT", "POSTGRES_PORT") || 5432),
    database: envValue("PGDATABASE", "DB_NAME", "POSTGRES_DB", "POSTGRES_DATABASE", "DATABASE_NAME"),
    user: envValue("PGUSER", "DB_USER", "POSTGRES_USER", "POSTGRESQL_USER"),
    password: envValue("PGPASSWORD", "DB_PASSWORD", "POSTGRES_PASSWORD", "DATABASE_PASSWORD", "POSTGRESQL_PASSWORD"),
  };
  if (!url && (!config.database || !config.user)) throw new Error("database_settings_missing");
  return new Client(config);
}
async function withDb(args, action) {
  loadEnv(args.envFile);
  const db = pgClient();
  await db.connect();
  try { return await action(db); } finally { await db.end(); }
}

function rowFor(file, index, runId) {
  const source = normalize(file);
  const name = path.win32.basename(source);
  const match = matchOwnedFile(source, index);
  const isRip = /night[\s._-]*24[\s._-]*siterip[\s._-]*file/i.test(name);
  const classification = isRip ? "siterip_move_only" : match.status;
  if (!match.inScope && match.status !== "title_only_review" && !isRip) return null;
  const drive = driveOf(source);
  const stat = fs.statSync(source);
  const mapped = !isRip && ["exact_catalog_id", "catalog_title"].includes(match.status);
  const markedFilename = Boolean(match.filenameMarker || match.providerMarker || isRip);
  const moveApproved = mapped || markedFilename;
  return {
    run_id: runId,
    status: classification,
    classification,
    match_method: isRip ? "explicit_siterip_name" : match.matchMethod,
    confidence: isRip ? 1 : match.confidence,
    movie_code: mapped ? match.movieCode : "",
    title: mapped ? match.title : "",
    detail_url: mapped ? match.detailUrl : "",
    candidate_matches: JSON.stringify(match.candidateMatches || []),
    source_code: mapped ? match.sourceCode : "",
    source_record_id: mapped ? match.sourceRecordId : "",
    source_path: source,
    target_path: targetPath(source, !mapped),
    file_name: name,
    file_size_bytes: stat.size,
    file_mtime: stat.mtime.toISOString(),
    drive_letter: drive,
    path_marker: match.pathMarker ? "yes" : "no",
    filename_marker: match.filenameMarker ? "yes" : "no",
    provider_marker: match.providerMarker ? "yes" : "no",
    move_approved: moveApproved ? "yes" : "no",
    register_owned: mapped ? "yes" : "no",
    note: isRip ? "Legacy move-only set; do not register as an owned work or show in browser." :
      match.status === "marker_only" && match.pathMarker && !match.filenameMarker && !match.providerMarker ? "Folder name only; manual review required because this location contains mixed brands." :
      match.status === "marker_only" ? "Night24 is explicit in filename; move only and register as unmatched until identified." :
      match.status === "title_only_review" ? "Catalog-title match without a Night24 path/name; do not move or register." :
      match.status === "ambiguous_catalog_title" ? "More than one catalog work matched; manual review required." :
      (match.pathMarker && !markedFilename && !mapped) ? "Folder name alone is not enough to move; manual review required." : "",
  };
}

function walk(root, handle, errors, state) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) { errors.push({ path: current, error: String(error.message || error) }); continue; }
    state.directories++;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const next = path.win32.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) stack.push(next);
      } else if (entry.isFile() && EXTENSIONS.has(path.win32.extname(entry.name).toLowerCase())) {
        state.files++;
        try { handle(next); }
        catch (error) { errors.push({ path: next, error: String(error.message || error) }); }
      }
    }
    if (state.directories % 10000 === 0) say("Directories scanned: " + state.directories);
  }
}

async function review(args) {
  const index = catalogIndex(args.catalogFile);
  const runId = id();
  const output = path.resolve(args.outputFile || path.join(EXPORT_DIR, "night24-owned-review-" + runId + ".csv"));
  if (!inside(output, EXPORT_DIR)) throw new Error("review_output_outside_night24_export_dir");
  const rows = [];
  const errors = [];
  const state = { directories: 0, files: 0 };
  const roots = DRIVES.map((drive) => drive + ":\\").filter((root) => fs.existsSync(root));
  for (const root of roots) {
    say("Scanning " + root);
    walk(root, (file) => {
      const row = rowFor(file, index, runId);
      if (row) rows.push(row);
    }, errors, state);
  }
  writeCsv(output, rows, COLUMNS);
  const counts = rows.reduce((result, row) => { result[row.classification] = (result[row.classification] || 0) + 1; return result; }, {});
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(EXPORT_DIR, "night24-owned-review-" + runId + "-scan.json"), JSON.stringify({
    runId, includedDrives: DRIVES, excludedDrives: ["S"], directories: state.directories, videoFiles: state.files,
    candidates: rows.length, counts, scanErrors: errors,
  }, null, 2) + "\n", "utf8");

  say("Scanned " + state.files + " video files; candidate rows=" + rows.length + "; scan errors=" + errors.length);
  say("Counts: " + JSON.stringify(counts));
  say("Review CSV: " + output);
}

function stableFile(file, row) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size !== Number(row.file_size_bytes)) return false;
  const expected = Date.parse(row.file_mtime);
  if (Number.isFinite(expected) && Math.abs(stat.mtimeMs - expected) > 2000) return false;
  return Date.now() - stat.mtimeMs >= 10 * 60 * 1000;
}

async function apply(args) {
  const input = path.resolve(args.inputFile);
  if (!inside(input, EXPORT_DIR) || path.extname(input).toLowerCase() !== ".csv") throw new Error("input_must_be_night24_review_csv");
  const rows = readCsv(fs.readFileSync(input, "utf8"));
  if (!rows.length) throw new Error("review_csv_empty");
  const output = path.join(EXPORT_DIR, path.basename(input, ".csv") + ".apply-results.csv");
  const prior = fs.existsSync(output) ? readCsv(fs.readFileSync(output, "utf8")) : [];
  const recovered = new Set(prior.filter((row) => ["moved_pending_db", "registered", "unmatched_registered", "moved_only"].includes(row.status))
    .map((row) => normalize(row.source_path).toLowerCase() + "=>" + normalize(row.target_path).toLowerCase()));
  const journalPath = output + ".move-journal.jsonl";
  const journal = readJsonLines(journalPath);
  const durableIntents = new Map();
  for (const record of journal) {
    if (record.event !== "move_intent") continue;
    const key = normalize(record.source_path).toLowerCase() + "=>" + normalize(record.target_path).toLowerCase();
    durableIntents.set(key, record);
  }
  const runId = rows[0].run_id || id();
  const approved = rows.filter((row) => String(row.move_approved).toLowerCase() === "yes" || String(row.register_owned).toLowerCase() === "yes");
  if (!approved.length) throw new Error("no_approved_rows");
  const registered = new Set();
  if (args.apply) {
    await withDb(args, async (db) => {
      const result = await db.query("select lower(file_path) as file_path from cl.night24_tm002_owned_files");
      for (const row of result.rows) registered.add(row.file_path);
    });
  }
  const outcomes = [];
  for (const row of approved) {
    const source = normalize(row.source_path);
    const destination = targetPath(source, row.register_owned !== "yes");
    const requested = normalize(row.target_path);
    let status = "planned";
    let note = "";
    if (!allowedPath(source) || driveOf(source) === "S") { status = "blocked_path_or_drive"; note = "Only the local D/E/F/G/H/I/J/K/L/N/P/Q/R/T drives are allowed."; }
    else if (!EXTENSIONS.has(path.win32.extname(source).toLowerCase())) { status = "blocked_extension"; note = "Unsupported video extension."; }
    else if (requested.toLowerCase() !== destination.toLowerCase()) { status = "blocked_target_mismatch"; note = "Target must preserve the original name under same-drive uncen/night24."; }
    else if (row.register_owned === "yes" && ["marker_only", "siterip_move_only"].includes(row.classification)) { status = "blocked_unmatched_owned"; note = "Unmatched and legacy siterip rows cannot be registered as owned."; }
    else if (row.register_owned === "yes" && !/^n24-[0-9a-f]{20}$/.test(row.movie_code || "")) { status = "blocked_missing_movie_code"; note = "Mapped movie code is required."; }
    else if (row.register_owned === "yes" && !["exact_catalog_id", "catalog_title", "manual_confirmed"].includes(row.classification)) { status = "blocked_match_class"; note = "Use an exact ID, unique title, or manually verified CSV match."; }
    else if (registered.has(destination.toLowerCase())) status = "already_registered";
    else {
      const same = source.toLowerCase() === destination.toLowerCase();
      const recoveryKey = source.toLowerCase() + "=>" + destination.toLowerCase();
      if (same && fs.existsSync(source)) status = stableFile(source, row) ? "ready_at_target" : "file_changed_or_recent";
      else if ((recovered.has(recoveryKey) || durableIntents.has(recoveryKey)) && !fs.existsSync(source) && expectedFileAt(destination, row)) status = "ready_after_prior_move";
      else if (!fs.existsSync(source)) { status = "source_missing"; note = "No successful prior move is recorded."; }
      else if (!stableFile(source, row)) { status = "file_changed_or_recent"; note = "File changed since scan or is recent."; }
      else if (fs.existsSync(destination)) { status = "destination_collision"; note = "Destination exists; no overwrite or rename."; }
      else status = args.apply ? "move_ready" : "planned";
    }
    const outcome = { ...row, status, note, applied_at: args.apply ? new Date().toISOString() : "" };
    if (args.apply && ["move_ready", "ready_at_target", "ready_after_prior_move"].includes(status)) {
      try {
        if (status === "move_ready") {
          fs.mkdirSync(path.win32.dirname(destination), { recursive: true });
          if (fs.existsSync(destination)) throw new Error("destination_collision_before_move");
          const sourceStat = fs.statSync(source);
          if (!stableFile(source, row)) throw new Error("source_changed_before_move");
          const intent = {
            event: "move_intent", run_id: runId, source_path: source, target_path: destination,
            file_size_bytes: sourceStat.size, file_mtime: sourceStat.mtime.toISOString(),
            source_dev: String(sourceStat.dev), source_ino: String(sourceStat.ino), created_at: new Date().toISOString(),
          };
          appendJsonLine(journalPath, intent);
          fs.renameSync(source, destination);
          if (!expectedFileAt(destination, row)) throw new Error("move_postcheck_failed");
          const targetStat = fs.statSync(destination);
          appendJsonLine(journalPath, { ...intent, event: "move_completed", completed_at: new Date().toISOString(), target_dev: String(targetStat.dev), target_ino: String(targetStat.ino) });
          outcome.status = "moved_pending_db";
        } else if (status === "ready_at_target") outcome.status = "moved_pending_db";
        outcome.target_path = destination;
      } catch (error) { outcome.status = "move_failed"; outcome.note = String(error.message || error); }
    }
    outcomes.push(outcome);
    writeCsv(output, outcomes, COLUMNS.concat(["applied_at"]));
  }
  if (!args.apply) {
    say("DRY-RUN: " + approved.length + " approved CSV rows; no files or DB records changed.");
    say("Plan: " + output);
    return;
  }

  const ready = outcomes.filter((row) => ["moved_pending_db", "ready_after_prior_move"].includes(row.status));
  try {
    await withDb(args, async (db) => {
      await db.query("begin");
      try {
        for (const row of ready) {
          const source = normalize(row.source_path);
          const destination = normalize(row.target_path);
          const stat = fs.statSync(destination);
          if (row.register_owned === "yes") {
            const master = await db.query("select movie_code from cl.night24_tm001_master where movie_code=$1", [row.movie_code]);
            if (master.rowCount !== 1) throw new Error("movie_code_missing_from_master:" + row.movie_code);
            const owned = await db.query(

              "insert into cl.night24_tm002_owned_files (movie_code,file_path,original_file_path,file_name,file_ext,drive_letter,file_size_bytes,file_mtime,source_type,match_method,match_score,original_file_name,last_seen_at,note,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,'normal',$9,$10,$4,now(),'night24 manual ownership registration',now()) on conflict (file_path) do update set movie_code=excluded.movie_code,file_size_bytes=excluded.file_size_bytes,file_mtime=excluded.file_mtime,match_method=excluded.match_method,match_score=excluded.match_score,last_seen_at=now(),updated_at=now() returning owned_file_id",
              [row.movie_code, destination, source, path.win32.basename(destination), path.win32.extname(destination).slice(1).toLowerCase(), driveOf(destination), stat.size, stat.mtime.toISOString(), (row.classification === "manual_confirmed" ? "manual_user_match" : row.match_method), Number(row.confidence)]
            );
            if (owned.rowCount !== 1) throw new Error("owned_file_upsert_failed:" + destination);
            await db.query(
              "insert into cl.night24_tm011_owned_file_video_metadata (owned_file_id,movie_code,file_path,file_name,file_size_bytes,file_mtime,probe_status,updated_at) select owned_file_id,movie_code,file_path,file_name,file_size_bytes,file_mtime,'pending',now() from cl.night24_tm002_owned_files where file_path=$1 on conflict (owned_file_id) do update set movie_code=excluded.movie_code,file_path=excluded.file_path,file_name=excluded.file_name,file_size_bytes=excluded.file_size_bytes,file_mtime=excluded.file_mtime,updated_at=now()",
              [destination]
            );
            row.status = "registered";
            await db.query("update cl.night24_tm005_unmatched_files set status='resolved',updated_at=now() where lower(current_path)=any($1::text[])", [[destination.toLowerCase(), source.toLowerCase()]]);
          } else if (["marker_only", "ambiguous_catalog_title", "title_only_review", "siterip_move_only"].includes(row.classification)) {
            await db.query(
              "insert into cl.night24_tm005_unmatched_files (run_id,detected_path,current_path,detected_file_name,current_file_name,extracted_source_record_id,reason,status,source,file_size_bytes,file_mtime,note,updated_at) values ($1,$2,$3,$4,$4,nullif($5,''),$6,'review_required','night24_manual',$7,$8,$9,now()) on conflict (current_path) do update set run_id=excluded.run_id,file_size_bytes=excluded.file_size_bytes,file_mtime=excluded.file_mtime,updated_at=now()",
              [runId, source, destination, path.win32.basename(destination), row.source_record_id || "", row.match_method || "site_marker", stat.size, stat.mtime.toISOString(), row.note || ("No unique catalog identity. Candidates: " + (row.candidate_matches || "[]"))]
            );
            row.status = "unmatched_registered";
          } else row.status = "moved_only";
          await db.query(
            "insert into cl.night24_tl001_file_process_logs (run_id,movie_code,old_path,new_path,old_file_name,new_file_name,action,status,source,matched_by,note) values ($1,nullif($2,''),$3,$4,$5,$6,$7,$8,'night24_manual',$9,$10)",
            [runId, row.movie_code || "", source, destination, path.win32.basename(source), path.win32.basename(destination), row.classification === "siterip_move_only" ? "move_only" : (source.toLowerCase() === destination.toLowerCase() ? "register_owned_file" : "move_file"), row.status, row.match_method || "", row.note || ""]
          );
        }
        await db.query("commit");
      } catch (error) { await db.query("rollback"); throw error; }
    });
  } catch (error) {
    for (const row of outcomes) {
      if (ready.includes(row)) {
        row.status = "moved_pending_db";
        row.note = "File is at target; DB registration pending. Rerun the same CSV to resume. " + String(error.message || error);
      }
    }
    writeCsv(output, outcomes, COLUMNS.concat(["applied_at"]));
    throw error;
  }
  writeCsv(output, outcomes, COLUMNS.concat(["applied_at"]));
  say("Processed " + outcomes.length + " approved rows; results: " + output);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.step === "owned-review") await review(args);
  else if (args.step === "owned-apply") await apply(args);
  else throw new Error("unsupported_step:" + args.step);
}
main().catch((error) => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });









