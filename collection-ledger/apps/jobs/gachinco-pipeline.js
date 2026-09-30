"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cheerio = require("cheerio");
const {
  buildCatalogIndex,
  extractGachincoBundleCandidates,
  normalizeTitle,
} = require("../../packages/domain/src/gachinco-catalog");

const ROOT = path.resolve(__dirname, "..", "..");
const IMPORT_DIR = path.join(ROOT, "storage", "imports", "gachinco");
const THUMB_DIR = path.join(ROOT, "storage", "thumbnails", "gachinco", "master");
const DEFAULT_INPUT = path.join(IMPORT_DIR, "gachinco-catalog-latest.json");
const SOURCE_PAGES = { shiitake: 47, a_up: 12, neo: 77 };
const A_UP_ROWS_PER_PAGE = 36;
const ALLOWED_THUMB_HOSTS = new Set(["shiitake-taicho.com", "www.shiitake-taicho.com", "www.a-up.info"]);
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const args = { step: "", inputFile: DEFAULT_INPUT, outputFile: "", envFile: "", apply: false };
  for (let i = 2; i < argv.length; i++) {
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
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeUnder(file, base) {
  const target = path.resolve(file).toLowerCase();
  const root = path.resolve(base).toLowerCase();
  return target === root || target.startsWith(root + path.sep.toLowerCase());
}
function runId() { return new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + crypto.randomBytes(4).toString("hex"); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function pageUrl(source, page) {
  if (source === "shiitake") return "https://shiitake-taicho.com/maker/42/?maker=42&page=" + page;
  if (source === "a_up") return "https://www.a-up.info/avlady/series/index.php?ss=28772&pg=" + page;
  return "https://neo-adultmovie-revolution.com/db/movie_db/?site=" + encodeURIComponent("ガチん娘！") + "&page=" + page;
}

async function fetchHtml(url, referer, attempt = 1) {
  const parsed = new URL(url);
  const allowed = new Set(["shiitake-taicho.com", "www.shiitake-taicho.com", "www.a-up.info", "neo-adultmovie-revolution.com"]);
  if (parsed.protocol !== "https:" || !allowed.has(parsed.hostname)) throw new Error("catalog_host_not_allowed:" + parsed.hostname);
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ja,en-US;q=0.8,en;q=0.6",
      referer: referer || "https://www.google.com/",
    },
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) {
    if (attempt < 3 && [408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
      await delay(2000 * attempt);
      return fetchHtml(url, referer, attempt + 1);
    }
    throw new Error("catalog_http_" + response.status + ":" + url);
  }
  const html = await response.text();
  if (html.length < 1000) throw new Error("catalog_html_too_short:" + url);
  return html;
}

function sourceRowsFromShiitake(html, url, pageNumber) {
  const $ = cheerio.load(html);
  const rows = $("article.product-card").map((rowIndex, element) => {
    const card = $(element);
    const href = card.find('a[href*="/detail/"]').first().attr("href") || "";
    const image = card.find("img.product-card__image").first();
    const thumbnailUrl = image.attr("src") || image.attr("data-src") || image.attr("data-lazy-src") || "";
    return {
      source: "shiitake",
      sourceRecordId: href.match(/\/detail\/(\d+)\//)?.[1] || "",
      title: card.find(".product-card__title").first().text().replace(/\s+/g, " ").trim(),
      thumbnailUrl: thumbnailUrl ? new URL(thumbnailUrl, url).href : "",
      detailUrl: href ? new URL(href, url).href : "",
      sourcePage: url,
      pageNumber,
      rowIndex: rowIndex + 1,
      rawPayload: { cardText: card.text().replace(/\s+/g, " ").trim() },
    };
  }).get();
  if (!rows.length) throw new Error("shiitake_page_empty:" + pageNumber);
  return rows;
}

function sourceRowsFromAup(html, url, pageNumber) {
  const $ = cheerio.load(html);
  const cards = $("#movielist li");
  if (!cards.length) throw new Error("a_up_listing_container_missing:" + pageNumber);
  const rows = cards.map((rowIndex, element) => {
    const item = $(element);
    const input = item.find("input.mfa").first();
    const link = item.find('a[href*="/avlady/movie/video"]').first();
    const image = link.find("img").first();
    const id = String(input.attr("value") || "").trim() || String(input.attr("id") || "").match(/mck(\d+)/)?.[1] ||
      String(link.attr("href") || "").match(/video(\d+)/)?.[1] || "";
    const title = String(input.attr("data-tit") || item.find("em").first().text() || image.attr("alt") || "").replace(/\s+/g, " ").trim();
    const href = link.attr("href") || "";
    const thumbnailUrl = image.attr("src") || image.attr("data-src") || "";
    return {
      source: "a_up",
      sourceRecordId: id,
      title,
      thumbnailUrl: thumbnailUrl ? new URL(thumbnailUrl, url).href : "",
      detailUrl: href ? new URL(href, url).href : "",
      sourcePage: url,
      pageNumber,
      rowIndex: rowIndex + 1,
      constituentCandidates: extractGachincoBundleCandidates(title, "a_up", href ? new URL(href, url).href : "", thumbnailUrl ? new URL(thumbnailUrl, url).href : "", id),
      rawPayload: {
        actressAndDateText: item.find("span").first().text().replace(/\s+/g, " ").trim(),
        listingImageAlt: image.attr("alt") || "",
        listingImageDataId: input.attr("data-img") || "",
        sourceIdType: "a_up_detail_page_id",
        constituentCandidates: extractGachincoBundleCandidates(title, "a_up", href ? new URL(href, url).href : "", thumbnailUrl ? new URL(thumbnailUrl, url).href : "", id),
      },
    };
  }).get();
  const incomplete = rows.filter((row) => !row.sourceRecordId || !row.title || !row.detailUrl);
  if (!rows.length || incomplete.length) throw new Error("a_up_incomplete_cards:" + pageNumber + ":" + JSON.stringify(incomplete.map((row) => row.rowIndex)));
  if (rows.length !== A_UP_ROWS_PER_PAGE) throw new Error("a_up_unexpected_page_row_count:" + pageNumber + ":" + rows.length);
  return rows;
}

function neoSyntheticId(title, actors, releaseDate, pageNumber, rowIndex) {
  const input = [title, actors, releaseDate].join("\u001f");
  return "neo-" + crypto.createHash("sha256").update(input, "utf8").digest("hex").slice(0, 20);
}

function sourceRowsFromNeo(html, url, pageNumber) {
  const $ = cheerio.load(html);
  const cards = $(".panel-body .row.margin-bottom-2").filter((_, element) =>
    $(element).find(".col-md-2 img").length > 0
  );
  const rows = cards.map((rowIndex, element) => {
    const row = $(element);
    const titleColumn = row.find(".col-md-5").first();
    if (!titleColumn.length) throw new Error("neo_title_column_missing:" + pageNumber + ":" + (rowIndex + 1));
    const title = titleColumn.text().replace(/\s+/g, " ").trim();
    const actressColumn = row.find(".col-md-3").first();
    const actors = actressColumn.find("a").map((_, link) => $(link).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
    const date = row.find(".col-md-2.text-center").last().text().replace(/\s+/g, " ").trim();
    const site = row.find(".col-md-2 img").first().attr("alt") || "";
    const rowNumber = rowIndex + 1;
    if (!title || !date || !site) throw new Error("neo_incomplete_card:" + pageNumber + ":" + rowNumber);
    return {
      source: "neo",
      sourceRecordId: neoSyntheticId(title, actors.join(" / "), date, pageNumber, rowNumber),
      title,
      thumbnailUrl: "",
      detailUrl: "",
      sourcePage: url,
      pageNumber,
      rowIndex: rowNumber,
      rawPayload: {
        sourceIdType: "synthetic_page_row_content_hash",
        actors,
        releaseDate: date,
        listingSite: site,
        workThumbnailAvailable: false,
      },
    };
  }).get().filter(Boolean);
  if (!rows.length) throw new Error("neo_page_empty:" + pageNumber);
  return rows;
}

async function crawl(args) {
  const output = path.resolve(args.outputFile || DEFAULT_INPUT);
  if (!safeUnder(output, IMPORT_DIR) || path.extname(output).toLowerCase() !== ".json") {
    throw new Error("catalog_output_must_be_gachinco_import_json");
  }
  const result = { scrapedAt: new Date().toISOString(), rows: [], pageLogs: [] };
  const checkpointPath = path.join(IMPORT_DIR, "gachinco-catalog-progress-" + runId() + ".json");
  const parsers = { shiitake: sourceRowsFromShiitake, a_up: sourceRowsFromAup, neo: sourceRowsFromNeo };
  const neoDuplicateCounts = new Map();
  for (const [source, pageCount] of Object.entries(SOURCE_PAGES)) {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const url = pageUrl(source, pageNumber);
      const referer = pageNumber > 1 ? pageUrl(source, pageNumber - 1) : "https://www.google.com/";
      const html = await fetchHtml(url, referer);
      const pageRows = parsers[source](html, url, pageNumber);
      if (source === "neo") {
        for (const row of pageRows) {
          const baseId = row.sourceRecordId;
          const ordinal = (neoDuplicateCounts.get(baseId) || 0) + 1;
          neoDuplicateCounts.set(baseId, ordinal);
          if (ordinal > 1) {
            row.sourceRecordId = baseId + "-dup-" + ordinal;
            row.rawPayload.syntheticDuplicateOrdinal = ordinal;
          }
        }
      }
      result.rows.push(...pageRows);
      result.pageLogs.push({ source, pageNumber, pageUrl: url, rowsFound: pageRows.length });
      writeJson(checkpointPath, { crawlStatus: "running", ...result });
      say(source + " " + pageNumber + "/" + pageCount + ": " + pageRows.length);
      await delay(source === "shiitake" ? 1800 : 1200);
    }
  }
  const normalized = normalizeInput(result);
  writeJson(output, normalized);
  fs.rmSync(checkpointPath, { force: true });
  say("Saved " + normalized.rows.length + " source rows and " + normalized.pageLogs.length + " page logs: " + output);
}

function normalizeInput(raw) {
  if (!raw || !Array.isArray(raw.rows) || !Array.isArray(raw.pageLogs)) throw new Error("catalog_requires_rows_and_pageLogs");
  const rows = raw.rows.map((input, index) => {
    const row = { ...input };
    row.source = String(row.source || "").toLowerCase();
    row.sourceRecordId = String(row.sourceRecordId || "").trim();
    row.title = String(row.title || "").replace(/\s+/g, " ").trim();
    row.thumbnailUrl = String(row.thumbnailUrl || "");
    row.detailUrl = String(row.detailUrl || "");
    row.sourcePage = String(row.sourcePage || "");
    row.pageNumber = Number(row.pageNumber || 0);
    row.rowIndex = Number(row.rowIndex || index + 1);
    row.rawPayload = row.rawPayload && typeof row.rawPayload === "object" ? row.rawPayload : {};
    row.constituentCandidates = Array.isArray(row.rawPayload.constituentCandidates)
      ? row.rawPayload.constituentCandidates
      : (Array.isArray(row.constituentCandidates) ? row.constituentCandidates :
        extractGachincoBundleCandidates(row.title, row.source, row.detailUrl, row.thumbnailUrl, row.sourceRecordId));
    row.rawPayload.constituentCandidates = row.constituentCandidates;
    if (!Object.hasOwn(SOURCE_PAGES, row.source) || !row.sourceRecordId || !row.title || !row.sourcePage ||
      !Number.isInteger(row.pageNumber) || row.pageNumber < 1 || row.pageNumber > SOURCE_PAGES[row.source]) {
      throw new Error("catalog_row_incomplete:" + row.source + ":" + row.sourceRecordId);
    }
    if (row.source === "shiitake" && !row.thumbnailUrl) throw new Error("shiitake_thumbnail_missing:" + row.sourceRecordId);
    if (row.thumbnailUrl) {
      const image = new URL(row.thumbnailUrl);
      if (image.protocol !== "https:" || !ALLOWED_THUMB_HOSTS.has(image.hostname)) throw new Error("thumbnail_host_not_allowed:" + image.hostname);
    }
    return row;
  });
  const pages = new Map();
  for (const input of raw.pageLogs) {
    const source = String(input.source || input.source_code || "");
    const pageNumber = Number(input.pageNumber || input.page_number || 0);
    const pageUrlValue = String(input.pageUrl || input.page_url || "");
    const rowsFound = Number(input.rowsFound || input.rows_found || 0);
    if (!Object.hasOwn(SOURCE_PAGES, source) || !pageUrlValue || pageNumber < 1 || pageNumber > SOURCE_PAGES[source] ||
      !Number.isInteger(pageNumber) || rowsFound < 1) throw new Error("invalid_catalog_page_log:" + source + ":" + pageNumber);
    const key = source + ":" + pageNumber;
    if (pages.has(key)) throw new Error("duplicate_catalog_page:" + key);
    pages.set(key, { source, pageNumber, pageUrl: pageUrlValue, rowsFound });
  }
  for (const [source, pageCount] of Object.entries(SOURCE_PAGES)) {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      if (!pages.has(source + ":" + pageNumber)) throw new Error("catalog_page_missing:" + source + ":" + pageNumber);
    }
  }
  const pageRowTotals = new Map();
  const recordIds = new Set();
  for (const row of rows) {
    const identity = row.source + ":" + row.sourceRecordId;
    if (recordIds.has(identity)) throw new Error("duplicate_catalog_source_record:" + identity);
    recordIds.add(identity);
    const key = row.source + ":" + row.pageNumber;
    if (!pages.has(key)) throw new Error("catalog_row_page_missing:" + identity);
    pageRowTotals.set(key, (pageRowTotals.get(key) || 0) + 1);
  }
  for (const [key, page] of pages) {
    if (pageRowTotals.get(key) !== page.rowsFound) throw new Error("catalog_page_row_count_mismatch:" + key);
  }
  const counts = Object.fromEntries(Object.keys(SOURCE_PAGES).map((source) => [source, rows.filter((row) => row.source === source).length]));
  if (counts.shiitake < 1403 || counts.a_up !== SOURCE_PAGES.a_up * A_UP_ROWS_PER_PAGE || counts.neo < 1485) {
    throw new Error("catalog_volume_below_review_threshold:" + JSON.stringify(counts));
  }
  return { scrapedAt: raw.scrapedAt || new Date().toISOString(), rows, pageLogs: [...pages.values()], counts };
}

function loadCatalog(file) {
  const resolved = path.resolve(file);
  if (!safeUnder(resolved, IMPORT_DIR)) throw new Error("catalog_input_outside_gachinco_import_dir");
  const data = normalizeInput(readJson(resolved));
  return { data, index: buildCatalogIndex(data.rows) };
}

function loadEnv(file) {
  const candidates = [file, process.env.GACHINCO_ENV_FILE, "C:\\Users\\toyoaki\\Desktop\\filedatachange\\.env", path.join(ROOT, ".env")].filter(Boolean);
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
async function withDb(args, callback) {
  loadEnv(args.envFile);
  const db = createDbClient();
  await db.connect();
  try { return await callback(db); } finally { await db.end(); }
}

async function initializeDb(args) {
  const readMigration = (name) => fs.readFileSync(path.join(ROOT, "ops", "sql", name), "utf8").replace(/^\uFEFF/, "");
  if (!args.apply) {
    say("DRY-RUN init-db: additive Gachinco schema migrations are ready; use --apply to execute.");
    return;
  }
  await withDb(args, async (db) => {
    const existing = await db.query("select to_regclass('cl.gachinco_tm001_master') is not null as initialized, to_regclass('cl.gachinco_tm012_recognition_ids') is not null as recognition_initialized");
    const names = [
      ...(!existing.rows[0].initialized ? ["160_gachinco_site.sql"] : []),
      ...(!existing.rows[0].recognition_initialized ? ["161_gachinco_recognition_ids.sql"] : []),
      "162_gachinco_owned_actor_names.sql",
      // The newest source constraint migration is a superset of the prior
      // heydouga/gallery migrations. Reapplying those in order would narrow an
      // already upgraded catalog before reaching the newest source list.
      "165_gachinco_javhoo_source.sql",
    ];
    await db.query("begin");
    try {
      for (const name of names) await db.query(readMigration(name));
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
    const check = await db.query("select site_code,site_name from cl.site_master where site_code=$1", ["gachinco"]);
    if (check.rowCount !== 1 || check.rows[0].site_name !== "ガチん娘") throw new Error("gachinco_site_postcheck_failed");
  });
  say("Applied additive Gachinco migrations; site master postcheck passed.");
}

function masterForRow(index, row) {
  return row.movieCode ? index.masterByCode.get(row.movieCode) : null;
}

async function assignMissingRecognitionIds(db) {
  await db.query("lock table cl.gachinco_tm012_recognition_ids in share row exclusive mode");
  const [masters, mappings] = await Promise.all([
    db.query("select movie_code,title from cl.gachinco_tm001_master"),
    db.query("select movie_code,recognition_id from cl.gachinco_tm012_recognition_ids"),
  ]);
  const mappedCodes = new Set();
  const mappedIds = new Set();
  let maximum = 0;
  for (const row of mappings.rows) {
    const id = String(row.recognition_id || "");
    const match = id.match(/^gachi(\d{4,})$/);
    if (!match || mappedCodes.has(String(row.movie_code)) || mappedIds.has(id)) {
      throw new Error("invalid_existing_gachinco_recognition_mapping:" + id);
    }
    mappedCodes.add(String(row.movie_code));
    mappedIds.add(id);
    maximum = Math.max(maximum, Number(match[1]));
  }
  const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  const missing = masters.rows.filter((row) => !mappedCodes.has(String(row.movie_code))).slice()
    .sort((left, right) => collator.compare(String(left.title || ""), String(right.title || "")) ||
      String(left.movie_code).localeCompare(String(right.movie_code)));
  for (let index = 0; index < missing.length; index++) {
    const recognitionId = "gachi" + String(maximum + index + 1).padStart(4, "0");
    await db.query(
      "insert into cl.gachinco_tm012_recognition_ids (recognition_id,movie_code) values ($1,$2)",
      [recognitionId, missing[index].movie_code]
    );
  }
  return missing.length;
}

async function syncCatalog(args) {
  const { data, index } = loadCatalog(args.inputFile);
  const summary = {
    scrapedAt: data.scrapedAt,
    rows: data.rows.length,
    pages: data.pageLogs.length,
    sourceCounts: data.counts,
    masters: index.masters.length,
    unresolvedSourceRecords: index.rows.filter((row) => !row.movieCode).length,
    bundleAliases: index.rows.reduce((total, row) => total + row.constituentCandidates.length, 0),
  };
  say((args.apply ? "APPLY" : "DRY-RUN") + " catalog-sync " + JSON.stringify(summary));
  if (!args.apply) return;
  await withDb(args, async (db) => {
    const id = runId();
    await db.query("begin");
    try {
      await db.query(
        "insert into cl.gachinco_tl002_master_collect_runs (run_id,status,pages_requested,pages_processed,rows_collected,finished_at) values ($1,'running',$2,$2,$3,null)",
        [id, data.pageLogs.length, data.rows.length]
      );
      for (const master of index.masters) {
        await db.query(
          "insert into cl.gachinco_tm001_master (movie_code,canonical_key,normalized_title,title,series_name,title_source_code,title_source_record_id,detail_url,thumbnail_url,review_status,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'collected',now()) on conflict (canonical_key) do update set normalized_title=excluded.normalized_title,title=excluded.title,series_name=excluded.series_name,title_source_code=excluded.title_source_code,title_source_record_id=excluded.title_source_record_id,detail_url=excluded.detail_url,thumbnail_url=excluded.thumbnail_url,updated_at=now()",
          [master.movieCode, master.canonicalKey, master.normalizedTitle, master.title, master.seriesName || null, master.titleSourceCode, master.titleSourceRecordId, master.detailUrl || null, master.thumbnailUrl || null]
        );
      }
      const recognitionIdsAssigned = await assignMissingRecognitionIds(db);
      for (const page of data.pageLogs) {
        await db.query(
          "insert into cl.gachinco_tl003_master_page_logs (run_id,source_code,page_number,page_url,rows_found) values ($1,$2,$3,$4,$5)",
          [id, page.source, page.pageNumber, page.pageUrl, page.rowsFound]
        );
      }
      for (const row of index.rows) {
        const master = masterForRow(index, row);
        const sourcePayload = {
          ...row.rawPayload,
          constituentCandidates: row.constituentCandidates,
          candidateMovieCodes: row.rawPayload.candidateMovieCodes || [],
          sourceIdentityType: row.rawPayload.sourceIdType || (row.source === "shiitake" ? "shiitake_detail_id_provenance_only" : "source_page_provenance"),
        };
        await db.query(
          "insert into cl.gachinco_tm003_master_source_records (run_id,source_code,source_record_id,movie_code,canonical_key,source_title,normalized_title,series_name,detail_url,thumbnail_url,source_page_url,page_number,row_index,raw_payload,last_seen_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,now(),now()) on conflict (source_code,source_record_id) do update set run_id=excluded.run_id,movie_code=excluded.movie_code,canonical_key=excluded.canonical_key,source_title=excluded.source_title,normalized_title=excluded.normalized_title,series_name=excluded.series_name,detail_url=excluded.detail_url,thumbnail_url=excluded.thumbnail_url,source_page_url=excluded.source_page_url,page_number=excluded.page_number,row_index=excluded.row_index,raw_payload=excluded.raw_payload,last_seen_at=now(),updated_at=now()",
          [id, row.source, row.sourceRecordId, master?.movieCode || null, row.canonicalKey || ("unresolved:" + row.source + ":" + row.sourceRecordId), row.title, normalizeTitle(row.title), "ガチん娘", row.detailUrl || null, row.thumbnailUrl || null, row.sourcePage, row.pageNumber, row.rowIndex, JSON.stringify(sourcePayload)]
        );
      }
      const counts = await db.query(
        "select (select count(*) from cl.gachinco_tm001_master)::integer as masters,(select count(*) from cl.gachinco_tm003_master_source_records)::integer as source_records,(select count(*) from cl.gachinco_tl003_master_page_logs where run_id=$1)::integer as page_logs",
        [id]
      );
      if (counts.rows[0].masters < index.masters.length || counts.rows[0].source_records < data.rows.length || counts.rows[0].page_logs !== data.pageLogs.length) {
        throw new Error("gachinco_catalog_postcheck_failed:" + JSON.stringify(counts.rows[0]));
      }
      const recognitionCheck = await db.query(
        "select (select count(*) from cl.gachinco_tm001_master)::integer as masters,(select count(*) from cl.gachinco_tm012_recognition_ids)::integer as mapped,(select count(distinct recognition_id) from cl.gachinco_tm012_recognition_ids)::integer as unique_ids,(select count(*) from cl.gachinco_tm001_master master left join cl.gachinco_tm012_recognition_ids ids on ids.movie_code=master.movie_code where ids.movie_code is null)::integer as missing"
      );
      const recognition = recognitionCheck.rows[0];
      if (recognition.masters !== recognition.mapped || recognition.mapped !== recognition.unique_ids || recognition.missing !== 0) {
        throw new Error("gachinco_recognition_id_postcheck_failed:" + JSON.stringify(recognition));
      }
      await db.query("update cl.gachinco_tl002_master_collect_runs set status='completed',masters_written=$2,finished_at=now() where run_id=$1", [id, index.masters.length]);
      await db.query("commit");
      say("Catalog DB postcheck passed: " + JSON.stringify({ ...counts.rows[0], recognitionIdsAssigned, recognition }));
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

async function collectThumbnails(args) {
  const { data, index } = loadCatalog(args.inputFile);
  const tasks = index.masters;
  say((args.apply ? "APPLY" : "DRY-RUN") + " thumbnails " + JSON.stringify({ masters: tasks.length, withThumbnail: tasks.filter((master) => master.thumbnailUrl).length, withoutThumbnail: tasks.filter((master) => !master.thumbnailUrl).length }));
  if (!args.apply) return;
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  await withDb(args, async (db) => {
    let collected = 0;
    let failed = 0;
    let skipped = 0;
    let unavailable = 0;
    for (const master of tasks) {
      const currentResult = await db.query(
        "select thumbnail_status,attempt_count,local_thumbnail_path from cl.gachinco_tm007_thumbnail_assets where movie_code=$1",
        [master.movieCode]
      );
      const current = currentResult.rows[0] || { thumbnail_status: "pending", attempt_count: 0, local_thumbnail_path: null };
      if (current.thumbnail_status === "collected" && current.local_thumbnail_path &&
        safeUnder(current.local_thumbnail_path, THUMB_DIR) && fs.existsSync(current.local_thumbnail_path)) {
        const existing = fs.readFileSync(current.local_thumbnail_path);
        if (imageExtension(existing)) { skipped++; continue; }
      }
      const initialAttempts = Number(current.attempt_count || 0);
      if (initialAttempts >= 3) { skipped++; continue; }
      const candidates = [];
      const candidateUrls = new Set();
      for (const row of [master.thumbnailSourceRecord, ...master.sourceRows].filter(Boolean)
        .sort((left, right) => sourcePriority(left.source) - sourcePriority(right.source))) {
        if (!row.thumbnailUrl || candidateUrls.has(row.thumbnailUrl)) continue;
        candidateUrls.add(row.thumbnailUrl);
        candidates.push(row);
      }
      if (!candidates.length) { unavailable++; continue; }

      let image = recoverThumbnail(master.movieCode, candidates);
      let failures = 0;
      let lastError = "";
      if (!image) {
        for (const candidate of candidates) {
          if (initialAttempts + failures >= 3) break;
          try {
            image = await fetchThumbnail(candidate.thumbnailUrl);
            image.source = candidate;
            break;
          } catch (error) {
            failures++;
            lastError = String(error.message || error).slice(0, 900);
            await delay(250);
          }
        }
      }
      if (!image) {
        failed++;
        const attempts = Math.min(3, initialAttempts + failures);
        await db.query(
          "insert into cl.gachinco_tm007_thumbnail_assets (movie_code,thumbnail_url,thumbnail_status,attempt_count,last_error,last_checked_at,updated_at) values ($1,$2,'failed',$3,$4,now(),now()) on conflict (movie_code) do update set thumbnail_status='failed',attempt_count=excluded.attempt_count,last_error=excluded.last_error,last_checked_at=now(),updated_at=now()",
          [master.movieCode, master.thumbnailUrl || candidates[0].thumbnailUrl, attempts, lastError || "No valid image candidate after bounded attempts."]
        );
        continue;
      }

      const finalPath = image.finalPath || path.join(THUMB_DIR, master.movieCode + image.extension);
      const intentPath = image.intentPath || thumbnailIntentPath(finalPath);
      if (!image.recovered) {
        if (fs.existsSync(finalPath)) throw new Error("thumbnail_path_collision:" + finalPath);
        const tempPath = finalPath + "." + crypto.randomBytes(5).toString("hex") + ".part";
        const intentTemp = intentPath + "." + crypto.randomBytes(5).toString("hex") + ".part";
        const intent = {
          version: 1,
          movie_code: master.movieCode,
          final_path: finalPath,
          extension: image.extension,
          bytes: image.data.length,
          sha256: crypto.createHash("sha256").update(image.data).digest("hex"),
          source: image.source,
          created_at: new Date().toISOString(),
        };
        durableWrite(tempPath, image.data);
        durableWrite(intentTemp, JSON.stringify(intent, null, 2) + "\n");
        fs.renameSync(intentTemp, intentPath);
        fs.renameSync(tempPath, finalPath);
      }
      const successfulAttempts = Math.min(3, Math.max(1, initialAttempts + failures + (image.recovered ? 0 : 1)));
      await db.query("begin");
      try {
        await db.query(
          "update cl.gachinco_tm001_master set thumbnail_url=$2,thumbnail_file_path=$3,updated_at=now() where movie_code=$1",
          [master.movieCode, image.source.thumbnailUrl, finalPath]
        );
        await db.query(
          "insert into cl.gachinco_tm007_thumbnail_assets (movie_code,thumbnail_url,local_thumbnail_path,local_thumbnail_file_name,thumbnail_status,attempt_count,bytes,last_error,last_checked_at,downloaded_at,updated_at) values ($1,$2,$3,$4,'collected',$5,$6,null,now(),now(),now()) on conflict (movie_code) do update set thumbnail_url=excluded.thumbnail_url,local_thumbnail_path=excluded.local_thumbnail_path,local_thumbnail_file_name=excluded.local_thumbnail_file_name,thumbnail_status='collected',attempt_count=excluded.attempt_count,bytes=excluded.bytes,last_error=null,last_checked_at=now(),downloaded_at=now(),updated_at=now()",
          [master.movieCode, image.source.thumbnailUrl, finalPath, path.basename(finalPath), successfulAttempts, image.data.length]
        );
        await db.query("commit");
      } catch (error) {
        await db.query("rollback");
        throw error;
      }
      if (fs.existsSync(intentPath)) fs.rmSync(intentPath);
      collected++;
      if ((collected + failed + skipped + unavailable) % 25 === 0) {
        say("Thumbnail progress " + (collected + failed + skipped + unavailable) + "/" + tasks.length + " collected=" + collected + " failed=" + failed + " skipped=" + skipped + " unavailable=" + unavailable);
      }
      await delay(300);
    }
    const count = await db.query("select count(*)::integer as collected from cl.gachinco_tm007_thumbnail_assets where thumbnail_status='collected'");
    say("Thumbnail result " + JSON.stringify({ selected: tasks.length, collected, failed, skipped, unavailable, totalCollected: count.rows[0].collected }));
  });
}

function sourcePriority(source) { return ({ shiitake: 0, a_up: 1, neo: 2 })[source] ?? 99; }
function imageExtension(buffer) {
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return ".jpg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  return "";
}
async function fetchThumbnail(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_THUMB_HOSTS.has(url.hostname.toLowerCase())) throw new Error("thumbnail_host_blocked:" + url.hostname);
  const response = await fetch(url.href, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("thumbnail_http_" + response.status);
  if (Number(response.headers.get("content-length") || 0) > 10 * 1024 * 1024) throw new Error("thumbnail_over_10mb");
  const data = Buffer.from(await response.arrayBuffer());
  const extension = imageExtension(data);
  if (!data.length || data.length > 10 * 1024 * 1024 || !extension) throw new Error("thumbnail_signature_or_size_invalid");
  return { data, extension };
}
function thumbnailIntentPath(finalPath) { return finalPath + ".intent.json"; }
function durableWrite(file, data) {
  const fd = fs.openSync(file, "wx");
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function matchingThumbnailSource(candidates, source) {
  return candidates.find((candidate) => candidate.source === source.source &&
    String(candidate.sourceRecordId) === String(source.sourceRecordId) && candidate.thumbnailUrl === source.thumbnailUrl && candidate.title === source.title) || null;
}
function recoverThumbnail(movieCode, candidates) {
  for (const extension of [".jpg", ".png", ".webp"]) {
    const finalPath = path.join(THUMB_DIR, movieCode + extension);
    if (!fs.existsSync(finalPath)) continue;
    const intentPath = thumbnailIntentPath(finalPath);
    if (!fs.existsSync(intentPath)) throw new Error("thumbnail_path_collision_without_recovery_record:" + finalPath);
    let intent;
    try { intent = readJson(intentPath); } catch { throw new Error("thumbnail_recovery_record_invalid:" + intentPath); }
    if (intent.version !== 1 || intent.movie_code !== movieCode || path.resolve(intent.final_path) !== path.resolve(finalPath) || intent.extension !== extension) {
      throw new Error("thumbnail_recovery_record_mismatch:" + finalPath);
    }
    const source = matchingThumbnailSource(candidates, intent.source || {});
    if (!source) throw new Error("thumbnail_recovery_source_not_in_catalog:" + movieCode);
    const data = fs.readFileSync(finalPath);
    if (!data.length || data.length > 10 * 1024 * 1024 || data.length !== Number(intent.bytes) || imageExtension(data) !== extension ||
      crypto.createHash("sha256").update(data).digest("hex") !== intent.sha256) throw new Error("thumbnail_recovery_file_validation_failed:" + finalPath);
    return { data, extension, source, recovered: true, finalPath, intentPath };
  }
  return null;
}

async function status(args) {
  await withDb(args, async (db) => {
    const counts = await db.query(
      "select (select count(*) from cl.gachinco_tm001_master)::integer as masters,(select count(*) from cl.gachinco_tm003_master_source_records)::integer as source_records,(select count(*) from cl.gachinco_tm003_master_source_records where movie_code is null)::integer as unresolved_source_records,(select count(*) from cl.gachinco_tm007_thumbnail_assets where thumbnail_status='collected')::integer as thumbnails"
    );
    say(JSON.stringify(counts.rows[0]));
  });
}

function sameWorkThumbnailCandidates(target, index) {
  const key = normalizeTitle(target.title);
  if (key.length < 6 || target.sourceRows.some((row) => row.source !== "neo")) return [];
  return index.masters.filter((candidate) => {
    if (candidate.movieCode === target.movieCode || !candidate.thumbnailUrl) return false;
    const titleKey = normalizeTitle(candidate.title);
    const offset = titleKey.indexOf(key);
    if (offset < 0) return false;
    const suffix = titleKey.slice(offset + key.length);
    if (/\d$/.test(key) && /^\d/.test(suffix)) return false;
    if (/part\d|時間スペシャル/.test(suffix)) return false;
    return true;
  });
}

async function reconcileThumbnails(args) {
  const { index } = loadCatalog(args.inputFile);
  const exportDir = path.join(ROOT, "storage", "exports", "gachinco");
  fs.mkdirSync(exportDir, { recursive: true });
  await withDb(args, async (db) => {
    const owned = await db.query("select distinct movie_code from cl.gachinco_tm002_owned_files");
    const ownedCodes = new Set(owned.rows.map((row) => row.movie_code));
    const assets = await db.query("select movie_code,local_thumbnail_path,thumbnail_status,bytes from cl.gachinco_tm007_thumbnail_assets");
    const assetByCode = new Map(assets.rows.map((row) => [row.movie_code, row]));
    const proposals = [];
    for (const target of index.masters) {
      if (!ownedCodes.has(target.movieCode) || target.thumbnailUrl) continue;
      const existing = assetByCode.get(target.movieCode);
      if (existing?.thumbnail_status === "collected" && existing.local_thumbnail_path) continue;
      const candidates = sameWorkThumbnailCandidates(target, index);
      if (candidates.length !== 1) continue;
      const donor = candidates[0], asset = assetByCode.get(donor.movieCode);
      if (asset?.thumbnail_status !== "collected" || !asset.local_thumbnail_path ||
        !safeUnder(asset.local_thumbnail_path, THUMB_DIR) || !fs.existsSync(asset.local_thumbnail_path) ||
        !imageExtension(fs.readFileSync(asset.local_thumbnail_path))) continue;
      proposals.push({ movieCode: target.movieCode, title: target.title,
        donorCode: donor.movieCode, donorTitle: donor.title, donorUrl: donor.thumbnailUrl,
        localPath: asset.local_thumbnail_path, bytes: Number(asset.bytes || fs.statSync(asset.local_thumbnail_path).size) });
    }
    const output = args.outputFile || path.join(exportDir, "gachinco-thumbnail-reconcile-" + new Date().toISOString().replace(/[-:.TZ]/g, "") + ".json");
    if (!safeUnder(output, exportDir)) throw new Error("thumbnail_reconcile_output_outside_export_dir");
    fs.writeFileSync(output, JSON.stringify({ applied: args.apply, candidates: proposals }, null, 2) + "\n", "utf8");
    if (args.apply) {
      await db.query("begin");
      try {
        for (const row of proposals) {
          await db.query("update cl.gachinco_tm001_master set thumbnail_url=$2,thumbnail_file_path=$3,updated_at=now() where movie_code=$1 and coalesce(thumbnail_file_path,'')=''", [row.movieCode, row.donorUrl, row.localPath]);
          await db.query("insert into cl.gachinco_tm007_thumbnail_assets (movie_code,thumbnail_url,local_thumbnail_path,local_thumbnail_file_name,thumbnail_status,attempt_count,bytes,last_error,last_checked_at,downloaded_at,updated_at) values ($1,$2,$3,$4,'collected',1,$5,null,now(),now(),now()) on conflict (movie_code) do update set thumbnail_url=excluded.thumbnail_url,local_thumbnail_path=excluded.local_thumbnail_path,local_thumbnail_file_name=excluded.local_thumbnail_file_name,thumbnail_status='collected',bytes=excluded.bytes,last_error=null,last_checked_at=now(),updated_at=now() where cl.gachinco_tm007_thumbnail_assets.thumbnail_status <> 'collected'", [row.movieCode, row.donorUrl, row.localPath, path.basename(row.localPath), row.bytes]);
        }
        await db.query("commit");
      } catch (error) { await db.query("rollback"); throw error; }
    }
    say((args.apply ? "APPLY" : "DRY-RUN") + " thumbnail reconciliation=" + proposals.length + " output=" + output);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.step === "crawl") await crawl(args);
  else if (args.step === "init-db") await initializeDb(args);
  else if (args.step === "catalog-sync") await syncCatalog(args);
  else if (args.step === "thumbnails") await collectThumbnails(args);
  else if (args.step === "thumbnail-reconcile") await reconcileThumbnails(args);
  else if (args.step === "status") await status(args);
  else throw new Error("unknown_step:" + args.step);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String(error.stack || error) + "\n");
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeInput,
  pageUrl,
  sourceRowsFromAup,
  sourceRowsFromNeo,
  sourceRowsFromShiitake,
};
