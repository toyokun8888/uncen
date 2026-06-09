"use strict";

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const SOURCE = "heyzo";
const DB_PREFIX = "heyzo";
const MASTER_URL = "https://www.heyzo.com/listpages/all_{page}.html";
const HIJAV_URL = "https://hijav.net/category/jav-uncensored/heyzo/page/{page}/";
const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "storage", "thumbnails", SOURCE, "master");
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;
const THUMBNAIL_MIN_DELAY_MS = 500;
const THUMBNAIL_MAX_DELAY_MS = 1500;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const THUMBNAIL_TIMEOUT_MS = 30000;

function parseArgs(argv) {
  const args = { step: "status", startPage: 1, maxPages: 1, limit: 0, dryRun: false, envFile: "" };
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
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--env-file") args.envFile = argv[++i];
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice(11);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnvFile(envFile) {
  const target = [envFile, path.resolve(__dirname, "..", "..", ".env")]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => fs.existsSync(candidate));
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
      if (config[name] === undefined) {
        throw new Error(`Database ${name} is missing. Tried: ${keys.join(", ")} in --env-file or process environment.`);
      }
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

function normalizeMovieNumber(value) {
  const match = String(value || "").match(/([0-9]{1,6})/);
  if (!match) return "";
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? String(number) : "";
}

function normalizeMovieCode(value) {
  const number = normalizeMovieNumber(value);
  return number ? `heyzo-${number}` : "";
}

function movieNumber(movieCode) {
  return normalizeMovieNumber(movieCode);
}

function pageUrl(pageNumber) {
  return MASTER_URL.replace("{page}", String(pageNumber));
}

function parseReleaseDate(value) {
  const text = cleanText(String(value || "").replace(/\//g, "-"));
  const match = text.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:\s*[–-]\s*[0-9]{4}-[0-9]{2}-[0-9]{2})?$/);
  return { releaseDate: match ? match[1] : null, releaseDateText: text };
}

async function collectMaster(args) {
  const rows = [];
  const pageLogs = [];
  for (let offset = 0; offset < args.maxPages; offset += 1) {
    const pageNumber = args.startPage + offset;
    const sourcePageUrl = pageUrl(pageNumber);
    const html = await fetchHtml(sourcePageUrl);
    const pageRows = parseMasterPage(html, sourcePageUrl, pageNumber);
    for (const row of pageRows) {
      rows.push(row);
      if (args.limit > 0 && rows.length >= args.limit) break;
    }
    pageLogs.push({ page_number: pageNumber, page_url: sourcePageUrl, rows_found: pageRows.length });
    if (args.limit > 0 && rows.length >= args.limit) break;
    if (pageRows.length === 0) break;
    if (offset < args.maxPages - 1) await sleep(delayMs());
  }
  if (!args.dryRun) await insertMasterRows(rows, args.maxPages, pageLogs);
  return { rows, page_logs: pageLogs };
}

function parseMasterPage(html, sourcePageUrl, pageNumber) {
  const $ = cheerio.load(html);
  const rows = [];
  $(".movie[data-movie-id]").each((index, element) => {
    const movieId = cleanText($(element).attr("data-movie-id"));
    const movieCode = normalizeMovieCode(movieId);
    const link = $(element).find('a[href*="/moviepages/"]').first();
    const image = $(element).find("img[data-original], img[data-member-original], img[title]").first();
    const releaseText = cleanText($(element).find("p.release").first().text()).replace(/^公開日:\s*/, "");
    const release = parseReleaseDate(releaseText);
    const actorName = cleanText($(element).find("a.actor").first().text());
    const actorType = cleanText($(element).find("[class*='actor-type']").first().text());
    const title = cleanText(image.attr("title") || link.attr("title") || link.text());
    const detailUrl = normalizeUrl(link.attr("href"), sourcePageUrl);
    const thumbnailUrl = normalizeUrl(image.attr("data-original") || image.attr("src"), sourcePageUrl);
    if (!movieCode || !title) return;
    rows.push({
      movie_code: movieCode,
      relation_key_mmddyy: movieNumber(movieCode),
      release_date: release.releaseDate,
      release_date_text: release.releaseDateText,
      movie_code_suffix: movieId,
      title,
      actor_name: actorName,
      channel_name: "HEYZO",
      detail_url: detailUrl,
      thumbnail_url: thumbnailUrl,
      source_page_url: sourcePageUrl,
      page_number: pageNumber,
      row_index_in_page: index + 1,
      raw_payload: {
        movie_id: movieId,
        actor_type: actorType,
        detail_url: detailUrl,
        thumbnail_url: thumbnailUrl,
        source_page_url: sourcePageUrl,
        page_number: pageNumber,
        row_index_in_page: index + 1,
        raw_html: $.html(element),
      },
    });
  });
  return rows;
}

async function insertMasterRows(rows, pagesRequested, pageLogs) {
  const client = createPgClient();
  const id = runId("master");
  await client.connect();
  try {
    await client.query("begin");
    await client.query(`insert into cl.${DB_PREFIX}_m004_master_collect_runs (run_id,status,pages_requested,pages_processed,rows_collected) values ($1,'running',$2,$3,$4)`, [id, pagesRequested, pageLogs.length, rows.length]);
    for (const pageLog of pageLogs) {
      await client.query(`insert into cl.${DB_PREFIX}_m004_master_page_logs (run_id,page_number,page_url,rows_found) values ($1,$2,$3,$4)`,
        [id, pageLog.page_number, pageLog.page_url, pageLog.rows_found]);
    }
    for (const row of rows) {
      const raw = await client.query(`
        insert into cl.${DB_PREFIX}_m004_master_raw
          (relation_key_mmddyy,release_date,release_date_text,movie_code,movie_code_suffix,title,actor_name,channel_name,detail_url,thumbnail_url,source_page_url,page_number,row_index_in_page,raw_payload,last_run_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
        on conflict (movie_code) do update set release_date=excluded.release_date, release_date_text=excluded.release_date_text, relation_key_mmddyy=excluded.relation_key_mmddyy,
          movie_code_suffix=excluded.movie_code_suffix,title=excluded.title,actor_name=excluded.actor_name,detail_url=excluded.detail_url,
          thumbnail_url=excluded.thumbnail_url,source_page_url=excluded.source_page_url,page_number=excluded.page_number,
          row_index_in_page=excluded.row_index_in_page,raw_payload=excluded.raw_payload,last_run_id=excluded.last_run_id,updated_at=now()
        returning id`, [row.relation_key_mmddyy, row.release_date, row.release_date_text, row.movie_code, row.movie_code_suffix, row.title, row.actor_name || null, row.channel_name, row.detail_url, row.thumbnail_url, row.source_page_url, row.page_number, row.row_index_in_page, JSON.stringify(row.raw_payload), id]);
      await client.query(`
        insert into cl.${DB_PREFIX}_m004_master
          (movie_code,relation_key_mmddyy,release_date,release_date_text,movie_code_suffix,title,actor_name,channel_name,detail_url,thumbnail_url,raw_id,last_run_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        on conflict (movie_code) do update set relation_key_mmddyy=excluded.relation_key_mmddyy,release_date=excluded.release_date,release_date_text=excluded.release_date_text,
          movie_code_suffix=excluded.movie_code_suffix,title=excluded.title,actor_name=excluded.actor_name,channel_name=excluded.channel_name,
          detail_url=excluded.detail_url,thumbnail_url=excluded.thumbnail_url,raw_id=excluded.raw_id,last_run_id=excluded.last_run_id,updated_at=now()`,
      [row.movie_code, row.relation_key_mmddyy, row.release_date, row.release_date_text, row.movie_code_suffix, row.title, row.actor_name || null, row.channel_name, row.detail_url, row.thumbnail_url, raw.rows[0].id, id]);
    }
    await client.query(`update cl.${DB_PREFIX}_m004_master_collect_runs set status='success', finished_at=now() where run_id=$1`, [id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { await client.end(); }
}

function validateThumbnailUrl(url) {
  const parsed = new URL(url);
  return parsed.protocol === "https:" &&
    ["www.heyzo.com", "heyzo.com"].includes(parsed.hostname) &&
    (parsed.pathname.startsWith("/contents/3000/") || parsed.pathname.startsWith("/member/contents/3000/"));
}

async function download(url, outputPath) {
  if (!validateThumbnailUrl(url)) throw new Error("Unapproved thumbnail URL");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), THUMBNAIL_TIMEOUT_MS);
  const temp = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0", accept: "image/*" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
    const result = await client.query(`select movie_code, thumbnail_url from cl.${DB_PREFIX}_m004_master where coalesce(thumbnail_url,'')<>'' order by movie_code limit $1`, [args.limit > 0 ? args.limit : 100000]);
    if (args.dryRun) return result.rows;
    const summary = { collected: 0, existing: 0, failed: 0 };
    for (const row of result.rows) {
      const ext = [".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(new URL(row.thumbnail_url).pathname).toLowerCase()) ? path.extname(new URL(row.thumbnail_url).pathname).toLowerCase() : ".jpg";
      const fileName = `${row.movie_code}${ext}`;
      const outputPath = path.join(OUTPUT_DIR, fileName);
      try {
        let bytes;
        if (fs.existsSync(outputPath)) {
          bytes = fs.statSync(outputPath).size;
          if (bytes <= 0) throw new Error(`Existing thumbnail is empty: ${outputPath}`);
          summary.existing += 1;
        }
        else { await sleep(thumbnailDelayMs()); bytes = await download(row.thumbnail_url, outputPath); summary.collected += 1; }
        await client.query(`insert into cl.${DB_PREFIX}_m004_thumbnail_assets (movie_code,thumbnail_url,local_thumbnail_path,local_thumbnail_file_name,thumbnail_status,bytes,last_checked_at,downloaded_at)
          values ($1,$2,$3,$4,'collected',$5,now(),now()) on conflict (movie_code) do update set thumbnail_url=excluded.thumbnail_url,local_thumbnail_path=excluded.local_thumbnail_path,
          local_thumbnail_file_name=excluded.local_thumbnail_file_name,thumbnail_status='collected',bytes=excluded.bytes,last_error=null,last_checked_at=now(),downloaded_at=now(),updated_at=now()`,
        [row.movie_code, row.thumbnail_url, outputPath, fileName, bytes]);
        await client.query(`update cl.${DB_PREFIX}_m004_master set thumbnail_file_path=$2,updated_at=now() where movie_code=$1`, [row.movie_code, outputPath]);
      } catch (error) {
        summary.failed += 1;
        await client.query(`insert into cl.${DB_PREFIX}_m004_thumbnail_assets (movie_code,thumbnail_url,thumbnail_status,last_error,last_checked_at) values ($1,$2,'failed',$3,now())
          on conflict (movie_code) do update set thumbnail_status='failed',last_error=excluded.last_error,last_checked_at=now(),updated_at=now()`, [row.movie_code, row.thumbnail_url, String(error.message || error)]);
      }
    }
    return summary;
  } finally { await client.end(); }
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

function rapidgatorLinks($, root) {
  const links = [];
  $(root).find("a").each((_, a) => {
    const text = cleanText($(a).text());
    const href = String($(a).attr("href") || "");
    const match = `${text} ${href}`.match(/https?:\/\/rapidgator\.net\/file\/[^\s"'<>]+/i);
    if (match) links.push({ rapidgator_url: match[0], link_href_url: href || match[0] });
  });
  return links;
}

function extractMovieCodeCandidates(...values) {
  const candidates = [];
  for (const value of values) {
    const text = String(value || "");
    for (const match of text.matchAll(/heyzo(?:[_\-\s]+(?:hd|fhd|full|lt|mb|sd))?[_\-\s]*(?:vol[_\-\s]*)?([0-9]{1,6})/gi)) {
      const code = normalizeMovieCode(match[1]);
      if (code) candidates.push(code);
    }
    for (const match of text.matchAll(/moviepages\/([0-9]{1,6})\//gi)) {
      const code = normalizeMovieCode(match[1]);
      if (code) candidates.push(code);
    }
  }
  return [...new Set(candidates)];
}

async function fetchMasterResolver() {
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(`select movie_code, relation_key_mmddyy from cl.${DB_PREFIX}_m004_master`);
    const exact = new Set(result.rows.map((row) => row.movie_code));
    const byRelation = new Map();
    for (const row of result.rows) {
      const values = byRelation.get(row.relation_key_mmddyy) || [];
      values.push(row.movie_code);
      byRelation.set(row.relation_key_mmddyy, values);
    }
    return { exact, byRelation };
  } finally {
    await client.end();
  }
}

function resolveMovieCode(candidates, resolver) {
  const exactMatches = candidates.filter((candidate) => resolver.exact.has(candidate));
  const relationMatches = candidates
    .map((candidate) => movieNumber(candidate))
    .filter(Boolean)
    .flatMap((candidate) => resolver.byRelation.get(candidate) || []);
  const allMatches = [...new Set([...exactMatches, ...relationMatches])];
  if (allMatches.length === 1) {
    return { movieCode: allMatches[0], matchReason: exactMatches.includes(allMatches[0]) ? "exact" : "relation_unique" };
  }
  if (allMatches.length > 1) return { movieCode: "", matchReason: "multiple_master_matches" };
  return { movieCode: "", matchReason: "not_matched" };
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
      pageLogs.push({ run_id: id, page_number: pageNumber, page_url: pageUrl, status: "error", posts_found: 0, rows_found: 0, list_rg_found: 0, detail_fetch_count: 0, detail_rg_found: 0, error_message: error.message });
      break;
    }
    const $ = cheerio.load(html);
    const posts = $("div[id^='post-']").toArray();
    if (posts.length === 0) {
      pageLogs.push({ run_id: id, page_number: pageNumber, page_url: pageUrl, status: "error", posts_found: 0, rows_found: 0, list_rg_found: 0, detail_fetch_count: 0, detail_rg_found: 0, error_message: "No expected post elements found" });
      break;
    }
    const pageRows = [];
    let listRgFound = 0;
    let detailFetchCount = 0;
    let detailRgFound = 0;
    for (const post of posts) {
      const titleLink = $(post).find("h2 a").first();
      const title = cleanText(titleLink.attr("title") || titleLink.text());
      const detailUrl = normalizeUrl(titleLink.attr("href"), pageUrl);
      let links = rapidgatorLinks($, post);
      let foundSource = links.length ? "list" : "none";
      if (links.length) listRgFound += 1;
      if (!links.length && detailUrl) {
        detailFetchCount += 1;
        await sleep(delayMs());
        try {
          const detail$ = cheerio.load(await fetchHtml(detailUrl));
          links = rapidgatorLinks(detail$, "body");
          foundSource = links.length ? "detail" : "none";
          if (links.length) detailRgFound += 1;
        } catch {
          foundSource = "error";
        }
      }
      const candidates = extractMovieCodeCandidates(title, detailUrl, $(post).text());
      const resolution = resolveMovieCode(candidates, resolver);
      if (!links.length) links = [{ rapidgator_url: "", link_href_url: "" }];
      for (const link of links) {
        const row = { movie_code: resolution.movieCode, title, detail_url: detailUrl, ...link, found_source: foundSource, has_rapidgator: Boolean(link.rapidgator_url), source_page_url: pageUrl, page_number: pageNumber, raw_payload: { candidates, match_reason: resolution.matchReason } };
        rows.push(row);
        pageRows.push(row);
      }
      if (args.limit > 0 && rows.length >= args.limit) break;
    }
    pageLogs.push({ run_id: id, page_number: pageNumber, page_url: pageUrl, status: "success", posts_found: posts.length, rows_found: pageRows.length, list_rg_found: listRgFound, detail_fetch_count: detailFetchCount, detail_rg_found: detailRgFound, error_message: "" });
    if (args.limit > 0 && rows.length >= args.limit) break;
    if (offset < args.maxPages - 1) await sleep(delayMs());
  }
  const hasErrors = pageLogs.some((row) => row.status === "error");
  if (!hasErrors && args.limit === 0 && pageLogs.length === args.maxPages) {
    const terminalPageNumber = args.startPage + args.maxPages;
    const terminalPageUrl = HIJAV_URL.replace("{page}", String(terminalPageNumber));
    await sleep(delayMs());
    try {
      const terminal$ = cheerio.load(await fetchHtml(terminalPageUrl));
      const terminalPosts = terminal$("div[id^='post-']").length;
      pageLogs.push({
        run_id: id,
        page_number: terminalPageNumber,
        page_url: terminalPageUrl,
        status: "error",
        posts_found: terminalPosts,
        rows_found: 0,
        list_rg_found: 0,
        detail_fetch_count: 0,
        detail_rg_found: 0,
        error_message: terminalPosts > 0 ? "More pages exist beyond max-pages" : "No expected post elements found on terminal probe",
      });
    } catch (error) {
      pageLogs.push({
        run_id: id,
        page_number: terminalPageNumber,
        page_url: terminalPageUrl,
        status: error.status === 404 ? "terminal" : "error",
        posts_found: 0,
        rows_found: 0,
        list_rg_found: 0,
        detail_fetch_count: 0,
        detail_rg_found: 0,
        error_message: error.status === 404 ? "" : error.message,
      });
    }
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
      const status = row.found_source === "error" ? "error" : !row.has_rapidgator ? "no_rapidgator" : row.movie_code ? "matched_master" : "missing_master";
      await client.query(`insert into cl.${DB_PREFIX}_dl_reference (movie_code,title,detail_url,rapidgator_url,link_href_url,found_source,has_rapidgator,source_page_url,page_number,review_status,raw_payload)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        on conflict ((coalesce(movie_code,'')),(coalesce(detail_url,'')),(coalesce(rapidgator_url,''))) do update set title=excluded.title,link_href_url=excluded.link_href_url,
        found_source=excluded.found_source,has_rapidgator=excluded.has_rapidgator,source_page_url=excluded.source_page_url,page_number=excluded.page_number,review_status=excluded.review_status,last_seen_at=now(),updated_at=now()`,
      [row.movie_code || null, row.title, row.detail_url || null, row.rapidgator_url || null, row.link_href_url || null, row.found_source, row.has_rapidgator, row.source_page_url, row.page_number, status, JSON.stringify(row.raw_payload)]);
    }
    const errorCount = pageLogs.filter((row) => row.status === "error").length + rows.filter((row) => row.found_source === "error").length;
    if (errorCount > 0) throw new Error(`DL reference collection has fetch errors: ${errorCount}`);
    await client.query(`update cl.${DB_PREFIX}_dl_reference_runs set status='success',finished_at=now(),pages_processed=$2,posts_found=$3,rows_written=$4,
      matched_master_count=$5,missing_master_count=$6,no_rapidgator_count=$7,error_count=$8 where run_id=$1`,
    [id, pageLogs.filter((row) => row.status === "success").length, pageLogs.reduce((sum, row) => sum + row.posts_found, 0), rows.length,
      rows.filter((row) => row.has_rapidgator && row.movie_code).length, rows.filter((row) => row.has_rapidgator && !row.movie_code).length, rows.filter((row) => !row.has_rapidgator).length, errorCount]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { await client.end(); }
}

async function initDb() {
  const client = createPgClient();
  await client.connect();
  try { await client.query(fs.readFileSync(path.resolve(__dirname, "..", "..", "ops", "sql", "100_heyzo_site.sql"), "utf8")); }
  finally { await client.end(); }
}

async function status() {
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(`select
      (select count(*)::integer from cl.${DB_PREFIX}_m004_master) master_count,
      (select count(*)::integer from cl.${DB_PREFIX}_m004_master_raw) raw_count,
      (select count(*)::integer from cl.${DB_PREFIX}_m004_master where release_date is null) master_null_release_date_count,
      (select count(*)::integer from cl.${DB_PREFIX}_m004_thumbnail_assets where thumbnail_status='collected') thumbnail_count,
      (select count(*)::integer from cl.${DB_PREFIX}_m004_thumbnail_assets where thumbnail_status='failed') thumbnail_failed_count,
      (select count(*)::integer from cl.${DB_PREFIX}_m004_master where coalesce(thumbnail_url,'')<>'' and movie_code not in
        (select movie_code from cl.${DB_PREFIX}_m004_thumbnail_assets where thumbnail_status in ('collected','failed'))) thumbnail_pending_count,
      (select count(*)::integer from cl.${DB_PREFIX}_owned_file) owned_count,
      (select count(*)::integer from cl.${DB_PREFIX}_dl_reference) dl_reference_count,
      (select count(*)::integer from cl.${DB_PREFIX}_dl_reference where review_status='matched_master') dl_matched_master_count,
      (select count(*)::integer from cl.${DB_PREFIX}_dl_reference where review_status='missing_master') dl_missing_master_count,
      (select count(*)::integer from cl.${DB_PREFIX}_dl_reference where review_status='no_rapidgator') dl_no_rapidgator_count,
      (select count(*)::integer from cl.${DB_PREFIX}_dl_reference_runs) dl_run_count,
      (select count(*)::integer from cl.${DB_PREFIX}_dl_reference_runs where status='success') dl_success_run_count`);
    const failures = await client.query(`select movie_code,thumbnail_url,last_error from cl.${DB_PREFIX}_m004_thumbnail_assets where thumbnail_status='failed' order by movie_code`);
    return { ...result.rows[0], thumbnail_failures: failures.rows };
  } finally { await client.end(); }
}

async function seedCommonMasters() {
  const client = createPgClient();
  await client.connect();
  try {
    await client.query("begin");
    const siteResult = await client.query("select site_id from cl.site_master where site_code='heyzo'");
    if (!siteResult.rowCount) throw new Error("site_master row is missing for heyzo");
    const siteId = siteResult.rows[0].site_id;
    const actorResult = await client.query(`select distinct trim(value) actor_name
      from cl.${DB_PREFIX}_m004_master,
      lateral regexp_split_to_table(coalesce(actor_name,''), '\\s*[,、/]\\s*') value
      where trim(value)<>''`);
    let insertedGroups = 0;
    let insertedNames = 0;
    for (const row of actorResult.rows) {
      const groupCode = `heyzo:${row.actor_name}`;
      const group = await client.query(`insert into cl.actor_group_master (group_code,representative_actor_name,note)
        values ($1,$2,'Seeded from heyzo master') on conflict (group_code) do update set representative_actor_name=excluded.representative_actor_name,updated_at=now()
        returning actor_group_id`, [groupCode, row.actor_name]);
      insertedGroups += 1;
      const name = await client.query(`insert into cl.actor_name_master (actor_name,site_id,actor_group_id,note)
        values ($1,$2,$3,'Seeded from heyzo master') on conflict (site_id,actor_name) do update set actor_group_id=excluded.actor_group_id,updated_at=now()`,
      [row.actor_name, siteId, group.rows[0].actor_group_id]);
      insertedNames += name.rowCount;
    }
    await client.query("commit");
    return { actors_found: actorResult.rowCount, groups_processed: insertedGroups, names_processed: insertedNames };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { await client.end(); }
}

async function main() {
  const args = parseArgs(process.argv);
  loadEnvFile(args.envFile);
  let result;
  if (args.step === "init-db") result = await initDb();
  else if (args.step === "master") result = await collectMaster(args);
  else if (args.step === "thumbnails") result = await collectThumbnails(args);
  else if (args.step === "dl-reference") result = await collectDl(args);
  else if (args.step === "common-master") result = await seedCommonMasters();
  else if (args.step === "status") result = await status();
  else throw new Error(`Unsupported step: ${args.step}`);
  process.stdout.write(`${JSON.stringify({ ok: true, source: SOURCE, step: args.step, dry_run: args.dryRun, result }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

