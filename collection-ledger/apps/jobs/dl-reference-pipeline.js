"use strict";

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const PACO_SOURCE_NAME = "paco";
const SEARCH_SITE_CODE = "hijav";
const DEFAULT_SEARCH_KEYWORD = "pacopaco";
const DEFAULT_START_PAGE = 1;
const DEFAULT_MAX_PAGES = 119;
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;

function parseArgs(argv) {
  const args = {
    source: PACO_SOURCE_NAME,
    step: "status",
    dryRun: false,
    startPage: DEFAULT_START_PAGE,
    maxPages: DEFAULT_MAX_PAGES,
    limit: 0,
    searchKeyword: DEFAULT_SEARCH_KEYWORD,
    envFile: "",
    writeJson: false,
    showMissing: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--write-json") {
      args.writeJson = true;
    } else if (arg === "--show-missing") {
      args.showMissing = true;
    } else if (arg === "--source") {
      args.source = argv[++i];
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg === "--step") {
      args.step = argv[++i];
    } else if (arg.startsWith("--step=")) {
      args.step = arg.slice("--step=".length);
    } else if (arg === "--start-page") {
      args.startPage = parsePositiveInt(argv[++i], "start-page");
    } else if (arg.startsWith("--start-page=")) {
      args.startPage = parsePositiveInt(arg.slice("--start-page=".length), "start-page");
    } else if (arg === "--max-pages") {
      args.maxPages = parsePositiveInt(argv[++i], "max-pages");
    } else if (arg.startsWith("--max-pages=")) {
      args.maxPages = parsePositiveInt(arg.slice("--max-pages=".length), "max-pages");
    } else if (arg === "--limit") {
      args.limit = parseNonNegativeInt(argv[++i], "limit");
    } else if (arg.startsWith("--limit=")) {
      args.limit = parseNonNegativeInt(arg.slice("--limit=".length), "limit");
    } else if (arg === "--search-keyword") {
      args.searchKeyword = argv[++i];
    } else if (arg.startsWith("--search-keyword=")) {
      args.searchKeyword = arg.slice("--search-keyword=".length);
    } else if (arg === "--env-file") {
      args.envFile = argv[++i];
    } else if (arg.startsWith("--env-file=")) {
      args.envFile = arg.slice("--env-file=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function loadEnvFile(envFile) {
  const candidates = [];

  if (envFile) {
    candidates.push(path.resolve(envFile));
  }

  candidates.push(path.resolve(__dirname, "..", "..", ".env"));

  const target = candidates.find((candidate) => fs.existsSync(candidate));
  if (!target) {
    return "";
  }

  const text = fs.readFileSync(target, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1).trim());

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return target;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function createPgClient() {
  const { Client } = require("pg");
  const database = process.env.PGDATABASE || process.env.DB_NAME;
  const user = process.env.PGUSER || process.env.DB_USER;

  if (!database || !user) {
    throw new Error("DB connection is not configured. Set PGDATABASE/PGUSER or DB_NAME/DB_USER.");
  }

  return new Client({
    host: process.env.PGHOST || process.env.DB_HOST || "localhost",
    port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
    database,
    user,
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD,
  });
}

function buildRunId(searchKeyword) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${PACO_SOURCE_NAME}_dl_reference_${searchKeyword}_${stamp}_${process.pid}`;
}

function buildSearchPageUrl(pageNumber, searchKeyword) {
  return `https://hijav.net/page/${pageNumber}/?s=${encodeURIComponent(searchKeyword)}`;
}

function randomDelayMs() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    },
  });
  const bytes = await response.arrayBuffer();
  const html = new TextDecoder("utf-8").decode(bytes);

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.html = html;
    throw error;
  }

  return { html, status: response.status };
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractMovieCode(...values) {
  for (const value of values) {
    const normalized = String(value || "").replace(/([0-9]{6})-([0-9A-Za-z]+)/g, "$1_$2");
    const match = normalized.match(/([0-9]{6}_[0-9A-Za-z]+)/);
    if (match) {
      return match[1];
    }
  }
  return "";
}

function normalizeUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return new URL(raw, baseUrl).toString();
}

function extractRapidgatorLinks($, root) {
  const links = [];

  $(root)
    .find("a")
    .each((_, element) => {
      const href = normalizeMaybeUrl($(element).attr("href"));
      const text = cleanText($(element).text());
      const rapidgatorUrl = firstRapidgatorUrl(text) || firstRapidgatorUrl(href);
      if (!rapidgatorUrl) {
        return;
      }
      links.push({
        rapidgator_url: rapidgatorUrl,
        link_href_url: href || rapidgatorUrl,
        anchor_text: text,
      });
    });

  return dedupeRapidgatorLinks(links);
}

function normalizeMaybeUrl(value) {
  return String(value || "").trim();
}

function firstRapidgatorUrl(value) {
  const match = String(value || "").match(/https?:\/\/rapidgator\.net\/file\/[^\s"'<>]+/i);
  return match ? match[0].replace(/&amp;/g, "&") : "";
}

function dedupeRapidgatorLinks(links) {
  const seen = new Set();
  const result = [];
  for (const link of links) {
    const key = `${link.rapidgator_url}|${link.link_href_url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(link);
  }
  return result;
}

function parseListEntries(html, pageUrl, pageNumber, searchKeyword) {
  const $ = cheerio.load(html);
  const entries = [];

  $("div[id^='post-']").each((index, element) => {
    const post = $(element);
    const titleLink = post.find("h2 a").first();
    const title = cleanText(titleLink.attr("title") || titleLink.text());
    const detailUrl = normalizeUrl(titleLink.attr("href"), pageUrl);
    const movieCode = extractMovieCode(title, detailUrl, post.text());
    const listLinks = extractRapidgatorLinks($, element);

    entries.push({
      search_site_code: SEARCH_SITE_CODE,
      search_keyword: searchKeyword,
      movie_code: movieCode,
      title,
      detail_url: detailUrl,
      source_page_url: pageUrl,
      page_number: pageNumber,
      post_index_in_page: index + 1,
      list_links: listLinks,
      raw_post_id: post.attr("id") || "",
    });
  });

  return entries;
}

async function enrichEntryFromDetail(entry) {
  const waitMs = randomDelayMs();
  process.stderr.write(`wait ${waitMs}ms before detail ${entry.movie_code || entry.detail_url}\n`);
  await sleep(waitMs);

  try {
    const result = await fetchHtml(entry.detail_url);
    const $ = cheerio.load(result.html);
    const links = extractRapidgatorLinks($, "body");
    return {
      links,
      http_status: result.status,
      error_message: "",
    };
  } catch (error) {
    return {
      links: [],
      http_status: error.status || 0,
      error_message: error.message,
    };
  }
}

async function collectDownloadReferences(args) {
  const runId = buildRunId(args.searchKeyword);
  const rows = [];
  const pageLogs = [];

  for (let offset = 0; offset < args.maxPages; offset += 1) {
    const pageNumber = args.startPage + offset;
    const pageUrl = buildSearchPageUrl(pageNumber, args.searchKeyword);
    let entries = [];
    let pageStatus = "success";
    let pageError = "";

    try {
      const fetched = await fetchHtml(pageUrl);
      entries = parseListEntries(fetched.html, pageUrl, pageNumber, args.searchKeyword);
    } catch (error) {
      pageStatus = "error";
      pageError = error.message;
    }

    const pageRows = [];
    let detailFetchCount = 0;
    let detailRgFound = 0;

    for (const entry of entries) {
      if (args.limit > 0 && rows.length >= args.limit) {
        break;
      }

      let links = entry.list_links;
      let foundSource = links.length > 0 ? "list" : "none";
      let httpStatus = 200;
      let errorMessage = "";

      if (links.length === 0 && entry.detail_url) {
        detailFetchCount += 1;
        const detailResult = await enrichEntryFromDetail(entry);
        links = detailResult.links;
        httpStatus = detailResult.http_status;
        errorMessage = detailResult.error_message;
        foundSource = links.length > 0 ? "detail" : errorMessage ? "error" : "none";
        if (links.length > 0) {
          detailRgFound += 1;
        }
      }

      const builtRows = buildRowsForEntry(runId, entry, links, foundSource, httpStatus, errorMessage);
      rows.push(...builtRows);
      pageRows.push(...builtRows);
    }

    pageLogs.push({
      run_id: runId,
      page_number: pageNumber,
      page_url: pageUrl,
      status: pageStatus,
      posts_found: entries.length,
      list_rg_found: entries.filter((entry) => entry.list_links.length > 0).length,
      detail_fetch_count: detailFetchCount,
      detail_rg_found: detailRgFound,
      no_rapidgator_count: pageRows.filter((row) => !row.has_rapidgator).length,
      error_message: pageError,
    });

    if (args.limit > 0 && rows.length >= args.limit) {
      break;
    }

    if (offset < args.maxPages - 1) {
      const waitMs = randomDelayMs();
      process.stderr.write(`wait ${waitMs}ms before next search page\n`);
      await sleep(waitMs);
    }
  }

  const selectedRows = args.limit > 0 ? rows.slice(0, args.limit) : rows;
  await assignReviewStatus(selectedRows);

  if (args.writeJson) {
    writeDryRunJson(runId, selectedRows, pageLogs);
  }

  if (!args.dryRun) {
    await insertRows(runId, args, selectedRows, pageLogs);
  }

  return { runId, rows: selectedRows, pageLogs };
}

function buildRowsForEntry(runId, entry, links, foundSource, httpStatus, errorMessage) {
  if (links.length === 0) {
    return [
      {
        ...baseRow(runId, entry),
        rapidgator_url: "",
        link_href_url: "",
        found_source: foundSource,
        has_rapidgator: false,
        http_status: httpStatus || null,
        error_message: errorMessage || "",
      },
    ];
  }

  return links.map((link) => ({
    ...baseRow(runId, entry),
    rapidgator_url: link.rapidgator_url,
    link_href_url: link.link_href_url,
    found_source: foundSource,
    has_rapidgator: true,
    http_status: httpStatus || null,
    error_message: errorMessage || "",
    raw_payload: {
      ...baseRow(runId, entry).raw_payload,
      anchor_text: link.anchor_text,
    },
  }));
}

function baseRow(runId, entry) {
  return {
    search_site_code: entry.search_site_code,
    search_keyword: entry.search_keyword,
    movie_code: entry.movie_code,
    title: entry.title,
    detail_url: entry.detail_url,
    source_page_url: entry.source_page_url,
    page_number: entry.page_number,
    post_index_in_page: entry.post_index_in_page,
    last_run_id: runId,
    review_status: "pending",
    raw_payload: {
      raw_post_id: entry.raw_post_id,
      list_link_count: entry.list_links.length,
    },
  };
}

async function assignReviewStatus(rows) {
  const movieCodes = Array.from(new Set(rows.map((row) => row.movie_code).filter(Boolean)));
  const knownCodes = await fetchKnownMasterCodes(movieCodes);

  for (const row of rows) {
    if (!row.has_rapidgator) {
      row.review_status = row.found_source === "error" ? "error" : "no_rapidgator";
    } else if (!row.movie_code || !knownCodes.has(row.movie_code)) {
      row.review_status = "missing_master";
    } else {
      row.review_status = "matched_master";
    }
  }
}

async function fetchKnownMasterCodes(movieCodes) {
  if (movieCodes.length === 0) {
    return new Set();
  }

  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(
      "select movie_code from cl.paco_m001_master_staging where movie_code = any($1::text[])",
      [movieCodes]
    );
    return new Set(result.rows.map((row) => row.movie_code));
  } finally {
    await client.end();
  }
}

async function insertRows(runId, args, rows, pageLogs) {
  const client = createPgClient();
  await client.connect();

  try {
    await client.query("begin");
    await client.query(
      `
        insert into cl.paco_dl_reference_runs (
          run_id, search_site_code, search_keyword, mode, status, start_page, max_pages
        )
        values ($1, $2, $3, $4, 'running', $5, $6)
        on conflict (run_id) do nothing
      `,
      [runId, SEARCH_SITE_CODE, args.searchKeyword, "collect", args.startPage, args.maxPages]
    );

    await insertMissingPacoMasters(client, runId, rows);
    await refreshReviewStatusFromDb(client, rows);

    for (const pageLog of pageLogs) {
      await client.query(
        `
          insert into cl.paco_dl_reference_page_logs (
            run_id, page_number, page_url, status, posts_found, list_rg_found,
            detail_fetch_count, detail_rg_found, no_rapidgator_count, error_message
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          pageLog.run_id,
          pageLog.page_number,
          pageLog.page_url,
          pageLog.status,
          pageLog.posts_found,
          pageLog.list_rg_found,
          pageLog.detail_fetch_count,
          pageLog.detail_rg_found,
          pageLog.no_rapidgator_count,
          pageLog.error_message,
        ]
      );
    }

    for (const row of rows) {
      await client.query(
        `
          insert into cl.paco_dl_reference (
            search_site_code,
            search_keyword,
            movie_code,
            title,
            detail_url,
            rapidgator_url,
            link_href_url,
            found_source,
            has_rapidgator,
            http_status,
            error_message,
            source_page_url,
            page_number,
            post_index_in_page,
            review_status,
            raw_payload,
            last_run_id
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16::jsonb, $17
          )
          on conflict (
            search_site_code,
            search_keyword,
            (coalesce(movie_code, '')),
            (coalesce(detail_url, '')),
            (coalesce(rapidgator_url, ''))
          ) do update set
            title = excluded.title,
            link_href_url = excluded.link_href_url,
            found_source = excluded.found_source,
            has_rapidgator = excluded.has_rapidgator,
            http_status = excluded.http_status,
            error_message = excluded.error_message,
            source_page_url = excluded.source_page_url,
            page_number = excluded.page_number,
            post_index_in_page = excluded.post_index_in_page,
            review_status = excluded.review_status,
            raw_payload = excluded.raw_payload,
            last_run_id = excluded.last_run_id,
            last_seen_at = now(),
            updated_at = now()
        `,
        [
          row.search_site_code,
          row.search_keyword,
          row.movie_code || null,
          row.title || null,
          row.detail_url || null,
          row.rapidgator_url || null,
          row.link_href_url || null,
          row.found_source,
          row.has_rapidgator,
          row.http_status,
          row.error_message || null,
          row.source_page_url,
          row.page_number,
          row.post_index_in_page,
          row.review_status,
          JSON.stringify(row.raw_payload),
          row.last_run_id,
        ]
      );
    }

    await client.query(
      `
        update cl.paco_dl_reference_runs
        set finished_at = now(),
            status = 'success',
            pages_processed = $2,
            posts_found = $3,
            rows_written = $4,
            list_rg_found = $5,
            detail_rg_found = $6,
            no_rapidgator_count = $7,
            missing_master_count = $8
        where run_id = $1
      `,
      [
        runId,
        pageLogs.length,
        pageLogs.reduce((sum, pageLog) => sum + pageLog.posts_found, 0),
        rows.length,
        pageLogs.reduce((sum, pageLog) => sum + pageLog.list_rg_found, 0),
        pageLogs.reduce((sum, pageLog) => sum + pageLog.detail_rg_found, 0),
        rows.filter((row) => !row.has_rapidgator).length,
        rows.filter((row) => row.review_status === "missing_master").length,
      ]
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

async function insertMissingPacoMasters(client, runId, rows) {
  const candidates = [];
  const seen = new Set();

  for (const row of rows) {
    if (!row.movie_code || row.review_status !== "missing_master") {
      continue;
    }
    if (seen.has(row.movie_code)) {
      continue;
    }
    seen.add(row.movie_code);
    candidates.push(row);
  }

  for (const row of candidates) {
    const releaseDate = releaseDateFromMovieCode(row.movie_code);
    const relationKey = row.movie_code.slice(0, 6);
    const movieCodeSuffix = row.movie_code.slice(7);
    const detailPath = detailPathFromUrl(row.movie_code);
    const masterTitle = cleanupHijavTitle(row.title, row.movie_code);

    const rawResult = await client.query(
      `
        insert into cl.paco_m001_master_raw (
          relation_key_mmddyy,
          release_date,
          movie_code,
          movie_code_suffix,
          title,
          actor_name,
          channel_name,
          detail_path,
          detail_url,
          thumbnail_url,
          source_page_url,
          page_number,
          row_index_in_page,
          raw_payload,
          last_run_id
        )
        values (
          $1, $2, $3, $4, $5, null, 'pacopacomama',
          $6, $7, null, $8, $9, $10, $11::jsonb, $12
        )
        on conflict (movie_code) do update set
          title = excluded.title,
          source_page_url = excluded.source_page_url,
          page_number = excluded.page_number,
          row_index_in_page = excluded.row_index_in_page,
          raw_payload = excluded.raw_payload,
          last_run_id = excluded.last_run_id,
          updated_at = now()
        returning id
      `,
      [
        relationKey,
        releaseDate,
        row.movie_code,
        movieCodeSuffix,
        masterTitle,
        detailPath,
        `https://www.caribbeancom.com/moviepages/${row.movie_code}/index.html`,
        row.detail_url || row.source_page_url,
        row.page_number,
        row.post_index_in_page,
        JSON.stringify({
          source: "hijav_dl_reference",
          title: row.title,
          detail_url: row.detail_url,
          rapidgator_url: row.rapidgator_url,
        }),
        runId,
      ]
    );

    await client.query(
      `
        insert into cl.paco_m001_master_staging (
          relation_key_mmddyy,
          release_date,
          movie_code,
          movie_code_suffix,
          title,
          actor_name,
          channel_name,
          detail_url,
          thumbnail_url,
          raw_id,
          review_status,
          approved,
          note,
          last_run_id
        )
        values (
          $1, $2, $3, $4, $5, null, 'pacopacomama',
          $6, null, $7, 'dl_reference_added', false,
          'added from hijav dl reference because paco master was missing',
          $8
        )
        on conflict (movie_code) do update set
          title = excluded.title,
          raw_id = excluded.raw_id,
          note = excluded.note,
          last_run_id = excluded.last_run_id,
          updated_at = now()
      `,
      [
        relationKey,
        releaseDate,
        row.movie_code,
        movieCodeSuffix,
        masterTitle,
        `https://www.caribbeancom.com/moviepages/${row.movie_code}/index.html`,
        rawResult.rows[0].id,
        runId,
      ]
    );
  }
}

async function refreshReviewStatusFromDb(client, rows) {
  const movieCodes = Array.from(new Set(rows.map((row) => row.movie_code).filter(Boolean)));
  if (movieCodes.length === 0) {
    return;
  }

  const result = await client.query(
    "select movie_code from cl.paco_m001_master_staging where movie_code = any($1::text[])",
    [movieCodes]
  );
  const knownCodes = new Set(result.rows.map((row) => row.movie_code));

  for (const row of rows) {
    if (!row.has_rapidgator) {
      row.review_status = row.found_source === "error" ? "error" : "no_rapidgator";
    } else if (!row.movie_code || !knownCodes.has(row.movie_code)) {
      row.review_status = "missing_master";
    } else {
      row.review_status = "matched_master";
    }
  }
}

function releaseDateFromMovieCode(movieCode) {
  const match = String(movieCode || "").match(/^([0-9]{2})([0-9]{2})([0-9]{2})_/);
  if (!match) {
    throw new Error(`Invalid movie_code date: ${movieCode}`);
  }

  return `20${match[3]}-${match[1]}-${match[2]}`;
}

function detailPathFromUrl(movieCode) {
  return `/moviepages/${movieCode}/index.html`;
}

function cleanupHijavTitle(title, movieCode) {
  return cleanText(String(title || "").replace(new RegExp(`^Pacopacomama\\s+${movieCode}\\s+`, "i"), ""));
}

function writeDryRunJson(runId, rows, pageLogs) {
  const outputDir = path.resolve(__dirname, "..", "..", "storage", "exports", "dl-reference");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${runId}_dry_run.json`);

  fs.writeFileSync(
    outputPath,
    JSON.stringify({ run_id: runId, dry_run: true, page_logs: pageLogs, rows }, null, 2),
    "utf8"
  );
  process.stderr.write(`dry-run json written: ${outputPath}\n`);
}

async function initDb() {
  const sqlPath = path.resolve(__dirname, "..", "..", "ops", "sql", "050_paco_dl_references.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = createPgClient();
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function getStatus(options = {}) {
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(
      `
        select
          (select count(*)::integer from cl.paco_dl_reference) as dl_reference_count,
          (select count(*)::integer from cl.paco_dl_reference where has_rapidgator) as has_rapidgator_count,
          (select count(*)::integer from cl.paco_dl_reference where not has_rapidgator) as no_rapidgator_count,
          (select count(*)::integer from cl.paco_dl_reference where review_status = 'matched_master') as matched_master_count,
          (select count(*)::integer from cl.paco_dl_reference where review_status = 'missing_master') as missing_master_count,
          (select count(*)::integer from cl.paco_dl_reference where review_status = 'ignored') as ignored_count,
          (select count(*)::integer from cl.paco_dl_reference_runs) as run_count,
          (select count(*)::integer from cl.paco_dl_reference_page_logs) as page_log_count
      `
    );
    const status = result.rows[0];
    if (!options.showMissing) {
      return status;
    }

    const missingResult = await client.query(
      `
        select movie_code, title, detail_url, rapidgator_url, found_source
        from cl.paco_dl_reference
        where review_status = 'missing_master'
        order by movie_code nulls last, detail_url
      `
    );
    return { ...status, missing_master_rows: missingResult.rows };
  } finally {
    await client.end();
  }
}

async function normalizeStatus() {
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(
      `
        update cl.paco_dl_reference
        set
          review_status = 'ignored',
          error_message = 'ignored because no paco movie_code was detected',
          updated_at = now()
        where review_status = 'missing_master'
          and movie_code is null
        returning dl_reference_id, title, detail_url, rapidgator_url
      `
    );
    return { ignored_without_movie_code_count: result.rowCount, rows: result.rows };
  } finally {
    await client.end();
  }
}

function summarizeRows(rows, pageLogs) {
  return {
    page_count: pageLogs.length,
    row_count: rows.length,
    posts_found: pageLogs.reduce((sum, pageLog) => sum + pageLog.posts_found, 0),
    list_rg_found: pageLogs.reduce((sum, pageLog) => sum + pageLog.list_rg_found, 0),
    detail_fetch_count: pageLogs.reduce((sum, pageLog) => sum + pageLog.detail_fetch_count, 0),
    detail_rg_found: pageLogs.reduce((sum, pageLog) => sum + pageLog.detail_rg_found, 0),
    has_rapidgator_count: rows.filter((row) => row.has_rapidgator).length,
    no_rapidgator_count: rows.filter((row) => !row.has_rapidgator).length,
    matched_master_count: rows.filter((row) => row.review_status === "matched_master").length,
    missing_master_count: rows.filter((row) => row.review_status === "missing_master").length,
    error_count: rows.filter((row) => row.review_status === "error").length,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);

  if (args.source !== PACO_SOURCE_NAME) {
    throw new Error(`Unsupported source: ${args.source}`);
  }

  if (args.step === "init-db") {
    await initDb();
    process.stdout.write(
      `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv) }, null, 2)}\n`
    );
    return;
  }

  if (args.step === "status") {
    const status = await getStatus({ showMissing: args.showMissing });
    process.stdout.write(
      `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), status }, null, 2)}\n`
    );
    return;
  }

  if (args.step === "normalize-status") {
    const result = await normalizeStatus();
    process.stdout.write(
      `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), result }, null, 2)}\n`
    );
    return;
  }

  if (args.step !== "collect") {
    throw new Error(`Unsupported step: ${args.step}`);
  }

  const result = await collectDownloadReferences(args);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        dry_run: args.dryRun,
        env_file_loaded: Boolean(loadedEnv),
        run_id: result.runId,
        summary: summarizeRows(result.rows, result.pageLogs),
        page_logs: result.pageLogs,
        preview: result.rows.slice(0, 20),
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
