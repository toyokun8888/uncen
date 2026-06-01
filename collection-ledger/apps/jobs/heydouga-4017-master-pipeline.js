"use strict";

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const SOURCE_NAME = "heydouga_4017";
const AVJOY_BASE_URL = "https://avjoy.me";
const AVJOY_SEARCH_URL =
  "https://avjoy.me/search/videos/%E3%81%97%E3%82%8D%E3%83%8F%E3%83%A1?page=1";
const GGJAV_BASE_URL = "https://ggjav.com";
const GGJAV_SEARCH_URL =
  "https://ggjav.com/ja/main/search?string=Heydouga%204017&type=all&page=1&order=pub_date";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;

function parseArgs(argv) {
  const args = {
    step: "master-dry-run",
    avjoyPages: 1,
    ggjavPages: 1,
    startPage: 1,
    limit: 0,
    apply: false,
    envFile: "",
    writeJson: true,
    writeCsv: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--no-json") {
      args.writeJson = false;
    } else if (arg === "--no-csv") {
      args.writeCsv = false;
    } else if (arg === "--apply") {
      args.apply = true;
    } else if (arg.startsWith("--env-file=")) {
      args.envFile = arg.slice("--env-file=".length);
    } else if (arg === "--env-file") {
      args.envFile = argv[++i];
    } else if (arg.startsWith("--step=")) {
      args.step = arg.slice("--step=".length);
    } else if (arg === "--step") {
      args.step = argv[++i];
    } else if (arg.startsWith("--avjoy-pages=")) {
      args.avjoyPages = parseNonNegativeInt(arg.slice("--avjoy-pages=".length), "avjoy-pages");
    } else if (arg === "--avjoy-pages") {
      args.avjoyPages = parseNonNegativeInt(argv[++i], "avjoy-pages");
    } else if (arg.startsWith("--ggjav-pages=")) {
      args.ggjavPages = parseNonNegativeInt(arg.slice("--ggjav-pages=".length), "ggjav-pages");
    } else if (arg === "--ggjav-pages") {
      args.ggjavPages = parseNonNegativeInt(argv[++i], "ggjav-pages");
    } else if (arg.startsWith("--start-page=")) {
      args.startPage = parsePositiveInt(arg.slice("--start-page=".length), "start-page");
    } else if (arg === "--start-page") {
      args.startPage = parsePositiveInt(argv[++i], "start-page");
    } else if (arg.startsWith("--limit=")) {
      args.limit = parseNonNegativeInt(arg.slice("--limit=".length), "limit");
    } else if (arg === "--limit") {
      args.limit = parseNonNegativeInt(argv[++i], "limit");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
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

function buildRunId() {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${SOURCE_NAME}_master_collect_${stamp}_${process.pid}`;
}

function buildAvjoyUrl(pageNumber) {
  const url = new URL(AVJOY_SEARCH_URL);
  url.searchParams.set("page", String(pageNumber));
  return url.toString();
}

function buildGgjavUrl(pageNumber) {
  const url = new URL(GGJAV_SEARCH_URL);
  url.searchParams.set("page", String(pageNumber));
  return url.toString();
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${url}`);
  }

  return response.text();
}

function parseAvjoyRows(html, pageUrl, pageNumber) {
  const $ = cheerio.load(html);
  const rows = [];

  $(".content-row > div").each((index, element) => {
    const card = $(element);
    const resultLink = card.find('a.search-video-click[data-search-query="しろハメ"]').first();
    if (!resultLink.length) return;

    const title = cleanText(card.find("span.content-title").first().text());
    if (!title) return;

    const href = resultLink.attr("href") || "";
    const thumb = card.find(".thumb-overlay img").first().attr("src") || "";
    const key = extractHeydouga4017Key(title);

    rows.push(
      buildRawRow({
        sourceSite: "avjoy",
        sourcePriority: 1,
        pageUrl,
        pageNumber,
        rowIndex: rows.length + 1,
        rawTitle: title,
        rawDetailUrl: normalizeUrlOrEmpty(href, pageUrl),
        rawThumbUrl: normalizeUrlOrEmpty(thumb, pageUrl),
        extraction: key,
      })
    );
  });

  return rows;
}

function parseGgjavRows(html, pageUrl, pageNumber) {
  const $ = cheerio.load(html);
  const rows = [];

  $("div.item.float-left").each((index, element) => {
    const card = $(element);
    const title = cleanText(card.find(".item_title a").first().text());
    if (!title) return;

    const href = card.find(".item_title a").first().attr("href") || "";
    const thumb = card.find("img.item_image").first().attr("src") || "";
    const key = extractHeydouga4017Key(title);

    rows.push(
      buildRawRow({
        sourceSite: "ggjav",
        sourcePriority: 2,
        pageUrl,
        pageNumber,
        rowIndex: rows.length + 1,
        rawTitle: title,
        rawDetailUrl: normalizeUrlOrEmpty(href, pageUrl),
        rawThumbUrl: normalizeUrlOrEmpty(thumb, pageUrl),
        extraction: key,
      })
    );
  });

  return rows;
}

function buildRawRow(input) {
  const extracted = input.extraction || {};

  return {
    source_site: input.sourceSite,
    source_priority: input.sourcePriority,
    source_page_url: input.pageUrl,
    page_number: input.pageNumber,
    row_index_in_page: input.rowIndex,
    raw_title: input.rawTitle,
    raw_detail_url: input.rawDetailUrl,
    raw_thumb_url: input.rawThumbUrl,
    candidate_unique_key: extracted.uniqueKey || "",
    candidate_base_no: extracted.baseNo || "",
    candidate_branch_no: extracted.branchNo || "",
    extraction_status: extracted.status || "unmatched",
    extraction_note: extracted.note || "",
  };
}

function extractHeydouga4017Key(value) {
  const normalized = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const siteMatch = lower.match(/heydouga[\s_.-]*4017/);

  if (!siteMatch) {
    return { status: "ignored", note: "heydouga_4017_not_found" };
  }

  const after4017 = normalized.slice(siteMatch.index + siteMatch[0].length);
  const windowText = after4017.slice(0, 80);
  const keyMatch = windowText.match(/^[\s_.-]*(?:ppv[\s_.-]*)?([0-9]{1,5})(?:[\s_.-]+([0-9]{1,5}|[a-zA-Z]))?/i);

  if (!keyMatch) {
    return { status: "needs_review", note: "base_no_not_found_after_4017" };
  }

  const baseNo = keyMatch[1];
  const branchNo = keyMatch[2] || "";

  if (!branchNo) {
    return {
      baseNo,
      status: "needs_review",
      note: "branch_no_not_found",
    };
  }

  if (/^[a-zA-Z]$/.test(branchNo)) {
    return {
      baseNo,
      branchNo: branchNo.toLowerCase(),
      uniqueKey: `${baseNo}-${branchNo.toLowerCase()}`,
      status: "needs_review",
      note: "alphabet_branch_requires_human_confirmation",
    };
  }

  return {
    baseNo,
    branchNo,
    uniqueKey: `${baseNo}-${branchNo}`,
    status: "matched",
    note: "",
  };
}

function cleanText(value) {
  return decodeHtmlEntities(String(value || "").replace(/\s+/g, " ").trim());
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeUrlOrEmpty(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return "";
  }
}

async function collectDryRun(args) {
  const runId = buildRunId();
  const rows = [];
  const pageLogs = [];

  await collectSourcePages({
    sourceSite: "avjoy",
    pageCount: args.avjoyPages,
    startPage: args.startPage,
    rows,
    pageLogs,
    limit: args.limit,
    buildUrl: buildAvjoyUrl,
    parseRows: parseAvjoyRows,
  });

  await collectSourcePages({
    sourceSite: "ggjav",
    pageCount: args.ggjavPages,
    startPage: args.startPage,
    rows,
    pageLogs,
    limit: args.limit,
    buildUrl: buildGgjavUrl,
    parseRows: parseGgjavRows,
  });

  const summary = summarizeRows(rows);
  const outputPaths = writeOutputs(runId, args, rows, pageLogs, summary);

  return { runId, rows, pageLogs, summary, outputPaths };
}

async function collectSourcePages(options) {
  if (options.pageCount < 1) return;

  for (let offset = 0; offset < options.pageCount; offset += 1) {
    if (options.limit > 0 && options.rows.length >= options.limit) break;

    const pageNumber = options.startPage + offset;
    const pageUrl = options.buildUrl(pageNumber);
    const html = await fetchHtml(pageUrl);
    const pageRows = options.parseRows(html, pageUrl, pageNumber);
    const remaining = options.limit > 0 ? options.limit - options.rows.length : pageRows.length;
    const selectedRows =
      options.limit > 0 ? pageRows.slice(0, Math.max(remaining, 0)) : pageRows;

    options.rows.push(...selectedRows);
    options.pageLogs.push({
      source_site: options.sourceSite,
      page_number: pageNumber,
      fetched_url: pageUrl,
      row_count: pageRows.length,
      selected_count: selectedRows.length,
      status: "success",
    });

    if (offset < options.pageCount - 1) {
      const waitMs = randomDelayMs();
      process.stderr.write(`wait ${waitMs}ms before next ${options.sourceSite} page\n`);
      await sleep(waitMs);
    }
  }
}

function randomDelayMs() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeRows(rows) {
  const byStatus = countBy(rows, "extraction_status");
  const bySource = countBy(rows, "source_site");
  const keyCounts = new Map();

  for (const row of rows) {
    if (!row.candidate_unique_key) continue;
    keyCounts.set(row.candidate_unique_key, (keyCounts.get(row.candidate_unique_key) || 0) + 1);
  }

  const duplicateKeys = [...keyCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ unique_key: key, count }))
    .sort((a, b) => a.unique_key.localeCompare(b.unique_key));

  return {
    total_rows: rows.length,
    by_source: bySource,
    by_extraction_status: byStatus,
    duplicate_key_count: duplicateKeys.length,
    duplicate_keys: duplicateKeys,
  };
}

function countBy(rows, key) {
  const result = {};
  for (const row of rows) {
    const value = row[key] || "";
    result[value] = (result[value] || 0) + 1;
  }
  return result;
}

function writeOutputs(runId, args, rows, pageLogs, summary) {
  const outputDir = path.resolve(__dirname, "..", "..", "storage", "exports", SOURCE_NAME);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPaths = {};

  if (args.writeJson) {
    outputPaths.json = path.join(outputDir, `${runId}.json`);
    fs.writeFileSync(
      outputPaths.json,
      JSON.stringify(
        {
          ok: true,
          dry_run: !args.apply,
          source_name: SOURCE_NAME,
          run_id: runId,
          page_logs: pageLogs,
          summary,
          rows,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  if (args.writeCsv) {
    outputPaths.csv = path.join(outputDir, `${runId}.csv`);
    writeCsv(outputPaths.csv, rows);
  }

  return outputPaths;
}

function writeCsv(outputPath, rows) {
  const columns = [
    "source_site",
    "source_priority",
    "page_number",
    "row_index_in_page",
    "candidate_unique_key",
    "candidate_base_no",
    "candidate_branch_no",
    "extraction_status",
    "extraction_note",
    "raw_title",
    "raw_detail_url",
    "raw_thumb_url",
    "source_page_url",
  ];
  const lines = [columns.join(",")];

  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsv(row[column])).join(","));
  }

  fs.writeFileSync(outputPath, `${lines.join("\r\n")}\r\n`, "utf8");
}

function escapeCsv(value) {
  const raw = escapeSpreadsheetFormula(String(value ?? ""));
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function escapeSpreadsheetFormula(value) {
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function printSummary(result) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        dry_run: !result.apply,
        source_name: SOURCE_NAME,
        run_id: result.runId,
        summary: result.summary,
        db: result.db,
        output_paths: result.outputPaths,
      },
      null,
      2
    )}\n`
  );
}

async function initDb() {
  const sqlPath = path.resolve(
    __dirname,
    "..",
    "..",
    "ops",
    "sql",
    "080_heydouga_4017_master.sql"
  );
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = createPgClient();

  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function insertCollectedRows(runId, args, rows, pageLogs) {
  const client = createPgClient();
  const params = {
    avjoy_pages: args.avjoyPages,
    ggjav_pages: args.ggjavPages,
    start_page: args.startPage,
    limit: args.limit,
  };
  let rowsInserted = 0;
  let rowsExisting = 0;
  let rowsSkipped = 0;

  await client.connect();
  try {
    await client.query("begin");
    await client.query(
      `
        insert into cl.heydouga_4017_m002_master_collect_runs (
          run_id, source_name, mode, params, status, rows_collected
        )
        values ($1, $2, $3, $4::jsonb, $5, $6)
      `,
      [runId, SOURCE_NAME, "collect", JSON.stringify(params), "running", rows.length]
    );

    for (const pageLog of pageLogs) {
      await client.query(
        `
          insert into cl.heydouga_4017_m002_master_page_logs (
            run_id, source_site, page_number, fetched_url, row_count, selected_count, status
          )
          values ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          runId,
          pageLog.source_site,
          pageLog.page_number,
          pageLog.fetched_url,
          pageLog.row_count,
          pageLog.selected_count,
          pageLog.status,
        ]
      );
    }

    for (const row of rows) {
      if (!row.raw_detail_url) {
        rowsSkipped += 1;
        continue;
      }

      const rawResult = await insertRawRow(client, runId, row);
      if (!rawResult.rawId) {
        continue;
      }

      if (rawResult.inserted) {
        rowsInserted += 1;
      } else {
        rowsExisting += 1;
      }
      await insertStagingRow(client, runId, rawResult.rawId, row);
    }

    await client.query(
      `
        update cl.heydouga_4017_m002_master_collect_runs
        set finished_at = now(),
            status = 'success',
            rows_inserted = $2,
            rows_updated = $3
        where run_id = $1
      `,
      [runId, rowsInserted, rowsExisting]
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }

  return { rowsInserted, rowsExisting, rowsSkipped };
}

async function insertRawRow(client, runId, row) {
  const result = await client.query(
    `
      insert into cl.heydouga_4017_m002_master_raw (
        source_site,
        source_priority,
        source_page_url,
        page_number,
        row_index_in_page,
        raw_title,
        raw_detail_url,
        raw_thumb_url,
        candidate_unique_key,
        candidate_base_no,
        candidate_branch_no,
        extraction_status,
        extraction_note,
        raw_payload,
        last_run_id
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, nullif($8, ''),
        nullif($9, ''), nullif($10, ''), nullif($11, ''), $12, nullif($13, ''),
        $14::jsonb, $15
      )
      on conflict (source_site, raw_detail_url) do nothing
      returning raw_id
    `,
    [
      row.source_site,
      row.source_priority,
      row.source_page_url,
      row.page_number,
      row.row_index_in_page,
      row.raw_title,
      row.raw_detail_url,
      row.raw_thumb_url,
      row.candidate_unique_key,
      row.candidate_base_no,
      row.candidate_branch_no,
      row.extraction_status,
      row.extraction_note,
      JSON.stringify(row),
      runId,
    ]
  );

  if (result.rows[0]) {
    return { rawId: result.rows[0].raw_id, inserted: true };
  }

  const existing = await client.query(
    `
      select raw_id
      from cl.heydouga_4017_m002_master_raw
      where source_site = $1
        and raw_detail_url = $2
      limit 1
    `,
    [row.source_site, row.raw_detail_url]
  );

  return existing.rows[0]
    ? { rawId: existing.rows[0].raw_id, inserted: false }
    : { rawId: null, inserted: false };
}

async function insertStagingRow(client, runId, rawId, row) {
  const reviewStatus = row.extraction_status === "matched" ? "pending" : "needs_review";

  await client.query(
    `
      insert into cl.heydouga_4017_m002_master_staging (
        raw_id,
        candidate_unique_key,
        candidate_base_no,
        candidate_branch_no,
        title,
        detail_url,
        thumbnail_url,
        source_site,
        source_priority,
        review_status,
        note,
        last_run_id
      )
      values (
        $1, nullif($2, ''), nullif($3, ''), nullif($4, ''), $5,
        nullif($6, ''), nullif($7, ''), $8, $9, $10, nullif($11, ''), $12
      )
      on conflict (raw_id) do update set
        candidate_unique_key = excluded.candidate_unique_key,
        candidate_base_no = excluded.candidate_base_no,
        candidate_branch_no = excluded.candidate_branch_no,
        title = excluded.title,
        detail_url = excluded.detail_url,
        thumbnail_url = excluded.thumbnail_url,
        source_site = excluded.source_site,
        source_priority = excluded.source_priority,
        note = excluded.note,
        last_run_id = excluded.last_run_id,
        updated_at = now()
      where cl.heydouga_4017_m002_master_staging.review_status in ('pending', 'needs_review')
    `,
    [
      rawId,
      row.candidate_unique_key,
      row.candidate_base_no,
      row.candidate_branch_no,
      row.raw_title,
      row.raw_detail_url,
      row.raw_thumb_url,
      row.source_site,
      row.source_priority,
      reviewStatus,
      row.extraction_note,
      runId,
    ]
  );
}

async function getDbStatus() {
  const client = createPgClient();

  await client.connect();
  try {
    const result = await client.query(
      `
        select
          (select count(*)::integer from cl.heydouga_4017_m002_master_collect_runs) as run_count,
          (select count(*)::integer from cl.heydouga_4017_m002_master_page_logs) as page_log_count,
          (select count(*)::integer from cl.heydouga_4017_m002_master_raw) as raw_count,
          (select count(*)::integer from cl.heydouga_4017_m002_master_staging) as staging_count,
          (select count(*)::integer from cl.heydouga_4017_m002_master) as master_count
      `
    );
    return result.rows[0];
  } finally {
    await client.end();
  }
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

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);

  if (args.step === "init-db") {
    if (!args.apply) {
      throw new Error("init-db requires --apply after DB review and human approval");
    }
    await initDb();
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          source_name: SOURCE_NAME,
          step: args.step,
          env_file_loaded: Boolean(loadedEnv),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (args.step === "db-status") {
    const status = await getDbStatus();
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          source_name: SOURCE_NAME,
          step: args.step,
          env_file_loaded: Boolean(loadedEnv),
          status,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (args.step !== "master-dry-run" && args.step !== "collect") {
    throw new Error(`Unsupported step: ${args.step}`);
  }

  const result = await collectDryRun(args);
  result.apply = args.apply;

  if (args.step === "collect") {
    if (!args.apply) {
      throw new Error("collect requires --apply after dry-run CSV/JSON review");
    }
    result.db = await insertCollectedRows(result.runId, args, result.rows, result.pageLogs);
  }

  printSummary(result);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
