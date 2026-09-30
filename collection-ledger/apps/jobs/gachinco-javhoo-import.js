"use strict";

// Imports the already reviewed 47-page Javhoo listing as Gachinco source evidence.
// Product codes remain source_record_id values and never become master identities.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const IMPORT_DIR = path.join(ROOT, "storage", "imports", "gachinco");
const EXPORT_DIR = path.join(ROOT, "storage", "exports", "gachinco");
const DEFAULT_INPUT = path.join(IMPORT_DIR, "javhoo-gachi-review.json");
const PAGE_COUNT = 47;
const ALLOWED_THUMB_HOST = "pics.javhoo.net";

function parseArgs(argv) {
  const args = { step: "", inputFile: DEFAULT_INPUT, outputFile: "", envFile: "", apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--step") args.step = argv[++i] || "";
    else if (arg.startsWith("--step=")) args.step = arg.slice(7);
    else if (arg === "--input-file") args.inputFile = argv[++i] || "";
    else if (arg.startsWith("--input-file=")) args.inputFile = arg.slice(13);
    else if (arg === "--output-file") args.outputFile = argv[++i] || "";
    else if (arg.startsWith("--output-file=")) args.outputFile = arg.slice(14);
    else if (arg === "--env-file") args.envFile = argv[++i] || "";
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice(11);
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else throw new Error("unknown_argument:" + arg);
  }
  if (!args.step) throw new Error("step_required");
  args.inputFile = path.resolve(args.inputFile || DEFAULT_INPUT);
  if (args.outputFile) args.outputFile = path.resolve(args.outputFile);
  if (args.envFile) args.envFile = path.resolve(args.envFile);
  return args;
}

function say(value) { process.stdout.write(String(value) + "\n"); }
function runId() { return new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + crypto.randomBytes(4).toString("hex"); }
function inside(file, base) {
  const target = path.resolve(file).toLowerCase();
  const root = path.resolve(base).toLowerCase();
  return target === root || target.startsWith(root + path.sep.toLowerCase());
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function normalizeTitle(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
function csvQuote(value) { return '"' + String(value ?? "").replace(/"/g, '""') + '"'; }
function writeCsv(file, rows) {
  const cols = ["page", "row", "source_code", "source_record_id", "title", "product_title", "actor", "release_date", "detail_url", "thumbnail_url", "mapping_status", "candidate_movie_codes", "candidate_titles"];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [cols.map(csvQuote).join(","), ...rows.map((row) => cols.map((col) => csvQuote(row[col])).join(","))].join("\r\n") + "\r\n", "utf8");
}
function productCode(title) {
  return String(title || "").match(/^\s*(GACHI(?:P|G)?-\d+)\b/i)?.[1]?.toUpperCase() || "";
}
function normalizeInput(file) {
  if (!inside(file, IMPORT_DIR) || path.extname(file).toLowerCase() !== ".json") throw new Error("javhoo_input_outside_gachinco_import_dir");
  const input = readJson(file);
  if (!Array.isArray(input) || input.length !== 1633) throw new Error("javhoo_expected_1633_reviewed_listing_rows");
  const pageCounts = new Map();
  const seen = new Set();
  const rows = input.map((item, i) => {
    const page = Number(item.page || 0);
    const rowIndex = Number(item.row || i + 1);
    const id = productCode(item.title);
    const title = String(item.title || "").replace(/\s+/g, " ").trim();
    const productTitle = String(item.productTitle || "").replace(/\s+/g, " ").trim();
    const detailUrl = String(item.detail || "").trim();
    const thumbnailUrl = String(item.thumbnail || "").trim();
    if (page < 1 || page > PAGE_COUNT || !Number.isInteger(page) || rowIndex < 1 || !id || !title || !productTitle || !detailUrl) {
      throw new Error("javhoo_incomplete_row:" + (i + 1));
    }
    if (seen.has(id)) throw new Error("javhoo_duplicate_product_code:" + id);
    seen.add(id);
    const detail = new URL(detailUrl);
    if (detail.protocol !== "https:" || detail.hostname !== "www.javhoo.com") throw new Error("javhoo_detail_host_invalid:" + id);
    if (thumbnailUrl) {
      const image = new URL(thumbnailUrl);
      if (image.protocol !== "https:" || image.hostname !== ALLOWED_THUMB_HOST) throw new Error("javhoo_thumbnail_host_invalid:" + id);
    }
    pageCounts.set(page, (pageCounts.get(page) || 0) + 1);
    return {
      source: "javhoo", sourceRecordId: id, title, normalizedTitle: normalizeTitle(title),
      productTitle, normalizedProductTitle: normalizeTitle(productTitle), actor: String(item.actor || "").trim(),
      releaseDate: String(item.releaseDate || "").trim(), detailUrl, thumbnailUrl, pageNumber: page, rowIndex,
      sourcePage: "https://www.javhoo.com/ja/search/GACHI/page/" + page,
      reviewedMatchStatus: String(item.matchStatus || "").trim(),
      reviewedCandidateMovieCodes: Array.isArray(item.candidates) ? item.candidates.map((candidate) => String(candidate.movieCode || "")).filter(Boolean) : [],
      candidateMovieCodes: [], candidateTitles: [], mappingStatus: "unreviewed",
    };
  });
  if (pageCounts.size !== PAGE_COUNT) throw new Error("javhoo_page_coverage_incomplete:" + pageCounts.size);
  for (let page = 1; page <= PAGE_COUNT; page += 1) if (!pageCounts.has(page)) throw new Error("javhoo_page_missing:" + page);
  return { rows, pageLogs: [...pageCounts].sort((a, b) => a[0] - b[0]).map(([pageNumber, rowsFound]) => ({
    source: "javhoo", pageNumber, rowsFound, pageUrl: "https://www.javhoo.com/ja/search/GACHI/page/" + pageNumber,
  })) };
}
function loadEnv(file) {
  const candidates = [file, process.env.GACHINCO_ENV_FILE, "C:\\Users\\toyoaki\\Desktop\\filedatachange\\.env", path.join(ROOT, ".env")].filter(Boolean);
  const selected = candidates.map((value) => path.resolve(value)).find((value) => fs.existsSync(value));
  if (!selected) throw new Error("database_env_file_not_found_pass_env_file");
  for (const raw of fs.readFileSync(selected, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim().replace(/^\uFEFF/, "");
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
function createDbClient() {
  const { Client } = require("pg");
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (connectionString) return new Client({ connectionString });
  const env = (...keys) => keys.map((key) => process.env[key]).find(Boolean);
  const config = {
    host: env("PGHOST", "DB_HOST", "POSTGRES_HOST") || "localhost",
    port: Number(env("PGPORT", "DB_PORT", "POSTGRES_PORT") || 5432),
    database: env("PGDATABASE", "DB_NAME", "POSTGRES_DB", "POSTGRES_DATABASE", "DATABASE_NAME"),
    user: env("PGUSER", "DB_USER", "POSTGRES_USER", "POSTGRESQL_USER"),
    password: env("PGPASSWORD", "DB_PASSWORD", "POSTGRES_PASSWORD", "DATABASE_PASSWORD", "POSTGRESQL_PASSWORD"),
  };
  if (!config.database || !config.user) throw new Error("database_settings_missing");
  return new Client(config);
}
async function withDb(args, action) {
  loadEnv(args.envFile);
  const db = createDbClient();
  await db.connect();
  try { return await action(db); } finally { await db.end(); }
}
function lookupCandidates(rows, productKey) {
  const exact = new Set();
  const contains = new Set();
  if (productKey.length >= 4) {
    for (const row of rows) {
      if (!row.movie_code) continue;
      if (row.key === productKey) exact.add(String(row.movie_code));
      else if (productKey.length >= 6) {
        const start = row.key.indexOf(productKey);
        if (start >= 0 && !( /\d/u.test(productKey.at(-1)) && /\d/u.test(row.key[start + productKey.length] || "") )) {
          contains.add(String(row.movie_code));
        }
      }
    }
  }
  return [...new Set([...exact, ...contains])];
}
function hasNumericExtensionOnly(rows, movieCode, productKey) {
  const matching = rows.filter((row) => String(row.movie_code) === movieCode);
  if (matching.some((row) => row.key === productKey)) return false;
  return matching.some((row) => {
    const start = row.key.indexOf(productKey);
    return start >= 0 && /\d/u.test(row.key[start + productKey.length] || "");
  });
}
function resolveMapping(row, catalogRows, duplicateJavhooTitles) {
  const freshCandidates = lookupCandidates(catalogRows, row.normalizedProductTitle);
  const allCandidates = [...new Set([...row.reviewedCandidateMovieCodes, ...freshCandidates])]
    .filter((code) => !hasNumericExtensionOnly(catalogRows, code, row.normalizedProductTitle));
  row.candidateMovieCodes = allCandidates;
  const duplicateProductTitle = duplicateJavhooTitles.get(row.normalizedProductTitle)?.size > 1;
  const priorStatusAllowsLink = row.reviewedMatchStatus === "unique";
  if (priorStatusAllowsLink && !duplicateProductTitle && allCandidates.length === 1) row.mappingStatus = "unique_title_match";
  else if (allCandidates.length > 1 || duplicateProductTitle || row.reviewedMatchStatus === "ambiguous") row.mappingStatus = "ambiguous_title_match";
  else row.mappingStatus = "unmatched_title";
  row.candidateTitles = [...new Set(catalogRows.filter((item) => allCandidates.includes(String(item.movie_code))).map((item) => item.title))];
  return allCandidates;
}
async function review(args) {
  const { rows, pageLogs } = normalizeInput(args.inputFile);
  await withDb(args, async (db) => {
    const masters = await db.query("select movie_code,title,canonical_key from cl.gachinco_tm001_master");
    const sources = await db.query("select movie_code,source_title from cl.gachinco_tm003_master_source_records where movie_code is not null");
    const candidateTitles = new Map();
    const catalogRows = [
      ...masters.rows.map((row) => ({ movie_code: row.movie_code, title: row.title, key: normalizeTitle(row.title) })),
      ...sources.rows.map((row) => ({ movie_code: row.movie_code, title: row.source_title, key: normalizeTitle(row.source_title) })),
    ];
    const duplicateJavhooTitles = new Map();
    for (const row of rows) {
      const codes = duplicateJavhooTitles.get(row.normalizedProductTitle) || new Set();
      codes.add(row.sourceRecordId);
      duplicateJavhooTitles.set(row.normalizedProductTitle, codes);
    }
    for (const row of rows) {
      resolveMapping(row, catalogRows, duplicateJavhooTitles);
    }
    const counts = rows.reduce((out, row) => { out[row.mappingStatus] = (out[row.mappingStatus] || 0) + 1; return out; }, {});
    const output = path.resolve(args.outputFile || path.join(EXPORT_DIR, "gachinco-javhoo-review-" + runId() + ".csv"));
    if (!inside(output, EXPORT_DIR)) throw new Error("javhoo_review_output_outside_gachinco_export_dir");
    writeCsv(output, rows);
    const jsonPath = output.replace(/\.csv$/i, ".json");
    writeJson(jsonPath, { source: "javhoo", sourceRows: rows.length, pageLogs, counts, rows });
    say("Reviewed Javhoo " + JSON.stringify({ rows: rows.length, pages: pageLogs.length, counts, csv: output, json: jsonPath }));
  });
}
async function apply(args) {
  if (!args.apply) { say("DRY-RUN javhoo import: use --apply to write the 1,633 source records and 47 page logs."); return; }
  const { rows, pageLogs } = normalizeInput(args.inputFile);
  await withDb(args, async (db) => {
    const migration = await db.query("select count(*)::int as n from pg_constraint where conname in ('gachinco_tm001_master_title_source_code_check','gachinco_tm003_master_source_records_source_code_check','gachinco_tl003_master_page_logs_source_code_check') and pg_get_constraintdef(oid) like '%javhoo%'");
    if (migration.rows[0].n !== 3) throw new Error("javhoo_source_migration_not_applied");
    const candidates = await db.query("select movie_code,title,canonical_key from cl.gachinco_tm001_master");
    const sources = await db.query("select movie_code,source_title from cl.gachinco_tm003_master_source_records where movie_code is not null");
    const catalogRows = [
      ...candidates.rows.map((row) => ({ movie_code: row.movie_code, title: row.title, key: normalizeTitle(row.title), canonical_key: row.canonical_key })),
      ...sources.rows.map((row) => ({ movie_code: row.movie_code, title: row.source_title, key: normalizeTitle(row.source_title) })),
    ];
    const duplicateJavhooTitles = new Map();
    for (const row of rows) {
      const codes = duplicateJavhooTitles.get(row.normalizedProductTitle) || new Set();
      codes.add(row.sourceRecordId);
      duplicateJavhooTitles.set(row.normalizedProductTitle, codes);
    }
    for (const row of rows) resolveMapping(row, catalogRows, duplicateJavhooTitles);
    const expectedLinked = rows.filter((row) => row.mappingStatus === "unique_title_match").length;
    const id = runId();
    await db.query("begin");
    try {
      await db.query("insert into cl.gachinco_tl002_master_collect_runs (run_id,status,pages_requested,pages_processed,rows_collected,finished_at) values ($1,'running',$2,$2,$3,null)", [id, pageLogs.length, rows.length]);
      for (const page of pageLogs) {
        await db.query("insert into cl.gachinco_tl003_master_page_logs (run_id,source_code,page_number,page_url,rows_found) values ($1,'javhoo',$2,$3,$4)", [id, page.pageNumber, page.pageUrl, page.rowsFound]);
      }
      for (const row of rows) {
        const candidateCodes = row.candidateMovieCodes;
        const movieCode = row.mappingStatus === "unique_title_match" ? candidateCodes[0] : null;
        const master = movieCode ? candidates.rows.find((item) => String(item.movie_code) === movieCode) : null;
        const rawPayload = {
          productTitle: row.productTitle, actor: row.actor, releaseDate: row.releaseDate,
          sourceProductCode: row.sourceRecordId, sourceProductCodeType: row.sourceRecordId.split("-")[0],
          mappingStatus: row.mappingStatus,
          candidateMovieCodes: candidateCodes, sourceTitleMatchPolicy: "normalized title equality or Javhoo product title contained in exactly one existing title/source title; no actor-only match",
        };
        await db.query(
          "insert into cl.gachinco_tm003_master_source_records (run_id,source_code,source_record_id,movie_code,canonical_key,source_title,normalized_title,series_name,detail_url,thumbnail_url,source_page_url,page_number,row_index,raw_payload,last_seen_at,updated_at) values ($1,'javhoo',$2,$3,$4,$5,$6,'ガチん娘',$7,$8,$9,$10,$11,$12::jsonb,now(),now()) on conflict (source_code,source_record_id) do update set run_id=excluded.run_id,movie_code=excluded.movie_code,canonical_key=excluded.canonical_key,source_title=excluded.source_title,normalized_title=excluded.normalized_title,series_name=excluded.series_name,detail_url=excluded.detail_url,thumbnail_url=excluded.thumbnail_url,source_page_url=excluded.source_page_url,page_number=excluded.page_number,row_index=excluded.row_index,raw_payload=excluded.raw_payload,last_seen_at=now(),updated_at=now() where cl.gachinco_tm003_master_source_records.movie_code is null or cl.gachinco_tm003_master_source_records.movie_code=excluded.movie_code",
          [id, row.sourceRecordId, movieCode, master?.canonical_key || ("unresolved:javhoo:" + row.sourceRecordId), row.title, row.normalizedTitle, row.detailUrl, row.thumbnailUrl || null, row.sourcePage, row.pageNumber, row.rowIndex, JSON.stringify(rawPayload)]
        );
      }
      const check = await db.query("select count(*) filter(where source_code='javhoo')::int as records,count(*) filter(where source_code='javhoo' and movie_code is not null)::int as linked,count(distinct page_number) filter(where source_code='javhoo')::int as pages from cl.gachinco_tm003_master_source_records where source_code='javhoo'");
      const storedRows = await db.query("select source_record_id,movie_code from cl.gachinco_tm003_master_source_records where source_code='javhoo'");
      const expectedById = new Map(rows.map((row) => [row.sourceRecordId, row.mappingStatus === "unique_title_match" ? row.candidateMovieCodes[0] : null]));
      const mismatched = storedRows.rows.filter((row) => (row.movie_code ? String(row.movie_code) : null) !== (expectedById.get(String(row.source_record_id)) || null));
      if (check.rows[0].records !== rows.length || check.rows[0].pages !== PAGE_COUNT || check.rows[0].linked !== expectedLinked || mismatched.length) {
        throw new Error("javhoo_import_postcheck_failed:" + JSON.stringify({ ...check.rows[0], expectedLinked, mismatched: mismatched.length }));
      }
      await db.query("update cl.gachinco_tl002_master_collect_runs set status='completed',masters_written=0,finished_at=now() where run_id=$1", [id]);
      await db.query("commit");
      say("Javhoo import completed " + JSON.stringify({ runId: id, ...check.rows[0] }));
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}
async function status(args) {
  await withDb(args, async (db) => {
    const result = await db.query("select count(*)::int as records,count(*) filter(where movie_code is not null)::int as linked,count(distinct page_number)::int as pages from cl.gachinco_tm003_master_source_records where source_code='javhoo'");
    say("Javhoo DB status " + JSON.stringify(result.rows[0]));
  });
}
async function main() {
  const args = parseArgs(process.argv);
  if (args.step === "review") await review(args);
  else if (args.step === "import") await apply(args);
  else if (args.step === "status") await status(args);
  else throw new Error("unsupported_step:" + args.step);
}
main().catch((error) => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
