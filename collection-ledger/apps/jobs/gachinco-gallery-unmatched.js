"use strict";

// Finish the four previously unmatched N: videos whose 4037 work pages returned 404.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");
const { titleActor } = require("../../packages/domain/src/gachinco-performers");

const ROOT = path.resolve(__dirname, "../..");
const GALLERY_REVIEW = path.join(ROOT, "storage/exports/gachinco/gachinco-gallery-review.json");
const REPORT = path.join(ROOT, "storage/exports/gachinco/gachinco-gallery-unmatched-applied.json");
const CSV = REPORT.replace(/\.json$/, ".csv");
const JOURNAL = REPORT.replace(/\.json$/, ".jsonl");
const NUMBERS = new Set([356, 418, 449]);
const SOURCE_ROOT = "N:\\uncen\\gachinco\\unmatched";
const TARGET_ROOT = "N:\\uncen\\gachinco";

function fileStable(file, row) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.statSync(file);
  return stat.isFile() && String(stat.size) === String(row.file_size_bytes) && stat.mtime.toISOString() === new Date(row.file_mtime).toISOString();
}
function under(file, root) { return path.win32.normalize(file).toLowerCase().startsWith(path.win32.normalize(root).toLowerCase() + "\\"); }
function csvCell(value) { const cell = String(value ?? ""); return /[",\r\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell; }
function writeReport(runId, outcomes) {
  fs.writeFileSync(REPORT, JSON.stringify({ runId, outcomes }, null, 2) + "\n");
  const columns = ["number", "source", "target", "movieCode", "status"];
  fs.writeFileSync(CSV, "\uFEFF" + [columns, ...outcomes.map((row) => columns.map((column) => row[column]))].map((values) => values.map(csvCell).join(",")).join("\r\n") + "\r\n", "utf8");
}
async function dbConnection() {
  require("dotenv").config({ path: process.env.GACHINCO_ENV_FILE || "C:/Users/toyoaki/Desktop/filedatachange/.env", quiet: true });
  const db = new Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD });
  await db.connect();
  return db;
}
async function registeredPaths(db, paths) {
  const tables = await db.query(`select n.nspname as schema_name,c.relname as table_name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attname='file_path' and not a.attisdropped
    where c.relkind in ('r','p','v','m','f') and n.nspname not in ('pg_catalog','information_schema')`);
  const sql = tables.rows.map((row) => `select file_path::text as file_path from "${row.schema_name}"."${row.table_name}" where file_path is not null`).join(" union all ");
  const query = `select distinct lower(replace(file_path,'/',E'\\\\')) as file_path from (${sql}) all_files where lower(replace(file_path,'/',E'\\\\'))=any($1::text[])`;
  return new Set((await db.query(query, [paths.map((item) => path.win32.normalize(item).toLowerCase())])).rows.map((row) => row.file_path));
}

async function main() {
  const review = JSON.parse(fs.readFileSync(GALLERY_REVIEW, "utf8"));
  const matches = new Map(review.filter((row) => NUMBERS.has(row.number) && row.candidates.length === 1).map((row) => [row.number, row]));
  if (matches.size !== NUMBERS.size) throw new Error("gallery_4037_match_missing_or_ambiguous");
  const db = await dbConnection();
  const runId = "gallery-unmatched-" + new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + crypto.randomBytes(3).toString("hex");
  const outcomes = [];
  try {
    const pending = await db.query("select unmatched_file_id,detected_path,current_path,detected_file_name,status,extracted_source_record_id,file_size_bytes,file_mtime from cl.gachinco_tm005_unmatched_files where extracted_source_record_id=any($1::text[]) and status='review_required' order by unmatched_file_id", [[...NUMBERS].map((number) => `4037-${number}`)]);
    if (pending.rowCount !== 4) throw new Error(`expected_four_unmatched_found:${pending.rowCount}`);
    for (const row of pending.rows) {
      const number = Number(/^4037-(\d+)$/.exec(row.extracted_source_record_id)?.[1]);
      const match = matches.get(number);
      const source = row.current_path;
      const target = path.win32.join(TARGET_ROOT, path.win32.basename(source));
      if (!match || !under(source, SOURCE_ROOT) || !under(target, TARGET_ROOT) || path.win32.basename(source) !== row.detected_file_name || !new RegExp(`^Heydouga4037-${number}(?:-\\d+)?\\.4K\\.mp4$`, "i").test(row.detected_file_name)) throw new Error(`unmatched_path_or_number_invalid:${row.unmatched_file_id}`);
      if (!fileStable(source, row) || fs.existsSync(target)) throw new Error(`source_changed_or_target_collision:${source}`);
      const protectedPaths = await registeredPaths(db, [source, target]);
      if (protectedPaths.size) throw new Error(`registered_path_protected:${[...protectedPaths].join("|")}`);
      const master = await db.query("select movie_code from cl.gachinco_tm001_master where movie_code=$1", [match.candidates[0].movieCode]);
      const gallery = await db.query("select movie_code from cl.gachinco_tm003_master_source_records where source_code='gallery' and source_record_id=$1", [`4037-${number}`]);
      if (master.rowCount !== 1 || gallery.rowCount !== 1 || gallery.rows[0].movie_code !== master.rows[0].movie_code) throw new Error(`catalog_mapping_changed:${number}`);
      let moved = false;
      let registered = false;
      try {
        await db.query("begin");
        const locked = await db.query("select status,current_path from cl.gachinco_tm005_unmatched_files where unmatched_file_id=$1 for update", [row.unmatched_file_id]);
        if (locked.rowCount !== 1 || locked.rows[0].status !== "review_required" || locked.rows[0].current_path !== source) throw new Error(`unmatched_record_changed:${number}`);
        const lastRegistered = await registeredPaths(db, [source, target]);
        if (lastRegistered.size || !fileStable(source, row) || fs.existsSync(target)) throw new Error(`file_or_registry_changed_before_move:${number}`);
        fs.appendFileSync(JOURNAL, JSON.stringify({ runId, event: "move_intent", source, target, number }) + "\n");
        fs.renameSync(source, target);
        moved = true;
        fs.appendFileSync(JOURNAL, JSON.stringify({ runId, event: "move_completed", source, target, number }) + "\n");
        if (!fileStable(target, row)) throw new Error(`target_changed_after_move:${target}`);
        const actor = titleActor(match.candidates[0].title);
        const owned = await db.query(`insert into cl.gachinco_tm002_owned_files
          (movie_code,file_path,original_file_path,file_name,file_ext,drive_letter,file_size_bytes,file_mtime,
           source_type,match_method,match_score,original_file_name,actor_names,note,updated_at)
          values ($1,$2,$3,$4,'mp4','N',$5,$6,'normal','gallery_4037_page_number',1.0000,$4,$7,$8,now()) returning owned_file_id`,
        [master.rows[0].movie_code, target, row.detected_path, row.detected_file_name, row.file_size_bytes, row.file_mtime, actor, match.detail]);
        await db.query(`insert into cl.gachinco_tm011_owned_file_video_metadata
          (owned_file_id,movie_code,file_path,file_name,file_size_bytes,file_mtime,probe_status,updated_at)
          values ($1,$2,$3,$4,$5,$6,'pending',now())`,
        [owned.rows[0].owned_file_id, master.rows[0].movie_code, target, row.detected_file_name, row.file_size_bytes, row.file_mtime]);
        await db.query("update cl.gachinco_tm005_unmatched_files set status='resolved',note=$2,updated_at=now() where unmatched_file_id=$1", [row.unmatched_file_id, match.detail]);
        await db.query(`insert into cl.gachinco_tl001_file_process_logs
          (run_id,movie_code,old_path,new_path,old_file_name,new_file_name,action,status,source,matched_by,note)
          values ($1,$2,$3,$4,$5,$5,'register_owned_file','registered','gachinco_manual','gallery_4037_page_number',$6)`,
        [runId, master.rows[0].movie_code, source, target, row.detected_file_name, match.detail]);
        await db.query("commit");
        registered = true;
      } catch (error) {
        await db.query("rollback");
        if (moved && !registered && fs.existsSync(target) && !fs.existsSync(source) && fileStable(target, row)) {
          fs.renameSync(target, source);
          fs.appendFileSync(JOURNAL, JSON.stringify({ runId, event: "move_reverted", source, target, number }) + "\n");
        }
        throw error;
      }
      fs.appendFileSync(JOURNAL, JSON.stringify({ runId, event: "registered", source, target, number }) + "\n");
      outcomes.push({ number, source, target, movieCode: master.rows[0].movie_code, status: "registered" });
      writeReport(runId, outcomes);
      console.log(`${number} registered ${target}`);
    }
  } finally { await db.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { writeReport };
