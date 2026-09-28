"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const EXPORT_DIR = path.join(ROOT, "storage", "exports", "night24");
const DRIVES = new Set(["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P", "Q", "R", "T"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".avi", ".wmv", ".m4v", ".ts", ".m2ts", ".rmvb", ".asf", ".mpg", ".mpeg", ".webm", ".flv", ".vob", ".mts", ".3gp", ".ogv", ".divx", ".f4v", ".qt"]);
const EXPECTED_COUNTS = { marker_only: 149, siterip_move_only: 81 };

function parseArgs(argv) {
  const args = { inputFile: "", envFile: "", outputFile: "", apply: false };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--input-file") args.inputFile = argv[++index] || "";
    else if (arg.startsWith("--input-file=")) args.inputFile = arg.slice(13);
    else if (arg === "--env-file") args.envFile = argv[++index] || "";
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice(11);
    else if (arg === "--output-file") args.outputFile = argv[++index] || "";
    else if (arg.startsWith("--output-file=")) args.outputFile = arg.slice(14);
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else throw new Error("unknown_argument:" + arg);
  }
  if (!args.inputFile) throw new Error("input_file_required");
  args.inputFile = path.resolve(args.inputFile);
  if (args.envFile) args.envFile = path.resolve(args.envFile);
  if (args.outputFile) args.outputFile = path.resolve(args.outputFile);
  return args;
}

function inside(value, base) {
  const target = path.resolve(value).toLowerCase();
  const root = path.resolve(base).toLowerCase();
  return target === root || target.startsWith(root + path.sep.toLowerCase());
}
function normalize(value) {
  const raw = String(value || "").trim().replace(/\//g, "\\");
  return path.win32.normalize(raw.replace(/^\\+([A-Za-z]:)/, "$1").replace(/^([A-Za-z]):(?!\\)/, "$1:\\"));
}
function driveOf(value) {
  return normalize(value).match(/^([A-Za-z]):\\/)?.[1].toUpperCase() || "";
}
function expectedAt(file, row) {
  try {
    const stat = fs.statSync(file);
    const expectedMtime = Date.parse(row.file_mtime);
    return stat.isFile() &&
      stat.size === Number(row.file_size_bytes) &&
      Number.isFinite(expectedMtime) &&
      Math.abs(stat.mtimeMs - expectedMtime) <= 2000;
  } catch {
    return false;
  }
}
function quote(value) {
  return "\"" + String(value === null || value === undefined ? "" : value).replace(/"/g, "\"\"") + "\"";
}
function writeCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const columns = ["run_id", "classification", "status", "drive_letter", "source_path", "target_path", "file_name", "file_size_bytes", "file_mtime", "note"];
  fs.writeFileSync(file, [columns.map(quote).join(",")].concat(rows.map((row) => columns.map((column) => quote(row[column])).join(","))).join("\r\n") + "\r\n", "utf8");
}
function readCsv(text) {
  const all = [];
  let row = [];
  let field = "";
  let quoted = false;
  const value = String(text).replace(/^\uFEFF/, "");
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted && char === "\"" && value[index + 1] === "\"") { field += "\""; index++; }
    else if (char === "\"") quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if (char === "\n" && !quoted) {
      row.push(field.replace(/\r$/, ""));
      if (row.some((item) => item !== "")) all.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (row.length || field) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((item) => item !== "")) all.push(row);
  }
  if (!all.length) return [];
  const headers = all.shift();
  return all.map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] || ""])));
}
function appendJsonLine(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, "a");
  try {
    fs.writeSync(descriptor, JSON.stringify(record) + "\n", null, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
function loadEnv(file) {
  const candidates = [file, process.env.NIGHT24_ENV_FILE, path.join(ROOT, ".env")].filter(Boolean);
  const selected = candidates.map((value) => path.resolve(value)).find((value) => fs.existsSync(value));
  if (!selected) throw new Error("database_env_file_not_found_pass_env_file");
  for (const raw of fs.readFileSync(selected, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const split = line.indexOf("=");
    const key = line.slice(0, split).trim().replace(/^\uFEFF/, "");
    let value = line.slice(split + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
function envValue(...keys) {
  for (const key of keys) if (process.env[key]) return String(process.env[key]);
  return undefined;
}
function makeDbClient() {
  const { Client } = require("pg");
  const url = envValue("DATABASE_URL", "POSTGRES_URL");
  if (url) return new Client({ connectionString: url });
  return new Client({
    host: envValue("PGHOST", "DB_HOST", "POSTGRES_HOST") || "localhost",
    port: Number(envValue("PGPORT", "DB_PORT", "POSTGRES_PORT") || 5432),
    database: envValue("PGDATABASE", "DB_NAME", "POSTGRES_DB", "POSTGRES_DATABASE", "DATABASE_NAME"),
    user: envValue("PGUSER", "DB_USER", "POSTGRES_USER", "POSTGRESQL_USER"),
    password: envValue("PGPASSWORD", "DB_PASSWORD", "POSTGRES_PASSWORD", "DATABASE_PASSWORD", "POSTGRESQL_PASSWORD"),
  });
}
function buildPlan(args, journal) {
  if (!inside(args.inputFile, EXPORT_DIR) || path.extname(args.inputFile).toLowerCase() !== ".csv") {
    throw new Error("input_must_be_night24_export_csv");
  }
  const inputRows = readCsv(fs.readFileSync(args.inputFile, "utf8"));
  const selected = inputRows.filter((row) => Object.hasOwn(EXPECTED_COUNTS, row.classification));
  const counts = { marker_only: 0, siterip_move_only: 0 };
  for (const row of selected) counts[row.classification]++;
  if (counts.marker_only !== EXPECTED_COUNTS.marker_only || counts.siterip_move_only !== EXPECTED_COUNTS.siterip_move_only) {
    throw new Error("unexpected_scope_counts:" + JSON.stringify(counts));
  }

  const seenSources = new Set();
  const seenTargets = new Set();
  const plan = selected.map((row) => {
    const source = normalize(row.target_path);
    const drive = driveOf(source);
    const root = drive + ":\\uncen\\night24";
    if (!DRIVES.has(drive) || drive === "S") throw new Error("blocked_drive:" + drive);
    if (String(row.move_approved).toLowerCase() !== "yes") throw new Error("row_not_move_approved:" + source);
    if (String(row.register_owned).toLowerCase() !== "no") throw new Error("unmatched_row_marked_owned:" + source);
    if (path.win32.dirname(source).toLowerCase() !== root.toLowerCase()) throw new Error("source_not_directly_under_night24_root:" + source);
    if (!VIDEO_EXTENSIONS.has(path.win32.extname(source).toLowerCase())) throw new Error("blocked_extension:" + source);

    const target = normalize(path.win32.join(root, "unmatched", path.win32.basename(source)));
    if (driveOf(target) !== drive) throw new Error("cross_drive_move_blocked:" + source);
    if (path.win32.basename(source) !== path.win32.basename(target)) throw new Error("rename_blocked:" + source);
    if (seenSources.has(source.toLowerCase()) || seenTargets.has(target.toLowerCase())) throw new Error("duplicate_plan_path:" + source);
    seenSources.add(source.toLowerCase());
    seenTargets.add(target.toLowerCase());

    const journalled = journal.some((record) =>
      record.event === "move_intent" &&
      normalize(record.source_path).toLowerCase() === source.toLowerCase() &&
      normalize(record.target_path).toLowerCase() === target.toLowerCase() &&
      Number(record.file_size_bytes) === Number(row.file_size_bytes) &&
      Math.abs(Date.parse(record.file_mtime) - Date.parse(row.file_mtime)) <= 2000
    );
    const sourceExists = fs.existsSync(source);
    const targetExists = fs.existsSync(target);
    let status = "planned";
    let note = "";
    if (sourceExists && targetExists) throw new Error("source_and_target_both_exist:" + source);
    if (sourceExists) {
      if (!expectedAt(source, row)) throw new Error("source_metadata_changed:" + source);
      const stat = fs.statSync(source);
      if (Date.now() - stat.mtimeMs < 10 * 60 * 1000) throw new Error("file_recently_changed:" + source);
      if (targetExists) throw new Error("destination_collision:" + target);
    } else if (targetExists && journalled && expectedAt(target, row)) {
      status = "already_moved";
      note = "Prior durable move intent verified; resume DB reconciliation.";
    } else {
      throw new Error("source_missing_or_unjournalled_destination:" + source);
    }

    return {
      run_id: "",
      classification: row.classification,
      status,
      drive_letter: drive,
      source_path: source,
      target_path: target,
      file_name: path.win32.basename(source),
      file_size_bytes: Number(row.file_size_bytes),
      file_mtime: row.file_mtime,
      note,
      detected_path: normalize(row.source_path || source),
    };
  });
  return plan;
}
async function validateDb(db, plan) {
  const sources = plan.map((row) => row.source_path.toLowerCase());
  const targets = plan.map((row) => row.target_path.toLowerCase());
  const allPaths = sources.concat(targets);

  const owned = await db.query(
    "select lower(file_path) as file_path from cl.night24_tm002_owned_files where lower(file_path)=any($1::text[])",
    [allPaths]
  );
  if (owned.rowCount) throw new Error("unmatched_plan_contains_owned_file:" + owned.rows[0].file_path);

  const unmatched = await db.query(
    "select unmatched_file_id,lower(current_path) as current_path,status,reason from cl.night24_tm005_unmatched_files where lower(current_path)=any($1::text[])",
    [allPaths]
  );
  const unmatchedByPath = new Map(unmatched.rows.map((row) => [row.current_path, row]));
  for (const row of plan) {
    const source = row.source_path.toLowerCase();
    const target = row.target_path.toLowerCase();
    const atSource = unmatchedByPath.get(source);
    const atTarget = unmatchedByPath.get(target);
    if (row.classification === "marker_only") {
      if (atSource && atTarget) throw new Error("duplicate_unmatched_db_paths:" + row.source_path);
      const existing = atSource || atTarget;
      if (!existing || existing.status !== "review_required") throw new Error("marker_unmatched_db_row_not_reviewable:" + row.source_path);
    } else {
      if (atSource) throw new Error("legacy_source_already_in_unmatched_db:" + row.source_path);
      if (atTarget && (atTarget.status !== "review_required" || atTarget.reason !== "legacy_siterip_move_only")) {
        throw new Error("legacy_target_unmatched_db_conflict:" + row.target_path);
      }
    }
  }

  const legacySources = plan.filter((row) => row.classification === "siterip_move_only").map((row) => row.source_path.toLowerCase());
  const legacyLogs = await db.query(
    "select distinct lower(new_path) as new_path from cl.night24_tl001_file_process_logs where action='move_only' and status='moved_only' and matched_by='explicit_siterip_name' and lower(new_path)=any($1::text[])",
    [legacySources]
  );
  const logged = new Set(legacyLogs.rows.map((row) => row.new_path));
  for (const source of legacySources) if (!logged.has(source)) throw new Error("legacy_move_log_missing:" + source);
}
async function withDb(args, action) {
  loadEnv(args.envFile);
  const db = makeDbClient();
  await db.connect();
  try { return await action(db); } finally { await db.end(); }
}
function reportFile(args) {
  const hash = crypto.createHash("sha256").update(path.basename(args.inputFile).toLowerCase()).digest("hex").slice(0, 12);
  const output = args.outputFile || path.join(EXPORT_DIR, "night24-unmatched-reorganization-" + hash + ".csv");
  if (!inside(output, EXPORT_DIR) || path.extname(output).toLowerCase() !== ".csv") throw new Error("output_must_be_night24_export_csv");
  return { output, journal: path.join(EXPORT_DIR, "night24-unmatched-reorganization-" + hash + ".jsonl"), runId: "n24-unmatched-" + hash };
}
async function applyPlan(args, plan, output, journalFile, runId) {
  for (const row of plan) {
    row.run_id = runId;
    if (row.status === "already_moved") continue;
    try {
      const stat = fs.statSync(row.source_path);
      if (fs.existsSync(row.target_path)) throw new Error("destination_collision_before_move");
      if (stat.size !== Number(row.file_size_bytes) || Math.abs(stat.mtimeMs - Date.parse(row.file_mtime)) > 2000) {
        throw new Error("source_changed_before_move");
      }
      fs.mkdirSync(path.dirname(row.target_path), { recursive: true });
      appendJsonLine(journalFile, {
        event: "move_intent",
        run_id: runId,
        source_path: row.source_path,
        target_path: row.target_path,
        file_size_bytes: stat.size,
        file_mtime: stat.mtime.toISOString(),
        created_at: new Date().toISOString(),
      });
      fs.renameSync(row.source_path, row.target_path);
      if (!expectedAt(row.target_path, row)) throw new Error("move_postcheck_failed");
      appendJsonLine(journalFile, {
        event: "move_completed",
        run_id: runId,
        source_path: row.source_path,
        target_path: row.target_path,
        file_size_bytes: stat.size,
        file_mtime: stat.mtime.toISOString(),
        completed_at: new Date().toISOString(),
      });
      row.status = "moved";
      row.note = "";
      writeCsv(output, plan);
    } catch (error) {
      row.status = "move_failed";
      row.note = String(error.message || error);
      writeCsv(output, plan);
      throw error;
    }
  }

  try {
    await withDb(args, async (db) => {
      await validateDb(db, plan);
      await db.query("begin");
      try {
      for (const row of plan) {
        if (row.classification === "marker_only") {
          const oldPath = row.source_path;
          const newPath = row.target_path;
          const oldRow = await db.query(
            "select unmatched_file_id,status from cl.night24_tm005_unmatched_files where lower(current_path)=lower($1)",
            [oldPath]
          );
          if (oldRow.rowCount === 1) {
            if (oldRow.rows[0].status !== "review_required") throw new Error("marker_status_changed:" + oldPath);
            const updated = await db.query(
              "update cl.night24_tm005_unmatched_files set current_path=$2,current_file_name=$3,updated_at=now() where unmatched_file_id=$1 and status='review_required' returning unmatched_file_id",
              [oldRow.rows[0].unmatched_file_id, newPath, row.file_name]
            );
            if (updated.rowCount !== 1) throw new Error("marker_path_update_failed:" + oldPath);
          } else {
            const newRow = await db.query(
              "select unmatched_file_id,status from cl.night24_tm005_unmatched_files where lower(current_path)=lower($1)",
              [newPath]
            );
            if (newRow.rowCount !== 1 || newRow.rows[0].status !== "review_required") throw new Error("marker_path_recovery_failed:" + newPath);
          }
        } else {
          const newRow = await db.query(
            "select unmatched_file_id,status,reason from cl.night24_tm005_unmatched_files where lower(current_path)=lower($1)",
            [row.target_path]
          );
          if (newRow.rowCount === 0) {
            await db.query(
              "insert into cl.night24_tm005_unmatched_files (run_id,detected_path,current_path,detected_file_name,current_file_name,extracted_source_record_id,reason,status,source,file_size_bytes,file_mtime,note,updated_at) values ($1,$2,$3,$4,$4,null,'legacy_siterip_move_only','review_required','night24_unmatched_reorganization',$5,$6,$7,now())",
              [runId, row.detected_path, row.target_path, row.file_name, row.file_size_bytes, row.file_mtime, "Legacy siterip file kept unmatched; do not register as owned or show in browser."]
            );
          } else if (newRow.rowCount !== 1 || newRow.rows[0].status !== "review_required" || newRow.rows[0].reason !== "legacy_siterip_move_only") {
            throw new Error("legacy_unmatched_row_conflict:" + row.target_path);
          }
        }

        await db.query(
          "insert into cl.night24_tl001_file_process_logs (run_id,owned_file_id,movie_code,old_path,new_path,old_file_name,new_file_name,action,status,source,matched_by,note) select $1,null,null,$2,$3,$4,$4,'move_to_unmatched','unmatched_registered','night24_unmatched_reorganization',$5,$6 where not exists (select 1 from cl.night24_tl001_file_process_logs where run_id=$1 and lower(old_path)=lower($2) and lower(new_path)=lower($3) and action='move_to_unmatched')",
          [runId, row.source_path, row.target_path, row.file_name, row.classification, "Same-drive organization; original filename preserved; not registered as owned."]
        );
      }
        await db.query("commit");
      } catch (error) {
        await db.query("rollback");
        throw error;
      }
    });
  } catch (error) {
    for (const row of plan) {
      row.run_id = runId;
      if (row.status === "moved" || row.status === "already_moved") {
        row.status = "moved_db_pending";
        row.note = String(error.message || error);
      }
    }
    writeCsv(output, plan);
    throw error;
  }

  for (const row of plan) {
    row.run_id = runId;
    row.status = "unmatched_registered";
    row.note = "";
  }
  writeCsv(output, plan);
}
async function main() {
  const args = parseArgs(process.argv);
  const reports = reportFile(args);
  const journal = readJsonLines(reports.journal);
  const plan = buildPlan(args, journal);
  await withDb(args, async (db) => validateDb(db, plan));
  for (const row of plan) row.run_id = reports.runId;
  writeCsv(reports.output, plan);
  const byDrive = {};
  for (const row of plan) byDrive[row.drive_letter] = (byDrive[row.drive_letter] || 0) + 1;
  process.stdout.write(JSON.stringify({
    mode: args.apply ? "apply" : "dry-run",
    files: plan.length,
    classes: EXPECTED_COUNTS,
    byDrive,
    statuses: plan.reduce((result, row) => { result[row.status] = (result[row.status] || 0) + 1; return result; }, {}),
    report: reports.output,
    journal: reports.journal,
  }) + "\n");
  if (!args.apply) {
    process.stdout.write("DRY-RUN: no media files or DB records changed.\n");
    return;
  }
  await applyPlan(args, plan, reports.output, reports.journal, reports.runId);
  process.stdout.write("APPLY: file moves and unmatched DB reconciliation completed.\n");
}
main().catch((error) => {
  process.stderr.write(String(error.stack || error) + "\n");
  process.exitCode = 1;
});
