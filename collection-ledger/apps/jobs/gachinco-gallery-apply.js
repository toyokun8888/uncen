"use strict";

// Apply only the reviewed, unambiguous gallery work records. No video files are touched.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");
const { normalizeTitle } = require("../../packages/domain/src/gachinco-catalog");

const ROOT = path.resolve(__dirname, "../..");
const REVIEW = path.join(ROOT, "storage/exports/gachinco/gachinco-gallery-review.json");
const THUMBS = path.join(ROOT, "storage/thumbnails/gachinco/master");
const REPORT = path.join(ROOT, "storage/exports/gachinco/gachinco-gallery-applied.json");
const LISTING = [
  "https://fellatio.gallery/xxx/%E3%82%AC%E3%83%81%E9%9D%A2%E6%8E%A5",
  "https://fellatio.gallery/xxx/%E3%82%AC%E3%83%81%E9%9D%A2%E6%8E%A5/2",
  "https://fellatio.gallery/xxx/%E3%82%AC%E3%83%81%E9%9D%A2%E6%8E%A5/3",
];

function imageValid(buffer) { return buffer.length > 1000 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9; }
function targetCode(row) { return row.candidates.length === 1 ? row.candidates[0].movieCode : `gch-hd4037-${row.number}`; }
async function connect() {
  require("dotenv").config({ path: process.env.GACHINCO_ENV_FILE || "C:/Users/toyoaki/Desktop/filedatachange/.env", quiet: true });
  const db = new Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD });
  await db.connect();
  return db;
}

async function main() {
  const rows = JSON.parse(fs.readFileSync(REVIEW, "utf8"));
  if (rows.length !== 154 || new Set(rows.map((row) => row.number)).size !== rows.length) throw new Error("review_count_or_number_conflict");
  if (rows.some((row) => !row.title || row.accessLinks < 1 ||
    !/^https:\/\/g\.uuu\.cam\/douga\/.*4037-\d+_480\.jpg$/.test(row.image) ||
    !new RegExp(`4037-${row.number}_480\\.jpg$`).test(row.image) ||
    ![1, 2, 3].includes(row.page))) throw new Error("review_unverified_page_or_image");
  const selected = rows.filter((row) => row.candidates.length <= 1);
  const ambiguous = rows.filter((row) => row.candidates.length > 1);
  const newRows = selected.filter((row) => row.candidates.length === 0).sort((a, b) => a.number - b.number);
  const needsThumbnail = selected.filter((row) => row.candidates.length === 0 || row.candidates[0].thumbnail !== "collected");
  const downloaded = new Map();
  for (const row of needsThumbnail) {
    const response = await fetch(row.image, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`image_fetch_failed:${row.number}:${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!imageValid(buffer)) throw new Error(`image_invalid:${row.number}`);
    downloaded.set(row.number, buffer);
    if (downloaded.size % 10 === 0) console.log(`images ${downloaded.size}/${needsThumbnail.length}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const db = await connect();
  const runId = "gallery-" + new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + crypto.randomBytes(3).toString("hex");
  const writtenPaths = [];
  let committed = false;
  try {
    const existing = await db.query("select m.movie_code,m.title,m.thumbnail_file_path,a.thumbnail_status,a.local_thumbnail_path from cl.gachinco_tm001_master m left join cl.gachinco_tm007_thumbnail_assets a on a.movie_code=m.movie_code");
    const byCode = new Map(existing.rows.map((row) => [row.movie_code, row]));
    const sources = await db.query("select source_record_id,movie_code from cl.gachinco_tm003_master_source_records where source_code='gallery'");
    const byNumber = new Map(sources.rows.map((row) => [row.source_record_id, row.movie_code]));
    for (const row of selected) {
      const code = targetCode(row);
      if (row.candidates.length === 1) {
        const current = byCode.get(code);
        if (!current || current.title !== row.candidates[0].title) throw new Error(`review_master_changed:${row.number}`);
        if (row.candidates[0].thumbnail !== "collected" && current.thumbnail_status === "collected") throw new Error(`review_thumbnail_changed:${row.number}`);
        if (row.candidates[0].thumbnail === "collected" &&
          (current.thumbnail_status !== "collected" || !current.local_thumbnail_path || !fs.existsSync(current.local_thumbnail_path))) throw new Error(`collected_thumbnail_missing:${row.number}`);
      } else if (byCode.has(code)) throw new Error(`new_master_already_exists:${row.number}`);
      const mapped = byNumber.get(`4037-${row.number}`);
      if (mapped && mapped !== code) throw new Error(`existing_4037_conflict:${row.number}`);
    }
    fs.mkdirSync(THUMBS, { recursive: true });
    for (const row of needsThumbnail) {
      const file = path.join(THUMBS, targetCode(row) + ".jpg");
      if (fs.existsSync(file)) throw new Error(`thumbnail_path_collision:${file}`);
    }
    for (const row of needsThumbnail) {
      const file = path.join(THUMBS, targetCode(row) + ".jpg");
      const temporary = file + "." + crypto.randomBytes(5).toString("hex") + ".part";
      fs.writeFileSync(temporary, downloaded.get(row.number));
      fs.renameSync(temporary, file);
      writtenPaths.push(file);
    }
    await db.query("begin");
    try {
      await db.query("lock table cl.gachinco_tm012_recognition_ids, cl.gachinco_tm003_master_source_records in share row exclusive mode");
      const lockedSources = await db.query("select source_record_id,movie_code from cl.gachinco_tm003_master_source_records where source_code='gallery'");
      const lockedByNumber = new Map(lockedSources.rows.map((row) => [row.source_record_id, row.movie_code]));
      for (const row of selected) {
        const mapped = lockedByNumber.get(`4037-${row.number}`);
        if (mapped && mapped !== targetCode(row)) throw new Error(`existing_4037_conflict_after_lock:${row.number}`);
      }
      const maximum = await db.query("select coalesce(max(substring(recognition_id from 6)::integer),0)::integer as n from cl.gachinco_tm012_recognition_ids where recognition_id ~ '^gachi[0-9]+$'");
      let nextId = Number(maximum.rows[0].n) + 1;
      await db.query("insert into cl.gachinco_tl002_master_collect_runs (run_id,status,pages_requested,pages_processed,rows_collected,masters_written,finished_at) values ($1,'completed',3,3,$2,$3,now())", [runId, rows.length, newRows.length]);
      for (const row of newRows) {
        const code = targetCode(row);
        const recognitionId = "gachi" + String(nextId++).padStart(4, "0");
        await db.query("insert into cl.gachinco_tm001_master (movie_code,canonical_key,normalized_title,title,series_name,title_source_code,title_source_record_id,detail_url,thumbnail_url,thumbnail_file_path,review_status) values ($1,$2,$3,$4,null,'gallery',$5,$6,$7,$8,'collected')", [code, `gallery:4037:${row.number}`, normalizeTitle(row.title), row.title, `4037-${row.number}`, row.detail, row.image, path.join(THUMBS, code + ".jpg")]);
        await db.query("insert into cl.gachinco_tm012_recognition_ids (recognition_id,movie_code) values ($1,$2)", [recognitionId, code]);
      }
      for (const row of selected) {
        const code = targetCode(row);
        const imageFile = path.join(THUMBS, code + ".jpg");
        await db.query("insert into cl.gachinco_tm003_master_source_records (run_id,source_code,source_record_id,movie_code,canonical_key,source_title,normalized_title,detail_url,thumbnail_url,source_page_url,page_number,row_index,raw_payload) values ($1,'gallery',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) on conflict (source_code,source_record_id) do nothing", [runId, `4037-${row.number}`, code, `gallery:4037:${row.number}`, row.title, normalizeTitle(row.title), row.detail, row.image, LISTING[row.page - 1], row.page, row.number, JSON.stringify({ galleryDetail: row.detail, galleryImage: row.image, galleryAlt: row.alt, officialProviderId: `4037-${row.number}` })]);
        if (downloaded.has(row.number)) {
          const buffer = downloaded.get(row.number);
          await db.query("update cl.gachinco_tm001_master set thumbnail_url=$2,thumbnail_file_path=$3,updated_at=now() where movie_code=$1", [code, row.image, imageFile]);
          await db.query("insert into cl.gachinco_tm007_thumbnail_assets (movie_code,thumbnail_url,local_thumbnail_path,local_thumbnail_file_name,thumbnail_status,attempt_count,bytes,last_error,last_checked_at,downloaded_at,updated_at) values ($1,$2,$3,$4,'collected',1,$5,null,now(),now(),now()) on conflict (movie_code) do update set thumbnail_url=excluded.thumbnail_url,local_thumbnail_path=excluded.local_thumbnail_path,local_thumbnail_file_name=excluded.local_thumbnail_file_name,thumbnail_status='collected',bytes=excluded.bytes,last_error=null,last_checked_at=now(),downloaded_at=now(),updated_at=now() where cl.gachinco_tm007_thumbnail_assets.thumbnail_status <> 'collected'", [code, row.image, imageFile, path.basename(imageFile), buffer.length]);
        }
      }
      for (let page = 1; page <= 3; page += 1) await db.query("insert into cl.gachinco_tl003_master_page_logs (run_id,source_code,page_number,page_url,rows_found) values ($1,'gallery',$2,$3,$4)", [runId, page, LISTING[page - 1], rows.filter((row) => row.page === page).length]);
      await db.query("commit");
      committed = true;
    } catch (error) { await db.query("rollback"); throw error; }
    const report = { runId, pages: 3, reviewed: rows.length, sourceRecords: selected.length, mastersAdded: newRows.length, thumbnailsAdded: needsThumbnail.length, ambiguous: ambiguous.map((row) => ({ number: row.number, title: row.title, candidates: row.candidates })) };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (!committed) for (const file of writtenPaths) if (fs.existsSync(file)) fs.unlinkSync(file);
    throw error;
  } finally { await db.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
