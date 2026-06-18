"use strict";

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const SOURCE = "tokyo_hot";
const DB_PREFIX = "tokyo_hot";
const MASTER_NO = "m008";
const MASTER_URL_EN = "https://my.tokyo-hot.com/product/?page={page}&vendor=Tokyo-Hot&lang=en";
const MASTER_URL_JA = "https://my.tokyo-hot.com/product/?page={page}&vendor=%E6%9D%B1%E7%86%B1&lang=ja";
const HIJAV_URL = "https://hijav.net/category/jav-uncensored/tokyo-hot/page/{page}/";
const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "storage", "thumbnails", SOURCE, "master");
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;
const THUMBNAIL_MIN_DELAY_MS = 500;
const THUMBNAIL_MAX_DELAY_MS = 1500;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const THUMBNAIL_TIMEOUT_MS = 30000;

function parseArgs(argv) {
  const args = { step: "status", startPage: 1, maxPages: 1, limit: 0, dryRun: false, envFile: "", expectPages: 0, minRows: 0, summaryOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--step") args.step = argv[++i];
    else if (arg.startsWith("--step=")) args.step = arg.slice(7);
    else if (arg === "--start-page") args.startPage = Number(argv[++i]);
    else if (arg.startsWith("--start-page=")) args.startPage = Number(arg.slice(13));
    else if (arg === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (arg.startsWith("--max-pages=")) args.maxPages = Number(arg.slice(12));
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice(8));
    else if (arg === "--expect-pages") args.expectPages = Number(argv[++i]);
    else if (arg.startsWith("--expect-pages=")) args.expectPages = Number(arg.slice(15));
    else if (arg === "--min-rows") args.minRows = Number(argv[++i]);
    else if (arg.startsWith("--min-rows=")) args.minRows = Number(arg.slice(11));
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--summary-only") args.summaryOnly = true;
    else if (arg === "--env-file") args.envFile = argv[++i];
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice(11);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnvFile(envFile) {
  const target = [envFile, path.resolve(__dirname, "..", "..", ".env")]
    .filter(Boolean).map((candidate) => path.resolve(candidate)).find((candidate) => fs.existsSync(candidate));
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
      if (config[name] === undefined) throw new Error(`Database ${name} is missing. Tried: ${keys.join(", ")}`);
    }
  }
  return new Client(config);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function delayMs() { return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)); }
function thumbnailDelayMs() { return THUMBNAIL_MIN_DELAY_MS + Math.floor(Math.random() * (THUMBNAIL_MAX_DELAY_MS - THUMBNAIL_MIN_DELAY_MS + 1)); }
function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function normalizeUrl(value, base) { try { return value ? new URL(value, base).toString() : ""; } catch { return ""; } }
function runId(label) { return `${SOURCE}_${label}_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}_${process.pid}`; }
function forceEnglishUrl(url) {
  return forceLanguageUrl(url, "en");
}

function forceJapaneseUrl(url) {
  return forceLanguageUrl(url, "ja");
}

function forceLanguageUrl(url, lang) {
  if (!url) return "";
  const parsed = new URL(url);
  parsed.searchParams.set("lang", lang);
  return parsed.toString();
}

function normalizeMovieCode(value) {
  const match = String(value || "").toLowerCase().match(/\bn[\s._-]*0*([0-9]{1,5})\b/);
  if (!match) return "";
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number <= 0) return "";
  return `n${String(number).padStart(4, "0")}`;
}

function numericCode(movieCode) {
  const match = String(movieCode || "").match(/^n0*([0-9]+)$/);
  return match ? Number(match[1]) : null;
}

async function fetchHtml(url) {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", "accept-language": "ja,en-US;q=0.9" } });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

function parseActorsFromDetail(html) {
  const $ = cheerio.load(html);
  const actors = [];
  $("dt").each((_, dt) => {
    const label = cleanText($(dt).text()).toLowerCase();
    if (label !== "model" && label !== "出演者") return;
    $(dt).next("dd").find("a").each((__, a) => {
      const name = cleanText($(a).text());
      if (name) actors.push(name);
    });
  });
  return [...new Set(actors)].join(", ");
}

async function collectMaster(args) {
  const isJapanese = args.step === "master-ja";
  const masterUrl = isJapanese ? MASTER_URL_JA : MASTER_URL_EN;
  const rows = [];
  const pageLogs = [];
  for (let pageOffset = 0; pageOffset < args.maxPages; pageOffset += 1) {
    const pageNumber = args.startPage + pageOffset;
    const pageUrl = masterUrl.replace("{page}", String(pageNumber));
    const pageRows = parseMasterListHtml(await fetchHtml(pageUrl), pageUrl, pageNumber, { language: isJapanese ? "ja" : "en" });
    for (const row of pageRows) {
      if (row.detail_url) {
        await sleep(delayMs());
        try {
          row.actor_name = parseActorsFromDetail(await fetchHtml(row.detail_url));
        } catch (error) {
          row.raw_payload.detail_error = String(error.message || error);
        }
      }
      rows.push(row);
      if (args.limit > 0 && rows.length >= args.limit) break;
    }
    pageLogs.push({ page_number: pageNumber, page_url: pageUrl, rows_found: pageRows.length });
    if (args.limit > 0 && rows.length >= args.limit) break;
    if (pageRows.length === 0) break;
    if (pageOffset < args.maxPages - 1) await sleep(delayMs());
  }
  validateMasterCompleteness(args, rows, pageLogs);
  if (!args.dryRun) {
    if (isJapanese) await insertJapaneseMasterRows(rows, args.maxPages, pageLogs);
    else await insertMasterRows(rows, args.maxPages, pageLogs);
  }
  return { rows, page_logs: pageLogs };
}

function parseMasterListHtml(html, pageUrl, pageNumber, options = {}) {
  const language = options.language || "en";
  const rows = [];
  const $ = cheerio.load(html);
  const seen = new Set();
  $("ul.list li.detail, li.detail").each((entryIndex, entry) => {
    const href = String($(entry).find("a.rm[href*='/product/'], a[href*='/product/']").first().attr("href") || "");
    const productText = cleanText($(entry).find(".description2 .actor").first().text());
    const movieCode = normalizeMovieCode(`${href} ${productText}`);
    if (!movieCode || seen.has(movieCode)) return;
    seen.add(movieCode);
    const img = $(entry).find("img").first();
    const title = cleanText($(entry).find(".description2 .title").first().text() || img.attr("alt") || movieCode);
    const thumb = normalizeUrl(img.attr("src"), pageUrl);
    const detailUrl = language === "ja" ? forceJapaneseUrl(normalizeUrl(href, pageUrl)) : forceEnglishUrl(normalizeUrl(href, pageUrl));
    rows.push({
      movie_code: movieCode,
      original_movie_code: movieCode,
      relation_key_mmddyy: movieCode,
      release_date: null,
      release_date_text: "",
      movie_code_suffix: String(numericCode(movieCode) || ""),
      numeric_code: numericCode(movieCode),
      title,
      actor_name: "",
      channel_name: "Tokyo-Hot",
      detail_url: detailUrl,
      thumbnail_url: thumb,
      source_page_url: pageUrl,
      page_number: pageNumber,
      row_index_in_page: entryIndex + 1,
      raw_payload: { href, product_text: productText, item_text: cleanText($(entry).text()), image_alt: cleanText(img.attr("alt") || "") },
    });
  });
  return rows;
}

async function insertJapaneseMasterRows(rows, pagesRequested, pageLogs) {
  const client = createPgClient();
  const id = runId("master_ja");
  await client.connect();
  try {
    await client.query("begin");
    await client.query(`insert into cl.${DB_PREFIX}_${MASTER_NO}_master_collect_runs (run_id,status,pages_requested,pages_processed,rows_collected) values ($1,'running',$2,$3,$4)`, [id, pagesRequested, pageLogs.length, rows.length]);
    for (const pageLog of pageLogs) {
      await client.query(`insert into cl.${DB_PREFIX}_${MASTER_NO}_master_page_logs (run_id,page_number,page_url,rows_found) values ($1,$2,$3,$4)`, [id, pageLog.page_number, pageLog.page_url, pageLog.rows_found]);
    }
    for (const row of rows) {
      const raw = await client.query(`
        insert into cl.${DB_PREFIX}_${MASTER_NO}_master_raw
          (relation_key_mmddyy,release_date,release_date_text,movie_code,original_movie_code,movie_code_suffix,numeric_code,title,title_ja,actor_name,actor_name_ja,channel_name,detail_url,thumbnail_url,source_page_url,page_number,row_index_in_page,raw_payload,last_run_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)
        on conflict (movie_code) do update set title_ja=excluded.title_ja,actor_name_ja=excluded.actor_name_ja,detail_url=coalesce(cl.${DB_PREFIX}_${MASTER_NO}_master_raw.detail_url, excluded.detail_url),
          thumbnail_url=coalesce(cl.${DB_PREFIX}_${MASTER_NO}_master_raw.thumbnail_url, excluded.thumbnail_url),source_page_url=excluded.source_page_url,page_number=excluded.page_number,
          row_index_in_page=excluded.row_index_in_page,raw_payload=cl.${DB_PREFIX}_${MASTER_NO}_master_raw.raw_payload || excluded.raw_payload,last_run_id=excluded.last_run_id,updated_at=now()
        returning id`, [row.relation_key_mmddyy, row.release_date, row.release_date_text, row.movie_code, row.original_movie_code, row.movie_code_suffix, row.numeric_code, row.title, row.title, row.actor_name || null, row.channel_name, row.detail_url, row.thumbnail_url, row.source_page_url, row.page_number, row.row_index_in_page, JSON.stringify({ ...row.raw_payload, language: "ja" }), id]);
      await client.query(`
        insert into cl.${DB_PREFIX}_${MASTER_NO}_master
          (movie_code,relation_key_mmddyy,release_date,release_date_text,original_movie_code,movie_code_suffix,numeric_code,title,title_ja,actor_name,actor_name_ja,channel_name,detail_url,thumbnail_url,raw_id,last_run_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null,$10,$11,$12,$13,$14,$15)
        on conflict (movie_code) do update set title_ja=excluded.title_ja,actor_name_ja=excluded.actor_name_ja,
          detail_url=coalesce(cl.${DB_PREFIX}_${MASTER_NO}_master.detail_url, excluded.detail_url),thumbnail_url=coalesce(cl.${DB_PREFIX}_${MASTER_NO}_master.thumbnail_url, excluded.thumbnail_url),
          numeric_code=coalesce(cl.${DB_PREFIX}_${MASTER_NO}_master.numeric_code, excluded.numeric_code),raw_id=excluded.raw_id,last_run_id=excluded.last_run_id,updated_at=now()`,
      [row.movie_code, row.relation_key_mmddyy, row.release_date, row.release_date_text, row.original_movie_code, row.movie_code_suffix, row.numeric_code, row.title, row.title, row.actor_name || null, row.channel_name, row.detail_url, row.thumbnail_url, raw.rows[0].id, id]);
    }
    await client.query(`update cl.${DB_PREFIX}_${MASTER_NO}_master_collect_runs set status='success', finished_at=now() where run_id=$1`, [id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

function validateMasterCompleteness(args, rows, pageLogs) {
  if (args.limit > 0) return;
  if (args.expectPages > 0 && pageLogs.length !== args.expectPages) throw new Error(`expected ${args.expectPages} pages, got ${pageLogs.length}`);
  if (args.minRows > 0 && rows.length < args.minRows) throw new Error(`expected at least ${args.minRows} rows, got ${rows.length}`);
}

async function insertMasterRows(rows, pagesRequested, pageLogs) {
  const client = createPgClient();
  const id = runId("master");
  await client.connect();
  try {
    await client.query("begin");
    await client.query(`insert into cl.${DB_PREFIX}_${MASTER_NO}_master_collect_runs (run_id,status,pages_requested,pages_processed,rows_collected) values ($1,'running',$2,$3,$4)`, [id, pagesRequested, pageLogs.length, rows.length]);
    for (const pageLog of pageLogs) {
      await client.query(`insert into cl.${DB_PREFIX}_${MASTER_NO}_master_page_logs (run_id,page_number,page_url,rows_found) values ($1,$2,$3,$4)`, [id, pageLog.page_number, pageLog.page_url, pageLog.rows_found]);
    }
    for (const row of rows) {
      const raw = await client.query(`
        insert into cl.${DB_PREFIX}_${MASTER_NO}_master_raw
          (relation_key_mmddyy,release_date,release_date_text,movie_code,original_movie_code,movie_code_suffix,numeric_code,title,actor_name,channel_name,detail_url,thumbnail_url,source_page_url,page_number,row_index_in_page,raw_payload,last_run_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
        on conflict (movie_code) do update set title=excluded.title,actor_name=excluded.actor_name,detail_url=excluded.detail_url,thumbnail_url=excluded.thumbnail_url,
          source_page_url=excluded.source_page_url,page_number=excluded.page_number,row_index_in_page=excluded.row_index_in_page,raw_payload=excluded.raw_payload,last_run_id=excluded.last_run_id,updated_at=now()
        returning id`, [row.relation_key_mmddyy, row.release_date, row.release_date_text, row.movie_code, row.original_movie_code, row.movie_code_suffix, row.numeric_code, row.title, row.actor_name || null, row.channel_name, row.detail_url, row.thumbnail_url, row.source_page_url, row.page_number, row.row_index_in_page, JSON.stringify(row.raw_payload), id]);
      await client.query(`
        insert into cl.${DB_PREFIX}_${MASTER_NO}_master
          (movie_code,relation_key_mmddyy,release_date,release_date_text,original_movie_code,movie_code_suffix,numeric_code,title,actor_name,channel_name,detail_url,thumbnail_url,raw_id,last_run_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        on conflict (movie_code) do update set title=excluded.title,actor_name=excluded.actor_name,detail_url=excluded.detail_url,thumbnail_url=excluded.thumbnail_url,
          numeric_code=excluded.numeric_code,raw_id=excluded.raw_id,last_run_id=excluded.last_run_id,updated_at=now()`,
      [row.movie_code, row.relation_key_mmddyy, row.release_date, row.release_date_text, row.original_movie_code, row.movie_code_suffix, row.numeric_code, row.title, row.actor_name || null, row.channel_name, row.detail_url, row.thumbnail_url, raw.rows[0].id, id]);
    }
    await client.query(`update cl.${DB_PREFIX}_${MASTER_NO}_master_collect_runs set status='success', finished_at=now() where run_id=$1`, [id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

function validateThumbnailUrl(url) {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && ["my.cdn.tokyo-hot.com", "my.tokyo-hot.com"].includes(parsed.hostname.toLowerCase());
}

async function download(url, outputPath) {
  if (!validateThumbnailUrl(url)) throw new Error("Unapproved thumbnail URL");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), THUMBNAIL_TIMEOUT_MS);
  const temp = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { "user-agent": "Mozilla/5.0", accept: "image/*" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!validateThumbnailUrl(response.url)) throw new Error("Unapproved redirected thumbnail URL");
    if (!String(response.headers.get("content-type") || "").startsWith("image/")) throw new Error("Unexpected content-type");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_THUMBNAIL_BYTES) throw new Error(`Invalid thumbnail bytes: ${bytes.length}`);
    fs.writeFileSync(temp, bytes, { flag: "wx" });
    fs.renameSync(temp, outputPath);
    return bytes.length;
  } finally {
    clearTimeout(timeout);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

async function collectThumbnails(args) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(`
      select master.movie_code, master.thumbnail_url
      from cl.${DB_PREFIX}_${MASTER_NO}_master master
      left join cl.${DB_PREFIX}_${MASTER_NO}_thumbnail_assets asset on asset.movie_code = master.movie_code
      where coalesce(master.thumbnail_url,'')<>''
        and coalesce(asset.thumbnail_status, 'pending') <> 'collected'
      order by master.numeric_code
      limit $1`, [args.limit > 0 ? args.limit : 100000]);
    if (args.dryRun) return result.rows;
    const summary = { collected: 0, existing: 0, failed: 0 };
    for (const row of result.rows) {
      try {
        const ext = ".jpg";
        const fileName = `${row.movie_code}${ext}`;
        const outputPath = path.join(OUTPUT_DIR, fileName);
        let bytes;
        if (fs.existsSync(outputPath)) {
          bytes = fs.statSync(outputPath).size;
          if (bytes <= 0) throw new Error(`Existing thumbnail is empty: ${outputPath}`);
          summary.existing += 1;
        } else {
          await sleep(thumbnailDelayMs());
          bytes = await download(row.thumbnail_url, outputPath);
          summary.collected += 1;
        }
        await client.query(`insert into cl.${DB_PREFIX}_${MASTER_NO}_thumbnail_assets (movie_code,thumbnail_url,local_thumbnail_path,local_thumbnail_file_name,thumbnail_status,bytes,last_checked_at,downloaded_at)
          values ($1,$2,$3,$4,'collected',$5,now(),now()) on conflict (movie_code) do update set thumbnail_url=excluded.thumbnail_url,local_thumbnail_path=excluded.local_thumbnail_path,
          local_thumbnail_file_name=excluded.local_thumbnail_file_name,thumbnail_status='collected',bytes=excluded.bytes,last_error=null,last_checked_at=now(),downloaded_at=now(),updated_at=now()`,
        [row.movie_code, row.thumbnail_url, outputPath, fileName, bytes]);
        await client.query(`update cl.${DB_PREFIX}_${MASTER_NO}_master set thumbnail_file_path=$2,updated_at=now() where movie_code=$1`, [row.movie_code, outputPath]);
      } catch (error) {
        summary.failed += 1;
        await client.query(`insert into cl.${DB_PREFIX}_${MASTER_NO}_thumbnail_assets (movie_code,thumbnail_url,thumbnail_status,last_error,last_checked_at) values ($1,$2,'failed',$3,now())
          on conflict (movie_code) do update set thumbnail_status='failed',last_error=excluded.last_error,last_checked_at=now(),updated_at=now()`, [row.movie_code, row.thumbnail_url, String(error.message || error)]);
      }
    }
    return summary;
  } finally {
    await client.end();
  }
}

function rapidgatorLinks($, root) {
  const links = [];
  const seen = new Set();
  $(root).find("a").each((_, a) => {
    const text = cleanText($(a).text());
    const href = String($(a).attr("href") || "");
    const match = `${text} ${href}`.match(/https?:\/\/rapidgator\.net\/file\/[^\s"'<>]+/i);
    if (!match || seen.has(match[0])) return;
    seen.add(match[0]);
    links.push({ rapidgator_url: match[0], link_href_url: href || match[0] });
  });
  return links;
}

function extractMovieCodeCandidates(...values) {
  const candidates = [];
  for (const value of values) {
    const text = String(value || "");
    for (const match of text.matchAll(/\bn[\s._-]*0*([0-9]{1,5})\b/gi)) {
      candidates.push(`n${String(Number(match[1])).padStart(4, "0")}`);
    }
  }
  return [...new Set(candidates)];
}

function resolutionVariant(...values) {
  const text = values.map((value) => String(value || "")).join(" ");
  if (/(^|[\s[(:_-])4k($|[\s\]):_-])/i.test(text)) return "4k";
  if (/(^|[\s[(:_-])(fhd|full\s*hd|1080p|720p|hd)($|[\s\]):_-])/i.test(text)) return "hd";
  return "unknown";
}

function isApprovedHijavUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "hijav.net";
  } catch {
    return false;
  }
}

async function fetchMasterResolver() {
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(`select movie_code from cl.${DB_PREFIX}_${MASTER_NO}_master`);
    return new Set(result.rows.map((row) => row.movie_code));
  } finally {
    await client.end();
  }
}

function resolveMovieCode(candidates, resolver) {
  const matches = candidates.filter((candidate) => resolver.has(candidate));
  if (matches.length === 1) return { movieCode: matches[0], matchReason: "exact" };
  if (matches.length > 1) return { movieCode: "", matchReason: "multiple_master_matches" };
  return { movieCode: candidates[0] || "", matchReason: candidates.length ? "missing_master" : "ignored_non_n" };
}

async function collectDl(args) {
  const resolver = await fetchMasterResolver();
  const id = runId("dl_reference");
  const rows = [];
  const pageLogs = [];
  for (let offset = 0; offset < args.maxPages; offset += 1) {
    const pageNumber = args.startPage + offset;
    const pageUrl = HIJAV_URL.replace("{page}", String(pageNumber));
    let html;
    try {
      html = await fetchHtml(pageUrl);
    } catch (error) {
      pageLogs.push({ page_number: pageNumber, page_url: pageUrl, status: "error", posts_found: 0, rows_found: 0, list_rg_found: 0, detail_fetch_count: 0, detail_rg_found: 0, error_message: error.message });
      break;
    }
    const $ = cheerio.load(html);
    const posts = $("div[id^='post-']").toArray();
    if (posts.length === 0) {
      pageLogs.push({ page_number: pageNumber, page_url: pageUrl, status: "terminal", posts_found: 0, rows_found: 0, list_rg_found: 0, detail_fetch_count: 0, detail_rg_found: 0, error_message: "No expected post elements found" });
      break;
    }
    let listRgFound = 0;
    let detailFetchCount = 0;
    let detailRgFound = 0;
    const pageRows = [];
    for (const post of posts) {
      const titleLink = $(post).find("h2 a, h3 a, a[rel='bookmark']").first();
      const title = cleanText(titleLink.attr("title") || titleLink.text());
      const detailUrl = normalizeUrl(titleLink.attr("href"), pageUrl);
      const postText = cleanText($(post).text());
      const candidates = extractMovieCodeCandidates(title, detailUrl, postText);
      const resolution = resolveMovieCode(candidates, resolver);
      let links = rapidgatorLinks($, post);
      let foundSource = links.length ? "list" : "none";
      if (links.length) listRgFound += 1;
      let detailText = "";
      if (!links.length && detailUrl && isApprovedHijavUrl(detailUrl)) {
        detailFetchCount += 1;
        await sleep(delayMs());
        try {
          const detail$ = cheerio.load(await fetchHtml(detailUrl));
          detailText = cleanText(detail$("body").text());
          links = rapidgatorLinks(detail$, "body");
          foundSource = links.length ? "detail" : "none";
          if (links.length) detailRgFound += 1;
        } catch {
          foundSource = "error";
        }
      }
      if (!links.length) links = [{ rapidgator_url: "", link_href_url: "" }];
      const variant = resolutionVariant(title, postText, detailText);
      for (const link of links) {
        const row = { movie_code: resolution.movieCode, title, detail_url: detailUrl, ...link, resolution_variant: variant, found_source: foundSource, has_rapidgator: Boolean(link.rapidgator_url), source_page_url: pageUrl, page_number: pageNumber, raw_payload: { candidates, match_reason: resolution.matchReason } };
        rows.push(row);
        pageRows.push(row);
      }
      if (args.limit > 0 && rows.length >= args.limit) break;
    }
    pageLogs.push({ page_number: pageNumber, page_url: pageUrl, status: "success", posts_found: posts.length, rows_found: pageRows.length, list_rg_found: listRgFound, detail_fetch_count: detailFetchCount, detail_rg_found: detailRgFound, error_message: "" });
    if (args.limit > 0 && rows.length >= args.limit) break;
    if (offset < args.maxPages - 1) await sleep(delayMs());
  }
  if (!args.dryRun) await insertDlRows(id, args, rows, pageLogs);
  return { run_id: id, rows, page_logs: pageLogs };
}

async function insertDlRows(id, args, rows, pageLogs) {
  const client = createPgClient();
  await client.connect();
  try {
    await client.query("begin");
    await client.query(`insert into cl.${DB_PREFIX}_dl_reference_runs (run_id,status,start_page,max_pages) values ($1,'running',$2,$3)`, [id, args.startPage, args.maxPages]);
    for (const pageLog of pageLogs) {
      await client.query(`insert into cl.${DB_PREFIX}_dl_reference_page_logs
        (run_id,page_number,page_url,status,posts_found,rows_found,list_rg_found,detail_fetch_count,detail_rg_found,error_message)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,nullif($10,''))`,
      [id, pageLog.page_number, pageLog.page_url, pageLog.status, pageLog.posts_found, pageLog.rows_found, pageLog.list_rg_found, pageLog.detail_fetch_count, pageLog.detail_rg_found, pageLog.error_message]);
    }
    for (const row of rows) {
      const status = row.raw_payload.match_reason === "ignored_non_n" ? "ignored" : row.found_source === "error" ? "error" : !row.has_rapidgator ? "no_rapidgator" : row.raw_payload.match_reason === "exact" ? "matched_master" : "missing_master";
      await client.query(`insert into cl.${DB_PREFIX}_dl_reference (movie_code,title,detail_url,rapidgator_url,link_href_url,resolution_variant,found_source,has_rapidgator,source_page_url,page_number,review_status,raw_payload)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
        on conflict ((coalesce(movie_code,'')),(coalesce(detail_url,'')),(coalesce(rapidgator_url,'')),resolution_variant) do update set title=excluded.title,link_href_url=excluded.link_href_url,
        found_source=excluded.found_source,has_rapidgator=excluded.has_rapidgator,source_page_url=excluded.source_page_url,page_number=excluded.page_number,review_status=excluded.review_status,raw_payload=excluded.raw_payload,last_seen_at=now(),updated_at=now()`,
      [row.movie_code || null, row.title, row.detail_url || null, row.rapidgator_url || null, row.link_href_url || null, row.resolution_variant, row.found_source, row.has_rapidgator, row.source_page_url, row.page_number, status, JSON.stringify(row.raw_payload)]);
    }
    const errorCount = pageLogs.filter((row) => row.status === "error").length + rows.filter((row) => row.found_source === "error").length;
    await client.query(`update cl.${DB_PREFIX}_dl_reference_runs set status=$2,finished_at=now(),pages_processed=$3,posts_found=$4,rows_written=$5,
      matched_master_count=$6,missing_master_count=$7,ignored_count=$8,no_rapidgator_count=$9,error_count=$10,error_message=$11 where run_id=$1`,
    [id, errorCount ? "error" : "success", pageLogs.filter((row) => row.status === "success").length, pageLogs.reduce((sum, row) => sum + row.posts_found, 0), rows.length,
      rows.filter((row) => row.has_rapidgator && row.raw_payload.match_reason === "exact").length,
      rows.filter((row) => row.has_rapidgator && row.raw_payload.match_reason === "missing_master").length,
      rows.filter((row) => row.raw_payload.match_reason === "ignored_non_n").length,
      rows.filter((row) => !row.has_rapidgator).length,
      errorCount,
      errorCount ? `DL reference collection has fetch errors: ${errorCount}` : null]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

async function initDb() {
  const client = createPgClient();
  await client.connect();
  try {
    await client.query(fs.readFileSync(path.resolve(__dirname, "..", "..", "ops", "sql", "140_tokyo_hot_site.sql"), "utf8"));
  } finally {
    await client.end();
  }
}

async function status() {
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(`select
      (select count(*)::integer from cl.${DB_PREFIX}_${MASTER_NO}_master) master_count,
      (select count(*)::integer from cl.${DB_PREFIX}_${MASTER_NO}_master_raw) raw_count,
      (select count(*)::integer from cl.${DB_PREFIX}_${MASTER_NO}_thumbnail_assets where thumbnail_status='collected') thumbnail_count,
      (select count(*)::integer from cl.${DB_PREFIX}_owned_file) owned_count,
      (select count(*)::integer from cl.${DB_PREFIX}_dl_reference) dl_reference_count,
      (select count(*)::integer from cl.${DB_PREFIX}_dl_reference where review_status='matched_master') dl_matched_master_count,
      (select count(*)::integer from cl.${DB_PREFIX}_dl_reference where resolution_variant='4k') dl_4k_count`);
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function seedCommonMasters() {
  const client = createPgClient();
  await client.connect();
  try {
    await client.query("begin");
    const siteResult = await client.query("select site_id from cl.site_master where site_code='tokyo_hot'");
    if (!siteResult.rowCount) throw new Error("site_master row is missing for tokyo_hot");
    const siteId = siteResult.rows[0].site_id;
    const actorResult = await client.query(`select distinct trim(value) actor_name, trim(value) actor_name_ja
      from cl.${DB_PREFIX}_${MASTER_NO}_master,
      lateral regexp_split_to_table(coalesce(nullif(actor_name_ja,''), actor_name, ''), '\\s*[,、/]\\s*') value
      where trim(value)<>''`);
    let groups = 0;
    let names = 0;
    for (const row of actorResult.rows) {
      const group = await client.query(`insert into cl.actor_group_master (group_code,representative_actor_name,representative_actor_name_ja,note)
        values ($1,$2,$3,'Seeded from Tokyo-Hot master') on conflict (group_code) do update set representative_actor_name=excluded.representative_actor_name,representative_actor_name_ja=excluded.representative_actor_name_ja,updated_at=now()
        returning actor_group_id`, [`tokyo_hot:${row.actor_name}`, row.actor_name, row.actor_name_ja || null]);
      groups += 1;
      const name = await client.query(`insert into cl.actor_name_master (actor_name,actor_name_ja,site_id,actor_group_id,note)
        values ($1,$2,$3,$4,'Seeded from Tokyo-Hot master') on conflict (site_id,actor_name) do update set actor_name_ja=excluded.actor_name_ja,actor_group_id=excluded.actor_group_id,updated_at=now()`,
      [row.actor_name, row.actor_name_ja || null, siteId, group.rows[0].actor_group_id]);
      names += name.rowCount;
    }
    await client.query("commit");
    return { actors_found: actorResult.rowCount, groups_processed: groups, names_processed: names };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  loadEnvFile(args.envFile);
  let result;
  if (args.step === "init-db") result = await initDb();
  else if (args.step === "master" || args.step === "master-ja") result = await collectMaster(args);
  else if (args.step === "thumbnails") result = await collectThumbnails(args);
  else if (args.step === "dl-reference") result = await collectDl(args);
  else if (args.step === "common-master") result = await seedCommonMasters();
  else if (args.step === "status") result = await status();
  else throw new Error(`Unsupported step: ${args.step}`);
  if (args.summaryOnly && result?.rows && result?.page_logs) {
    result = { rows_collected: result.rows.length, pages_processed: result.page_logs.length, page_logs: result.page_logs };
  }
  process.stdout.write(`${JSON.stringify({ ok: true, source: SOURCE, step: args.step, dry_run: args.dryRun, result }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
