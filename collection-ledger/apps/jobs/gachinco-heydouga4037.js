"use strict";

// Manual review/apply for explicitly named Heydouga4037 files in the supplied N: folder.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");
const { normalizeTitle } = require("../../packages/domain/src/gachinco-catalog");
const { titleActor } = require("../../packages/domain/src/gachinco-performers");

const ROOT = path.resolve(__dirname, "..", "..");
const SOURCE_ROOT = "N:\\NEWRG\\新しいフォルダー";
const TARGET_ROOT = "N:\\uncen\\gachinco";
const PAGE_FILE = path.join(ROOT, "storage", "imports", "gachinco", "heydouga4037-pages-20260929.json");
const EXPORT_ROOT = path.join(ROOT, "storage", "exports", "gachinco");
const REVIEW_FILE = path.join(EXPORT_ROOT, "gachinco-heydouga4037-review.json");
const COLUMNS = ["action", "reason", "number", "part", "source_path", "target_path", "file_size_bytes", "file_mtime", "page_status", "page_title", "page_url", "movie_code", "recognition_id", "matched_title", "actor_names"];
const REQUIRED_REGISTRY = new Set([
  "cl.paco_owned_file", "cl.heydouga_4017_owned_file", "cl.tenmusume_owned_file", "cl.heyzo_owned_file",
  "cl.onepondo_owned_file", "cl.h0930_owned_file", "cl.carib_owned_file", "cl.tokyo_hot_owned_file",
  "cl.night24_tm002_owned_files", "cl.gachinco_tm002_owned_files",
]);

function parseArgs(argv) {
  const args = { step: "", envFile: "", inputFile: REVIEW_FILE };
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--step") args.step = argv[++i] || "";
    else if (item === "--env-file") args.envFile = argv[++i] || "";
    else if (item === "--input-file") args.inputFile = argv[++i] || "";
    else throw new Error("unknown_argument:" + item);
  }
  if (!["review", "apply"].includes(args.step)) throw new Error("step_required_review_or_apply");
  return args;
}

function loadJson(file) { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
function quoteCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
function saveCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "\uFEFF" + [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((column) => quoteCell(row[column])).join(","))].join("\r\n") + "\r\n", "utf8");
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12); }
function inside(candidate, root) {
  const value = path.win32.normalize(candidate).toLowerCase();
  const base = path.win32.normalize(root).toLowerCase();
  return value === base || value.startsWith(base + "\\");
}
function findFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.win32.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...findFiles(absolute));
    else if (entry.isFile() && /^Heydouga4037-(\d{3,4})(?:-(\d+))?\.4K\.mp4$/i.test(entry.name)) result.push(absolute);
  }
  return result.sort((a, b) => a.localeCompare(b));
}
function cleanPageTitle(value) { return String(value || "").split(" - Hey")[0].trim(); }
function pageForNumber(pages, number) { return pages.find((row) => Number(row.number) === Number(number)); }
function registeredSql(relations) {
  return relations.map(({ schema, name }) => `select file_path::text as file_path from "${schema}"."${name}" where file_path is not null`).join(" union all ");
}
async function registryRelations(db) {
  const result = await db.query(`select n.nspname as schema_name,c.relname as relation_name from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attname='file_path' and not a.attisdropped
    where c.relkind in ('r','p','v','m','f') and n.nspname not in ('pg_catalog','information_schema')`);
  const relations = result.rows.map((row) => ({ schema: row.schema_name, name: row.relation_name }));
  const names = new Set(relations.map((row) => row.schema + "." + row.name));
  for (const name of REQUIRED_REGISTRY) if (!names.has(name)) throw new Error("registry_relation_missing:" + name);
  return relations;
}
async function registeredPaths(db, relations, paths) {
  const normalized = paths.map((item) => path.win32.normalize(item).toLowerCase());
  const result = await db.query(`select distinct lower(replace(file_path,'/',E'\\\\')) as file_path from (${registeredSql(relations)}) registered
    where lower(replace(file_path,'/',E'\\\\')) = any($1::text[])`, [normalized]);
  return new Set(result.rows.map((row) => row.file_path));
}
async function masterRows(db) {
  const result = await db.query(`select m.movie_code,m.title,r.recognition_id from cl.gachinco_tm001_master m
    left join cl.gachinco_tm012_recognition_ids r on r.movie_code=m.movie_code`);
  return result.rows;
}
function candidateForPage(page, masters) {
  const title = cleanPageTitle(page.title);
  const key = normalizeTitle(title);
  const matches = masters.filter((row) => {
    const other = normalizeTitle(row.title);
    return other.length >= 8 && (key === other || key.endsWith(other) || other.endsWith(key));
  });
  if (matches.length > 1) return { reason: "ambiguous_catalog_title", title, matches };
  if (matches.length === 1) return { reason: "existing_master", title, master: matches[0] };
  return { reason: "new_heydouga_master", title, master: { movie_code: "gch-hd4037-" + page.number, recognition_id: "", title } };
}
async function buildReview(db) {
  const pages = loadJson(PAGE_FILE);
  const masters = await masterRows(db);
  const files = findFiles(SOURCE_ROOT);
  const relations = await registryRelations(db);
  const existing = await registeredPaths(db, relations, files);
  const nextIdResult = await db.query("select coalesce(max(substring(recognition_id from 6)::integer),0)::integer as maximum from cl.gachinco_tm012_recognition_ids");
  let nextId = Number(nextIdResult.rows[0].maximum) + 1;
  const newIds = new Map();
  const rows = [];
  for (const source of files) {
    const fileName = path.win32.basename(source);
    const match = /^Heydouga4037-(\d{3,4})(?:-(\d+))?\.4K\.mp4$/i.exec(fileName);
    const number = Number(match[1]);
    const page = pageForNumber(pages, number);
    const stat = fs.statSync(source);
    const key = path.win32.normalize(source).toLowerCase();
    const sitePage = page && page.status === 200 && page.title ? candidateForPage(page, masters) : null;
    let action = "register_owned";
    let reason = sitePage?.reason || "page_unavailable";
    if (existing.has(key)) { action = "leave_registered"; reason = "already_registered_other_site"; }
    else if (!sitePage) action = "move_unmatched";
    else if (sitePage.matches) { action = "move_unmatched"; reason = "ambiguous_catalog_title"; }
    const movieCode = action === "register_owned" ? sitePage.master.movie_code : "";
    if (reason === "new_heydouga_master" && !newIds.has(number)) newIds.set(number, "gachi" + String(nextId++).padStart(4, "0"));
    const recognitionId = action === "register_owned" ? (sitePage.master.recognition_id || newIds.get(number) || "") : "";
    let target = action === "leave_registered" ? source : path.win32.join(TARGET_ROOT, action === "move_unmatched" ? "unmatched" : "", fileName);
    if (action !== "leave_registered" && fs.existsSync(target)) {
      const branch = action === "register_owned" ? movieCode : "unmatched";
      target = path.win32.join(TARGET_ROOT, "branches", branch, digest(path.win32.dirname(source)), fileName);
      if (fs.existsSync(target)) { action = "leave_collision"; reason = "target_collision"; target = source; }
    }
    rows.push({ action, reason, number, part: match[2] || "", source_path: source, target_path: target,
      file_size_bytes: String(stat.size), file_mtime: stat.mtime.toISOString(), page_status: page?.status || 0,
      page_title: page?.title || "", page_url: page?.url || `https://www.heydouga.com/moviepages/4037/${number}/index.html`,
      movie_code: movieCode, recognition_id: recognitionId, matched_title: sitePage?.master?.title || "",
      actor_names: sitePage ? titleActor(sitePage.title) : "" });
  }
  return rows;
}
function assertSameReview(expected, supplied) {
  if (JSON.stringify(expected) !== JSON.stringify(supplied)) throw new Error("review_changed_recreate_review_before_apply");
}
function outputReview(rows) {
  fs.mkdirSync(EXPORT_ROOT, { recursive: true });
  fs.writeFileSync(REVIEW_FILE, JSON.stringify(rows, null, 2) + "\n", "utf8");
  saveCsv(REVIEW_FILE.replace(/\.json$/, ".csv"), rows);
}
function appendJournal(file, event) { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8"); }
function stableAt(file, row) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.statSync(file);
  return String(stat.size) === row.file_size_bytes && stat.mtime.toISOString() === row.file_mtime;
}

async function writeCatalog(db, rows, runId) {
  const distinctPages = [...new Map(rows.filter((row) => row.page_status === 200 && row.action === "register_owned").map((row) => [row.number, row])).values()];
  const newMasters = [...new Map(distinctPages.filter((row) => row.reason === "new_heydouga_master").map((row) => [row.number, row])).values()];
  await db.query("begin");
  try {
    await db.query(`insert into cl.gachinco_tl002_master_collect_runs
      (run_id,status,pages_requested,pages_processed,rows_collected,masters_written,finished_at)
      values ($1,'completed',$2,$3,$3,$4,now())`, [runId, new Set(rows.map((row) => row.number)).size, distinctPages.length, newMasters.length]);
    for (const row of newMasters) {
      await db.query(`insert into cl.gachinco_tm001_master
        (movie_code,canonical_key,normalized_title,title,series_name,title_source_code,title_source_record_id,detail_url,review_status)
        values ($1,$2,$3,$4,null,'heydouga',$5,$6,'collected')`,
      [row.movie_code, "heydouga:4037:" + row.number, normalizeTitle(row.matched_title), row.matched_title,
        "4037-" + row.number, row.page_url]);
      await db.query(`insert into cl.gachinco_tm012_recognition_ids (recognition_id,movie_code)
        values ($1,$2)`, [row.recognition_id, row.movie_code]);
    }
    for (const row of distinctPages) {
      await db.query(`insert into cl.gachinco_tm003_master_source_records
        (run_id,source_code,source_record_id,movie_code,canonical_key,source_title,normalized_title,
         detail_url,source_page_url,page_number,row_index,raw_payload)
        values ($1,'heydouga',$2,$3,$4,$5,$6,$7,$7,$8,1,$9::jsonb)
        on conflict (source_code,source_record_id) do nothing`,
      [runId, "4037-" + row.number, row.movie_code, "heydouga:4037:" + row.number,
        cleanPageTitle(row.page_title), normalizeTitle(cleanPageTitle(row.page_title)), row.page_url, row.number,
        JSON.stringify({ pageTitle: row.page_title, provider: "4037" })]);
    }
    for (const number of new Set(rows.map((row) => row.number))) {
      const first = rows.find((row) => row.number === number);
      await db.query(`insert into cl.gachinco_tl003_master_page_logs
        (run_id,source_code,page_number,page_url,rows_found) values ($1,'heydouga',$2,$3,$4)`,
      [runId, number, first.page_url, first.page_status === 200 ? 1 : 0]);
    }
    await db.query("commit");
  } catch (error) { await db.query("rollback"); throw error; }
}

async function applyRows(db, rows) {
  const runId = "hd4037-" + new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + crypto.randomBytes(3).toString("hex");
  const journal = path.join(EXPORT_ROOT, "gachinco-heydouga4037-" + runId + ".jsonl");
  const resultFile = path.join(EXPORT_ROOT, "gachinco-heydouga4037-applied.csv");
  await writeCatalog(db, rows, runId);
  const relations = await registryRelations(db);
  const outcomes = [];
  for (const row of rows) {
    let status = row.action;
    let note = "";
    if (["register_owned", "move_unmatched"].includes(row.action)) {
      try {
        if (!inside(row.source_path, SOURCE_ROOT) || !inside(row.target_path, TARGET_ROOT)) throw new Error("outside_expected_roots");
        const registered = await registeredPaths(db, relations, [row.source_path, row.target_path]);
        if (registered.size) throw new Error("already_registered_before_move");
        if (!stableAt(row.source_path, row) || fs.existsSync(row.target_path)) throw new Error("file_changed_or_collision_before_move");
        fs.mkdirSync(path.win32.dirname(row.target_path), { recursive: true });
        appendJournal(journal, { event: "move_intent", source: row.source_path, target: row.target_path, number: row.number });
        fs.renameSync(row.source_path, row.target_path);
        if (!stableAt(row.target_path, row)) throw new Error("target_file_changed_after_move");
        appendJournal(journal, { event: "move_completed", source: row.source_path, target: row.target_path, number: row.number });
        await db.query("begin");
        try {
          if (row.action === "register_owned") {
            const inserted = await db.query(`insert into cl.gachinco_tm002_owned_files
              (movie_code,file_path,original_file_path,file_name,file_ext,drive_letter,file_size_bytes,file_mtime,
               source_type,match_method,match_score,original_file_name,actor_names,note,updated_at)
              values ($1,$2,$3,$4,'mp4','N',$5,$6,'normal','heydouga_4037_page_number',1.0000,$4,$7,$8,now())
              returning owned_file_id`, [row.movie_code, row.target_path, row.source_path, path.win32.basename(row.source_path),
              row.file_size_bytes, row.file_mtime, row.actor_names, row.page_url]);
            const id = inserted.rows[0].owned_file_id;
            await db.query(`insert into cl.gachinco_tm011_owned_file_video_metadata
              (owned_file_id,movie_code,file_path,file_name,file_size_bytes,file_mtime,probe_status,updated_at)
              values ($1,$2,$3,$4,$5,$6,'pending',now())`,
            [id, row.movie_code, row.target_path, path.win32.basename(row.source_path), row.file_size_bytes, row.file_mtime]);
            status = "registered";
          } else {
            await db.query(`insert into cl.gachinco_tm005_unmatched_files
              (run_id,detected_path,current_path,detected_file_name,current_file_name,extracted_source_record_id,
               reason,status,source,file_size_bytes,file_mtime,note,updated_at)
              values ($1,$2,$3,$4,$4,$5,$9,'review_required','gachinco_manual',$6,$7,$8,now())`,
            [runId, row.source_path, row.target_path, path.win32.basename(row.source_path), "4037-" + row.number,
              row.file_size_bytes, row.file_mtime, row.page_url, row.reason]);
            status = "unmatched_registered";
          }
          await db.query(`insert into cl.gachinco_tl001_file_process_logs
            (run_id,movie_code,old_path,new_path,old_file_name,new_file_name,action,status,source,matched_by,note)
            values ($1,$2,$3,$4,$5,$5,$6,$7,'gachinco_manual','heydouga_4037_page_number',$8)`,
          [runId, row.movie_code || null, row.source_path, row.target_path, path.win32.basename(row.source_path),
            row.action, status, row.page_url]);
          await db.query("commit");
          appendJournal(journal, { event: "db_registered", source: row.source_path, target: row.target_path, status });
        } catch (error) { await db.query("rollback"); throw error; }
      } catch (error) {
        status = fs.existsSync(row.target_path) && !fs.existsSync(row.source_path) ? "moved_pending_db" : "failed";
        note = error.message;
        appendJournal(journal, { event: "failed", source: row.source_path, target: row.target_path, status, note });
      }
    }
    outcomes.push({ ...row, action: status, reason: note || row.reason });
    saveCsv(resultFile, outcomes);
  }
  const counts = Object.fromEntries([...new Set(outcomes.map((row) => row.action))].map((key) => [key, outcomes.filter((row) => row.action === key).length]));
  process.stdout.write(JSON.stringify({ runId, results: resultFile, journal, counts }) + "\n");
  if (outcomes.some((row) => ["failed", "moved_pending_db"].includes(row.action))) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.envFile) require("dotenv").config({ path: path.resolve(args.envFile), quiet: true });
  const db = new Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD });
  await db.connect();
  try {
    const expected = await buildReview(db);
    if (args.step === "review") {
      outputReview(expected);
      const counts = Object.fromEntries([...new Set(expected.map((row) => row.action))].map((key) => [key, expected.filter((row) => row.action === key).length]));
      process.stdout.write(JSON.stringify({ review: REVIEW_FILE, csv: REVIEW_FILE.replace(/\.json$/, ".csv"), counts }) + "\n");
    } else {
      const supplied = loadJson(path.resolve(args.inputFile));
      assertSameReview(expected, supplied);
      await applyRows(db, supplied);
    }
  } finally { await db.end(); }
}

if (require.main === module) main().catch((error) => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
module.exports = { cleanPageTitle, candidateForPage, findFiles, inside };
