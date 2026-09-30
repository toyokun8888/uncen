"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { normalizeTitle } = require("../../packages/domain/src/gachinco-catalog");

const ROOT = path.resolve(__dirname, "../..");
const DETAILS = path.join(ROOT, "storage/imports/gachinco/fellatio-gallery-details.json");
const REVIEW = path.join(ROOT, "storage/exports/gachinco/gachinco-gallery-review.json");
const CSV = REVIEW.replace(/\.json$/, ".csv");
function csvCell(value) {
  const cell = String(value ?? "");
  return /[",\r\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
}

function candidatesFor(row, masters, sources) {
  const key = normalizeTitle(row.title);
  const bySource = sources.filter((source) => source.source_code === "heydouga" && source.source_record_id === `4037-${row.number}`);
  if (bySource.length) return { method: "existing_4037", candidates: [...new Set(bySource.map((source) => source.movie_code))] };
  const byTitle = masters.filter((master) => normalizeTitle(master.title) === key);
  if (byTitle.length) return { method: "exact_master_title", candidates: byTitle.map((master) => master.movie_code) };
  const bySourceTitle = sources.filter((source) => normalizeTitle(source.source_title) === key);
  if (bySourceTitle.length) return { method: "exact_source_title", candidates: [...new Set(bySourceTitle.map((source) => source.movie_code).filter(Boolean))] };
  const byContainedTitle = masters.filter((master) => {
    const other = normalizeTitle(master.title);
    return key.length >= 8 && other.includes(key);
  });
  if (row.number === 403 || row.number === 404) {
    const actor = row.number === 403 ? "未果" : "紗良";
    const actorMatches = byContainedTitle.filter((master) => master.title.includes(actor));
    if (actorMatches.length === 1) return { method: "reviewed_actor_4037", candidates: actorMatches.map((master) => master.movie_code) };
  }
  return { method: byContainedTitle.length ? "contained_title" : "unmatched_title", candidates: byContainedTitle.map((master) => master.movie_code) };
}

async function main() {
  require("dotenv").config({ path: process.env.GACHINCO_ENV_FILE || "C:/Users/toyoaki/Desktop/filedatachange/.env", quiet: true });
  const db = new Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD });
  await db.connect();
  try {
    const mastersResult = await db.query("select movie_code,title,thumbnail_file_path from cl.gachinco_tm001_master");
    const sourcesResult = await db.query("select source_code,source_record_id,movie_code,source_title from cl.gachinco_tm003_master_source_records");
    const assetsResult = await db.query("select movie_code,thumbnail_status,local_thumbnail_path from cl.gachinco_tm007_thumbnail_assets");
    const masters = mastersResult.rows;
    const sources = sourcesResult.rows;
    const assets = new Map(assetsResult.rows.map((row) => [row.movie_code, row]));
    const rows = JSON.parse(fs.readFileSync(DETAILS, "utf8")).map((row) => {
      const match = candidatesFor(row, masters, sources);
      return { ...row, method: match.method, candidates: match.candidates.map((code) => {
        const master = masters.find((item) => item.movie_code === code);
        return { movieCode: code, title: master?.title || "", thumbnail: assets.get(code)?.thumbnail_status || "none", thumbnailFile: assets.get(code)?.local_thumbnail_path || "" };
      }) };
    });
    fs.mkdirSync(path.dirname(REVIEW), { recursive: true });
    fs.writeFileSync(REVIEW, JSON.stringify(rows, null, 2) + "\n");
    const headers = ["page", "number", "title", "alt", "detail", "image", "method", "candidate_count", "movie_codes", "candidate_titles", "thumbnail_status"];
    const csvRows = rows.map((row) => [row.page, row.number, row.title, row.alt, row.detail, row.image, row.method,
      row.candidates.length, row.candidates.map((candidate) => candidate.movieCode).join(" | "),
      row.candidates.map((candidate) => candidate.title).join(" | "), row.candidates.map((candidate) => candidate.thumbnail).join(" | ")]);
    fs.writeFileSync(CSV, "\uFEFF" + [headers, ...csvRows].map((columns) => columns.map(csvCell).join(",")).join("\r\n") + "\r\n", "utf8");
    const counts = Object.groupBy(rows, (row) => row.method + ":" + row.candidates.length);
    console.log(JSON.stringify(Object.fromEntries(Object.entries(counts).map(([key, items]) => [key, items.length])), null, 2));
    for (const row of rows.filter((row) => row.candidates.length !== 1)) console.log(JSON.stringify({ number: row.number, title: row.title, method: row.method, candidates: row.candidates }));
  } finally { await db.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { candidatesFor };
