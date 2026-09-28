"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildCatalogIndex, canonicalKeyForTitle, normalizeTitle } = require("../../packages/domain/src/night24-catalog");
const { buildRecognitionPlan } = require("../../packages/domain/src/night24-recognition-id");

const ROOT = path.resolve(__dirname, "..", "..");
const IMPORT_DIR = path.join(ROOT, "storage", "imports", "night24");
const THUMB_DIR = path.join(ROOT, "storage", "thumbnails", "night24", "master");
const DEFAULT_INPUT = path.join(IMPORT_DIR, "night24-catalog-latest.json");
const SOURCES = { analers: 1, shiitake: 26, heydouga: 10 };
const ALLOWED_THUMB_HOSTS = new Set(["analersdelight.com", "img.moromieav.com", "image01-www.heydouga.com", "shiitake-taicho.com"]);

function argsFrom(argv) {
  const result = { step: "", envFile: "", inputFile: DEFAULT_INPUT, outputFile: "", apply: false, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--step") result.step = argv[++i] || "";
    else if (a.startsWith("--step=")) result.step = a.slice(7);
    else if (a === "--env-file") result.envFile = argv[++i] || "";
    else if (a.startsWith("--env-file=")) result.envFile = a.slice(11);
    else if (a === "--input-file") result.inputFile = argv[++i] || "";
    else if (a.startsWith("--input-file=")) result.inputFile = a.slice(13);
    else if (a === "--output-file") result.outputFile = argv[++i] || "";
    else if (a.startsWith("--output-file=")) result.outputFile = a.slice(14);
    else if (a === "--limit") result.limit = Number(argv[++i]);
    else if (a.startsWith("--limit=")) result.limit = Number(a.slice(8));
    else if (a === "--apply") result.apply = true;
    else if (a === "--dry-run") result.apply = false;
    else throw new Error("unknown_argument:" + a);
  }
  if (!result.step) throw new Error("step_required");
  if (!Number.isInteger(result.limit) || result.limit < 0) throw new Error("invalid_limit");
  result.inputFile = path.resolve(result.inputFile || DEFAULT_INPUT);
  if (result.outputFile) result.outputFile = path.resolve(result.outputFile);
  return result;
}

function say(value) { process.stdout.write(String(value) + "\n"); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeUnder(file, base) {
  const target = path.resolve(file).toLowerCase();
  const root = path.resolve(base).toLowerCase();
  return target === root || target.startsWith(root + path.sep.toLowerCase());
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function runId() { return new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + crypto.randomBytes(4).toString("hex"); }

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
function envValue(...keys) {
  for (const key of keys) if (process.env[key]) return String(process.env[key]);
  return undefined;
}
function createClient() {
  const { Client } = require("pg");
  const connectionString = envValue("DATABASE_URL", "POSTGRES_URL");
  const config = connectionString ? { connectionString } : {
    host: envValue("PGHOST", "DB_HOST", "POSTGRES_HOST") || "localhost",
    port: Number(envValue("PGPORT", "DB_PORT", "POSTGRES_PORT") || 5432),
    database: envValue("PGDATABASE", "DB_NAME", "POSTGRES_DB", "POSTGRES_DATABASE", "DATABASE_NAME"),
    user: envValue("PGUSER", "DB_USER", "POSTGRES_USER", "POSTGRESQL_USER"),
    password: envValue("PGPASSWORD", "DB_PASSWORD", "POSTGRES_PASSWORD", "DATABASE_PASSWORD", "POSTGRESQL_PASSWORD"),
  };
  if (!connectionString && (!config.database || !config.user)) throw new Error("database_settings_missing");
  return new Client(config);
}
async function withDb(args, callback) {
  loadEnv(args.envFile);
  const client = createClient();
  await client.connect();
  try { return await callback(client); } finally { await client.end(); }
}

function getPageNumber(row) {
  const pageUrl = String(row.sourcePage || row.pageUrl || row.detailUrl || row.href || "");
  const found = pageUrl.match(/[?&]page=(\d+)/i) || pageUrl.match(/provider_4044_(\d+)\.html/i);
  return Number(row.pageNumber || (found ? found[1] : 1));
}
function normalizeInput(raw) {
  if (!raw || !Array.isArray(raw.rows) || !Array.isArray(raw.pageLogs)) throw new Error("catalog_requires_rows_and_pageLogs");
  const rows = raw.rows.map((row) => ({
    ...row,
    source: String(row.source || ""),
    sourceRecordId: String(row.sourceRecordId || ""),
    title: String(row.title || "").trim(),
    thumbnailUrl: String(row.thumbnailUrl || ""),
    detailUrl: String(row.detailUrl || row.href || ""),
    sourcePage: String(row.sourcePage || row.pageUrl || ""),
    pageNumber: getPageNumber(row),
  }));
  const pages = new Map();
  for (const item of raw.pageLogs) {
    const source = String(item.source || item.source_code || "");
    const number = Number(item.pageNumber || item.page_number);
    const url = String(item.pageUrl || item.page_url || "");
    const count = Number(item.rowsFound || item.rows_found || 0);

    if (!SOURCES[source] || !url || !Number.isInteger(number) || number < 1 || number > SOURCES[source] || count < 1) throw new Error("invalid_catalog_page_log");
    const key = source + ":" + number;
    if (pages.has(key)) throw new Error("duplicate_catalog_page:" + key);
    pages.set(key, { source, pageNumber: number, pageUrl: url, rowsFound: count });
  }
  for (const [source, pageCount] of Object.entries(SOURCES)) {
    for (let number = 1; number <= pageCount; number++) {
      if (!pages.has(source + ":" + number)) throw new Error("catalog_page_missing:" + source + ":" + number);
    }
  }
  const identities = new Set();
  for (const row of rows) {
    const id = row.source + ":" + row.sourceRecordId;
    if (!SOURCES[row.source] || !row.sourceRecordId || !row.title || !row.thumbnailUrl || !row.sourcePage) throw new Error("catalog_row_incomplete:" + id);
    if (identities.has(id)) throw new Error("duplicate_catalog_record:" + id);
    identities.add(id);
    if (!pages.has(row.source + ":" + row.pageNumber)) throw new Error("catalog_row_page_missing:" + id);
  }
  const counts = {};
  for (const source of Object.keys(SOURCES)) counts[source] = rows.filter((row) => row.source === source).length;
  if (counts.analers < 500 || counts.shiitake < 700 || counts.heydouga < 400) {
    throw new Error("catalog_volume_below_review_threshold:" + JSON.stringify(counts));
  }
  return { scrapedAt: raw.scrapedAt || new Date().toISOString(), rows, pageLogs: Array.from(pages.values()), counts };
}
function loadCatalog(file) {
  const resolved = path.resolve(file);
  if (!safeUnder(resolved, IMPORT_DIR)) throw new Error("catalog_input_outside_import_dir");
  const data = normalizeInput(readJson(resolved));
  return { data, index: buildCatalogIndex(data.rows) };
}
function pageUrl(source, number) {
  if (source === "analers") return "https://analersdelight.com/moromie-av-matome/";
  if (source === "shiitake") return "https://shiitake-taicho.com/maker/87/?maker=87&page=" + number;
  return "https://www.heydouga.com/listpages/provider_4044_" + number + ".html?low_price=1.00&high_price=500.00&search_type=strict";
}

async function crawl(args) {
  const output = path.resolve(args.outputFile || DEFAULT_INPUT);
  if (!safeUnder(output, IMPORT_DIR)) throw new Error("crawl_output_outside_import_dir");
  const cheerio = require("cheerio");
  const puppeteer = require("puppeteer");
  const result = { scrapedAt: new Date().toISOString(), rows: [], pageLogs: [] };
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => ["image", "media", "font"].includes(request.resourceType()) ? request.abort() : request.continue());
    await page.goto(pageUrl("analers", 1), { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector(".ald-card", { timeout: 25000 });
    await delay(1200);
    const analers = await page.evaluate(() => Array.from(document.querySelectorAll(".ald-card")).map((card, index) => ({
      source: "analers",
      sourcePage: location.href,
      sourceRecordId: card.querySelector("[data-popup]")?.getAttribute("data-popup") || ("card-" + (index + 1)),
      title: card.querySelector(".ald-card-title")?.textContent?.replace(/\s+/g, " ").trim() || "",
      series: card.querySelector(".ald-actresses")?.textContent?.replace(/\s+/g, " ").trim().replace(/ アナル作品一覧へ→$/, "") || "",
      thumbnailUrl: Array.from(card.querySelector(".ald-thumbwrap")?.querySelectorAll("img") || []).map((image) => image.getAttribute("src") || image.getAttribute("data-src") || "").find((url) => url && !url.includes("s.w.org")) || "",
      links: Array.from(card.querySelectorAll("a[href]")).map((anchor) => anchor.href),
    })));
    result.rows.push(...analers);
    result.pageLogs.push({ source: "analers", pageNumber: 1, pageUrl: pageUrl("analers", 1), rowsFound: analers.length });
    say("Analers: " + analers.length);

    const shiitake = [];
    for (let number = 1; number <= 26; number++) {
      await delay(2100);
      const url = pageUrl("shiitake", number);
      const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("shiitake_http_" + response.status + "_page_" + number);
      const $ = cheerio.load(await response.text());
      const rows = $("article.product-card").map((_, element) => {
        const card = $(element);
        const href = card.find('a[href*="/detail/"]').first().attr("href") || "";
        return {
          source: "shiitake", sourcePage: url, pageNumber: number,
          sourceRecordId: href.match(/\/detail\/(\d+)\//)?.[1] || "",
          title: card.find(".product-card__title").first().text().replace(/\s+/g, " ").trim(),
          thumbnailUrl: card.find("img.product-card__image").first().attr("src") || "",
          detailUrl: href ? new URL(href, url).href : "",
        };
      }).get();
      if (!rows.length) throw new Error("shiitake_page_empty:" + number);
      shiitake.push(...rows);
      result.pageLogs.push({ source: "shiitake", pageNumber: number, pageUrl: url, rowsFound: rows.length });
      say("Shiitake " + number + "/26: " + rows.length);
    }
    result.rows.push(...shiitake);

    const heydouga = [];
    for (let number = 1; number <= 10; number++) {
      const url = pageUrl("heydouga", number);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('.list-item.provider .movie-image[data-site-id="4044"][data-movie-id]', { timeout: 30000 });
      await delay(900);
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll(".list-item.provider")).map((card) => {
        const image = card.querySelector('.movie-image[data-site-id="4044"][data-movie-id]');
        const title = card.querySelector(".movie-title a");

        const thumb = card.querySelector(".image-thumbnail");
        return {
          source: "heydouga", sourcePage: location.href,
          sourceRecordId: image?.getAttribute("data-movie-id") || "",
          title: title?.textContent?.replace(/\s+/g, " ").trim() || "",
          thumbnailUrl: thumb?.getAttribute("src") || thumb?.getAttribute("data-src") || "",
          detailUrl: title?.href || "",
        };
      }).filter((row) => row.sourceRecordId));
      if (!rows.length) throw new Error("heydouga_page_empty:" + number);
      heydouga.push(...rows);
      result.pageLogs.push({ source: "heydouga", pageNumber: number, pageUrl: url, rowsFound: rows.length });
      say("HeyDouga " + number + "/10: " + rows.length);
      await delay(1500);
    }
    result.rows.push(...heydouga);
  } finally {
    await browser.close();
  }
  const normalized = normalizeInput(result);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  say("Saved " + normalized.rows.length + " rows and " + normalized.pageLogs.length + " page logs: " + output);
}

async function initDb(args) {
  const migrations = ["150_night24_site.sql", "151_night24_recognition_ids.sql"]
    .map((file) => fs.readFileSync(path.join(ROOT, "ops", "sql", file), "utf8").replace(/^\uFEFF/, ""));
  if (!args.apply) {
    say("DRY-RUN init-db: additive Night24 schema migrations are ready; use --apply to execute.");
    return;
  }
  await withDb(args, async (db) => {
    await db.query("begin");
    try { for (const sql of migrations) await db.query(sql); await db.query("commit"); }
    catch (error) { await db.query("rollback"); throw error; }
    const check = await db.query("select site_code from cl.site_master where site_code=$1", ["night24"]);
    if (check.rowCount !== 1) throw new Error("site_master_postcheck_failed");
  });
  say("Applied additive Night24 schema; site_master postcheck passed.");
}

async function assignMissingRecognitionIds(db) {
  await db.query("lock table cl.night24_tm012_recognition_ids in share row exclusive mode");
  const [masters, mappings] = await Promise.all([
    db.query("select movie_code,title from cl.night24_tm001_master"),
    db.query("select movie_code,recognition_id from cl.night24_tm012_recognition_ids"),
  ]);
  const plan = buildRecognitionPlan(masters.rows, mappings.rows);
  for (const row of plan) {
    await db.query(
      "insert into cl.night24_tm012_recognition_ids (recognition_id,movie_code) values ($1,$2)",
      [row.recognition_id, row.movie_code]
    );
  }
  return plan.length;
}

async function syncCatalog(args) {
  const { data, index } = loadCatalog(args.inputFile);
  const summary = {
    scrapedAt: data.scrapedAt,
    rows: data.rows.length,
    pages: data.pageLogs.length,
    sourceCounts: data.counts,
    canonicalTitles: index.masters.length,
  };
  say((args.apply ? "APPLY" : "DRY-RUN") + " catalog-sync " + JSON.stringify(summary));
  if (!args.apply) return;
  await withDb(args, async (db) => {
    const id = runId();
    await db.query("begin");
    try {
      const recognitionMigration = fs.readFileSync(path.join(ROOT, "ops", "sql", "151_night24_recognition_ids.sql"), "utf8").replace(/^\uFEFF/, "");
      await db.query(recognitionMigration);
      await db.query(
        "insert into cl.night24_tl002_master_collect_runs (run_id,status,pages_requested,pages_processed,rows_collected,finished_at) values ($1,'running',$2,$2,$3,null)",
        [id, data.pageLogs.length, data.rows.length]
      );
      for (const master of index.masters) {
        await db.query(
          "insert into cl.night24_tm001_master (movie_code,canonical_key,normalized_title,title,series_name,title_source_code,title_source_record_id,detail_url,thumbnail_url,review_status,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'collected',now()) on conflict (canonical_key) do update set normalized_title=excluded.normalized_title,title=excluded.title,series_name=excluded.series_name,title_source_code=excluded.title_source_code,title_source_record_id=excluded.title_source_record_id,detail_url=excluded.detail_url,thumbnail_url=excluded.thumbnail_url,updated_at=now()",
          [master.movieCode, master.canonicalKey, master.normalizedTitle, master.title, master.seriesName || null, master.titleSourceCode, master.titleSourceRecordId, master.detailUrl || null, master.thumbnailUrl]
        );
      }
      const recognitionIdsAssigned = await assignMissingRecognitionIds(db);
      for (const page of data.pageLogs) {
        await db.query(
          "insert into cl.night24_tl003_master_page_logs (run_id,source_code,page_number,page_url,rows_found) values ($1,$2,$3,$4,$5)",
          [id, page.source, page.pageNumber, page.pageUrl, page.rowsFound]
        );
      }
      for (let i = 0; i < data.rows.length; i++) {
        const row = data.rows[i];
        const canonicalKey = canonicalKeyForTitle(row.title);
        const master = index.masterByCanonicalKey.get(canonicalKey);
        if (!master) throw new Error("master_for_source_record_missing:" + row.source + ":" + row.sourceRecordId);
        await db.query(
          "insert into cl.night24_tm003_master_source_records (run_id,source_code,source_record_id,movie_code,canonical_key,source_title,normalized_title,series_name,detail_url,thumbnail_url,source_page_url,page_number,row_index,raw_payload,last_seen_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,now(),now()) on conflict (source_code,source_record_id) do update set run_id=excluded.run_id,movie_code=excluded.movie_code,canonical_key=excluded.canonical_key,source_title=excluded.source_title,normalized_title=excluded.normalized_title,series_name=excluded.series_name,detail_url=excluded.detail_url,thumbnail_url=excluded.thumbnail_url,source_page_url=excluded.source_page_url,page_number=excluded.page_number,row_index=excluded.row_index,raw_payload=excluded.raw_payload,last_seen_at=now(),updated_at=now()",
          [id, row.source, row.sourceRecordId, master.movieCode, canonicalKey, row.title, normalizeTitle(row.title), row.series || null, row.detailUrl || null, row.thumbnailUrl, row.sourcePage, row.pageNumber, i + 1, JSON.stringify(row)]
        );
      }
      const count = await db.query("select count(*)::integer as total from cl.night24_tm001_master");
      await db.query("update cl.night24_tl002_master_collect_runs set status='completed',masters_written=$2,finished_at=now() where run_id=$1", [id, count.rows[0].total]);
      await db.query("commit");
      const check = await db.query(
        "select (select count(*) from cl.night24_tm001_master) as masters,(select count(*) from cl.night24_tm003_master_source_records) as source_records,(select count(*) from cl.night24_tl003_master_page_logs where run_id=$1) as page_logs",
        [id]
      );
      say("Catalog run " + id + " committed; postcheck " + JSON.stringify({ ...check.rows[0], recognition_ids_assigned: recognitionIdsAssigned }));

    } catch (error) { await db.query("rollback"); throw error; }
  });
}

function imageExt(buffer) {
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return ".jpg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ".png";
  return "";
}
async function getImage(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_THUMB_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error("thumbnail_host_blocked:" + parsed.hostname);
  const response = await fetch(parsed.href, { headers: { "user-agent": "Mozilla/5.0 collection-ledger-night24" }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("thumbnail_http_" + response.status);
  if (Number(response.headers.get("content-length") || 0) > 10485760) throw new Error("thumbnail_over_10mb");
  const data = Buffer.from(await response.arrayBuffer());
  const extension = imageExt(data);
  if (!data.length || data.length > 10485760 || !extension) throw new Error("thumbnail_signature_or_size_invalid");
  return { data, extension };
}
const THUMB_EXTENSIONS = [".jpg", ".png", ".webp"];
function thumbnailIntentPath(finalPath) { return finalPath + ".intent.json"; }
function durableWrite(file, data) {
  const fd = fs.openSync(file, "wx");
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function matchingSource(candidates, source) {
  return candidates.find((candidate) => candidate.source === source.source && String(candidate.sourceRecordId) === String(source.sourceRecordId) && candidate.thumbnailUrl === source.thumbnailUrl && candidate.title === source.title) || null;
}
function recoverThumbnail(movieCode, candidates) {
  for (const extension of THUMB_EXTENSIONS) {
    const finalPath = path.join(THUMB_DIR, movieCode + extension);
    if (!fs.existsSync(finalPath)) continue;
    const intentPath = thumbnailIntentPath(finalPath);
    if (!fs.existsSync(intentPath)) throw new Error("thumbnail_path_collision_without_recovery_record:" + finalPath);
    let intent;
    try { intent = readJson(intentPath); } catch { throw new Error("thumbnail_recovery_record_invalid:" + intentPath); }
    if (intent.version !== 1 || intent.movie_code !== movieCode || path.resolve(intent.final_path) !== path.resolve(finalPath) || intent.extension !== extension) throw new Error("thumbnail_recovery_record_mismatch:" + finalPath);
    const matched = matchingSource(candidates, intent.source || {});
    if (!matched) throw new Error("thumbnail_recovery_source_not_in_catalog:" + movieCode);
    const data = fs.readFileSync(finalPath);
    if (!data.length || data.length > 10485760 || data.length !== Number(intent.bytes) || imageExt(data) !== extension || crypto.createHash("sha256").update(data).digest("hex") !== intent.sha256) throw new Error("thumbnail_recovery_file_validation_failed:" + finalPath);
    return { data, extension, source: matched, recovered: true, finalPath, intentPath };
  }
  return null;
}
async function getThumbnails(args) {
  const { index } = loadCatalog(args.inputFile);
  const summary = await withDb(args, async (db) => {
    const pending = await db.query(
      "select master.movie_code,master.thumbnail_url from cl.night24_tm001_master master left join cl.night24_tm007_thumbnail_assets asset on asset.movie_code=master.movie_code where coalesce(asset.thumbnail_status,'pending') <> 'collected' and coalesce(asset.attempt_count,0) < 3 order by master.movie_code"
    );
    const selected = args.limit ? pending.rows.slice(0, args.limit) : pending.rows;
    say((args.apply ? "APPLY" : "DRY-RUN") + " thumbnails pending_retryable=" + pending.rowCount + " selected=" + selected.length);
    if (!args.apply) return { retryable: pending.rowCount, selected: selected.length };
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    let collected = 0;
    let failed = 0;
    for (const item of selected) {
      const master = index.masterByCode.get(item.movie_code);
      const candidates = [];
      const urls = new Set();
      for (const row of [master && master.thumbnailSourceRecord].concat(master ? master.sourceRows : [])) {
        if (!row || !row.thumbnailUrl || urls.has(row.thumbnailUrl)) continue;
        urls.add(row.thumbnailUrl);
        candidates.push(row);
      }
      let image = recoverThumbnail(item.movie_code, candidates);
      let failure = "";
      if (!image) {
        for (const candidate of candidates) {
          try { image = await getImage(candidate.thumbnailUrl); image.source = candidate; break; }
          catch (error) { failure = String(error.message || error); await delay(250); }
        }
      }
      if (!image) {
        failed++;
        await db.query(
          "insert into cl.night24_tm007_thumbnail_assets (movie_code,thumbnail_url,thumbnail_status,attempt_count,last_error,last_checked_at,updated_at) values ($1,$2,'failed',1,$3,now(),now()) on conflict (movie_code) do update set thumbnail_status='failed',attempt_count=cl.night24_tm007_thumbnail_assets.attempt_count+1,last_error=excluded.last_error,last_checked_at=now(),updated_at=now()",
          [item.movie_code, item.thumbnail_url, failure.slice(0, 900)]
        );
      } else {
        let finalPath = image.finalPath || path.join(THUMB_DIR, item.movie_code + image.extension);
        let intentPath = image.intentPath || thumbnailIntentPath(finalPath);
        const source = image.source;
        if (!image.recovered) {
          if (fs.existsSync(finalPath)) throw new Error("thumbnail_path_collision:" + finalPath);
          const tempPath = finalPath + "." + crypto.randomBytes(5).toString("hex") + ".part";
          const intentTemp = intentPath + "." + crypto.randomBytes(5).toString("hex") + ".part";
          const intent = { version: 1, movie_code: item.movie_code, final_path: finalPath, extension: image.extension, bytes: image.data.length, sha256: crypto.createHash("sha256").update(image.data).digest("hex"), source, created_at: new Date().toISOString() };
          durableWrite(tempPath, image.data);
          if (fs.existsSync(intentPath)) fs.rmSync(intentPath);
          durableWrite(intentTemp, JSON.stringify(intent, null, 2) + "\n");
          fs.renameSync(intentTemp, intentPath);
          fs.renameSync(tempPath, finalPath);
        }
        await db.query("begin");
        try {
          await db.query(
            "update cl.night24_tm001_master set title=$2,title_source_code=$3,title_source_record_id=$4,detail_url=coalesce(nullif($5,''),detail_url),thumbnail_url=$6,thumbnail_file_path=$7,updated_at=now() where movie_code=$1",
            [item.movie_code, source.title, source.source, source.sourceRecordId, source.detailUrl || "", source.thumbnailUrl, finalPath]
          );
          await db.query(
            "insert into cl.night24_tm007_thumbnail_assets (movie_code,thumbnail_url,local_thumbnail_path,local_thumbnail_file_name,thumbnail_status,attempt_count,bytes,last_error,last_checked_at,downloaded_at,updated_at) values ($1,$2,$3,$4,'collected',1,$5,null,now(),now(),now()) on conflict (movie_code) do update set thumbnail_url=excluded.thumbnail_url,local_thumbnail_path=excluded.local_thumbnail_path,local_thumbnail_file_name=excluded.local_thumbnail_file_name,thumbnail_status='collected',attempt_count=cl.night24_tm007_thumbnail_assets.attempt_count+1,bytes=excluded.bytes,last_error=null,last_checked_at=now(),downloaded_at=now(),updated_at=now()",
            [item.movie_code, source.thumbnailUrl, finalPath, path.basename(finalPath), image.data.length]
          );
          await db.query("commit");
        } catch (error) { await db.query("rollback"); throw error; }
        if (fs.existsSync(intentPath)) fs.rmSync(intentPath);
        collected++;
      }
      if ((collected + failed) % 25 === 0) say("Thumbnail progress " + (collected + failed) + "/" + selected.length + " collected=" + collected + " failed=" + failed);
      await delay(900);
    }
    return { retryable: pending.rowCount, selected: selected.length, collected, failed };
  });
  say("Thumbnail result " + JSON.stringify(summary));
}

async function status(args) {
  await withDb(args, async (db) => {
    const result = await db.query(
      "select (select count(*) from cl.night24_tm001_master) as master_count,(select count(*) from cl.night24_tm003_master_source_records) as source_record_count,(select count(*) from cl.night24_tm007_thumbnail_assets where thumbnail_status='collected') as thumbnails_collected,(select count(*) from cl.night24_tm002_owned_files) as owned_files,(select count(*) from cl.night24_tm005_unmatched_files where status='review_required') as unmatched_review"
    );

    say(JSON.stringify(result.rows[0]));
  });
}

async function main() {
  const args = argsFrom(process.argv);
  if (args.step === "init-db") await initDb(args);
  else if (args.step === "catalog-crawl") await crawl(args);
  else if (args.step === "catalog-sync") {
    if (!fs.existsSync(args.inputFile)) throw new Error("catalog_input_missing:" + args.inputFile);
    await syncCatalog(args);
  } else if (args.step === "thumbnails") await getThumbnails(args);
  else if (args.step === "status") await status(args);
  else throw new Error("unsupported_step:" + args.step);
}
main().catch((error) => {
  process.stderr.write(String(error.stack || error) + "\n");
  process.exitCode = 1;
});


