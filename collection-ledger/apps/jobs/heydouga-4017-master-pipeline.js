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
    reviewCsv: "",
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
    } else if (arg.startsWith("--review-csv=")) {
      args.reviewCsv = arg.slice("--review-csv=".length);
    } else if (arg === "--review-csv") {
      args.reviewCsv = argv[++i];
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

function writeCsvRows(outputPath, columns, rows) {
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

async function exportStagingReview(args) {
  const runId = buildRunId().replace("_master_collect_", "_staging_review_");
  const outputDir = path.resolve(__dirname, "..", "..", "storage", "exports", SOURCE_NAME);
  const client = createPgClient();

  fs.mkdirSync(outputDir, { recursive: true });
  await client.connect();

  try {
    const summary = await getStagingReviewSummary(client);
    const allRows = await getStagingReviewRows(client, args.limit);
    const duplicateRows = await getDuplicateStagingRows(client);
    const needsReviewRows = await getNeedsReviewRows(client);

    const allColumns = [
      "staging_id",
      "raw_id",
      "review_status",
      "candidate_unique_key",
      "candidate_base_no",
      "candidate_branch_no",
      "confirmed_unique_key",
      "confirmed_base_no",
      "confirmed_branch_no",
      "source_site",
      "source_priority",
      "note",
      "title",
      "detail_url",
      "thumbnail_url",
      "last_run_id",
      "updated_at",
    ];
    const duplicateColumns = ["duplicate_key", "duplicate_count", ...allColumns];
    const paths = {
      all: path.join(outputDir, `${runId}_all.csv`),
      duplicates: path.join(outputDir, `${runId}_duplicates.csv`),
      needsReview: path.join(outputDir, `${runId}_needs_review.csv`),
      summary: path.join(outputDir, `${runId}_summary.json`),
    };

    writeCsvRows(paths.all, allColumns, allRows);
    writeCsvRows(paths.duplicates, duplicateColumns, duplicateRows);
    writeCsvRows(paths.needsReview, allColumns, needsReviewRows);
    fs.writeFileSync(paths.summary, JSON.stringify({ ok: true, source_name: SOURCE_NAME, summary }, null, 2), "utf8");

    return { runId, summary, outputPaths: paths };
  } finally {
    await client.end();
  }
}

async function getStagingReviewSummary(client) {
  const result = await client.query(
    `
      with keyed as (
        select candidate_unique_key
        from cl.heydouga_4017_m002_master_staging
        where candidate_unique_key is not null
      ),
      duplicated as (
        select candidate_unique_key, count(*)::integer as duplicate_count
        from keyed
        group by candidate_unique_key
        having count(*) > 1
      )
      select
        (select count(*)::integer from cl.heydouga_4017_m002_master_staging) as total_count,
        (select count(*)::integer from cl.heydouga_4017_m002_master_staging where review_status = 'pending') as pending_count,
        (select count(*)::integer from cl.heydouga_4017_m002_master_staging where review_status = 'needs_review') as needs_review_count,
        (select count(*)::integer from cl.heydouga_4017_m002_master_staging where review_status = 'approved') as approved_count,
        (select count(*)::integer from cl.heydouga_4017_m002_master_staging where review_status = 'rejected') as rejected_count,
        (select count(*)::integer from cl.heydouga_4017_m002_master_staging where candidate_unique_key is null) as no_candidate_key_count,
        (select count(distinct candidate_unique_key)::integer from keyed) as distinct_candidate_key_count,
        (select count(*)::integer from duplicated) as duplicate_key_count,
        (select coalesce(sum(duplicate_count), 0)::integer from duplicated) as duplicate_row_count
    `
  );

  return result.rows[0];
}

async function getStagingReviewRows(client, limit) {
  const limitClause = limit > 0 ? "limit $1" : "";
  const params = limit > 0 ? [limit] : [];
  const result = await client.query(
    `
      select
        staging_id,
        raw_id,
        review_status,
        coalesce(candidate_unique_key, '') as candidate_unique_key,
        coalesce(candidate_base_no, '') as candidate_base_no,
        coalesce(candidate_branch_no, '') as candidate_branch_no,
        coalesce(confirmed_unique_key, '') as confirmed_unique_key,
        coalesce(confirmed_base_no, '') as confirmed_base_no,
        coalesce(confirmed_branch_no, '') as confirmed_branch_no,
        source_site,
        source_priority,
        coalesce(note, '') as note,
        coalesce(title, '') as title,
        coalesce(detail_url, '') as detail_url,
        coalesce(thumbnail_url, '') as thumbnail_url,
        last_run_id,
        updated_at::text as updated_at
      from cl.heydouga_4017_m002_master_staging
      order by
        coalesce(candidate_base_no, ''),
        coalesce(candidate_branch_no, ''),
        source_priority,
        staging_id
      ${limitClause}
    `,
    params
  );

  return result.rows;
}

async function getDuplicateStagingRows(client) {
  const result = await client.query(
    `
      with duplicated as (
        select candidate_unique_key, count(*)::integer as duplicate_count
        from cl.heydouga_4017_m002_master_staging
        where candidate_unique_key is not null
        group by candidate_unique_key
        having count(*) > 1
      )
      select
        d.candidate_unique_key as duplicate_key,
        d.duplicate_count,
        s.staging_id,
        s.raw_id,
        s.review_status,
        coalesce(s.candidate_unique_key, '') as candidate_unique_key,
        coalesce(s.candidate_base_no, '') as candidate_base_no,
        coalesce(s.candidate_branch_no, '') as candidate_branch_no,
        coalesce(s.confirmed_unique_key, '') as confirmed_unique_key,
        coalesce(s.confirmed_base_no, '') as confirmed_base_no,
        coalesce(s.confirmed_branch_no, '') as confirmed_branch_no,
        s.source_site,
        s.source_priority,
        coalesce(s.note, '') as note,
        coalesce(s.title, '') as title,
        coalesce(s.detail_url, '') as detail_url,
        coalesce(s.thumbnail_url, '') as thumbnail_url,
        s.last_run_id,
        s.updated_at::text as updated_at
      from duplicated d
      join cl.heydouga_4017_m002_master_staging s
        on s.candidate_unique_key = d.candidate_unique_key
      order by d.candidate_unique_key, s.source_priority, s.staging_id
    `
  );

  return result.rows;
}

async function getNeedsReviewRows(client) {
  const result = await client.query(
    `
      select
        staging_id,
        raw_id,
        review_status,
        coalesce(candidate_unique_key, '') as candidate_unique_key,
        coalesce(candidate_base_no, '') as candidate_base_no,
        coalesce(candidate_branch_no, '') as candidate_branch_no,
        coalesce(confirmed_unique_key, '') as confirmed_unique_key,
        coalesce(confirmed_base_no, '') as confirmed_base_no,
        coalesce(confirmed_branch_no, '') as confirmed_branch_no,
        source_site,
        source_priority,
        coalesce(note, '') as note,
        coalesce(title, '') as title,
        coalesce(detail_url, '') as detail_url,
        coalesce(thumbnail_url, '') as thumbnail_url,
        last_run_id,
        updated_at::text as updated_at
      from cl.heydouga_4017_m002_master_staging
      where review_status = 'needs_review'
         or candidate_unique_key is null
      order by
        coalesce(candidate_base_no, ''),
        coalesce(candidate_branch_no, ''),
        source_priority,
        staging_id
    `
  );

  return result.rows;
}

async function promoteMaster(args) {
  const client = createPgClient();

  await client.connect();
  try {
    const summary = await getMasterPromotionSummary(client);
    if (!args.apply) {
      return { applied: false, summary, rowsInserted: 0 };
    }

    const result = await client.query(
      `
        with approved as (
          select
            s.staging_id,
            coalesce(s.confirmed_unique_key, s.candidate_unique_key) as unique_key,
            coalesce(s.confirmed_base_no, s.candidate_base_no) as base_no,
            coalesce(s.confirmed_branch_no, s.candidate_branch_no) as branch_no,
            s.title,
            s.detail_url,
            s.thumbnail_url,
            s.source_site,
            s.source_priority
          from cl.heydouga_4017_m002_master_staging s
          where s.review_status = 'approved'
            and coalesce(s.confirmed_unique_key, s.candidate_unique_key) is not null
            and coalesce(s.confirmed_base_no, s.candidate_base_no) is not null
            and coalesce(s.confirmed_branch_no, s.candidate_branch_no) is not null
            and s.title is not null
        ),
        duplicate_keys as (
          select unique_key
          from approved
          group by unique_key
          having count(*) > 1
        ),
        selected as (
          select distinct on (a.unique_key)
            a.unique_key,
            a.base_no,
            a.branch_no,
            a.title,
            a.detail_url,
            a.thumbnail_url,
            a.source_site,
            a.staging_id
          from approved a
          where not exists (
            select 1
            from duplicate_keys d
            where d.unique_key = a.unique_key
          )
          and not exists (
            select 1
            from cl.heydouga_4017_m002_master m
            where m.unique_key = a.unique_key
          )
          order by a.unique_key, a.source_priority, a.staging_id
        )
        insert into cl.heydouga_4017_m002_master (
          unique_key,
          base_no,
          branch_no,
          title,
          detail_url,
          thumbnail_url,
          primary_source_site,
          primary_staging_id,
          review_status
        )
        select
          unique_key,
          base_no,
          branch_no,
          title,
          detail_url,
          thumbnail_url,
          source_site,
          staging_id,
          'approved'
        from selected
        on conflict (unique_key) do nothing
        returning unique_key
      `
    );

    return { applied: true, summary, rowsInserted: result.rowCount };
  } finally {
    await client.end();
  }
}

async function getMasterPromotionSummary(client) {
  const result = await client.query(
    `
      with approved as (
        select
          coalesce(confirmed_unique_key, candidate_unique_key) as unique_key,
          coalesce(confirmed_base_no, candidate_base_no) as base_no,
          coalesce(confirmed_branch_no, candidate_branch_no) as branch_no,
          title
        from cl.heydouga_4017_m002_master_staging
        where review_status = 'approved'
      ),
      eligible as (
        select *
        from approved
        where unique_key is not null
          and base_no is not null
          and branch_no is not null
          and title is not null
      ),
      duplicate_keys as (
        select unique_key, count(*)::integer as duplicate_count
        from eligible
        group by unique_key
        having count(*) > 1
      )
      select
        (select count(*)::integer from approved) as approved_count,
        (select count(*)::integer from eligible) as eligible_count,
        (select count(*)::integer from duplicate_keys) as duplicate_approved_key_count,
        (
          select count(*)::integer
          from eligible e
          where exists (
            select 1
            from cl.heydouga_4017_m002_master m
            where m.unique_key = e.unique_key
          )
        ) as already_master_count,
        (
          select count(*)::integer
          from eligible e
          where not exists (
            select 1
            from duplicate_keys d
            where d.unique_key = e.unique_key
          )
          and not exists (
            select 1
            from cl.heydouga_4017_m002_master m
            where m.unique_key = e.unique_key
          )
        ) as insertable_count
    `
  );

  return result.rows[0];
}

async function importStagingReview(args) {
  if (!args.reviewCsv) {
    throw new Error("staging-review-import requires --review-csv");
  }

  const rows = readCsvRows(path.resolve(args.reviewCsv));
  const prepared = prepareReviewImportRows(rows);
  const summary = summarizeReviewImport(prepared);

  if (!args.apply) {
    return { applied: false, summary };
  }
  if (prepared.invalidRows.length > 0) {
    throw new Error("staging-review-import has invalid rows; fix the CSV before --apply");
  }

  const client = createPgClient();
  let rowsUpdated = 0;

  await client.connect();
  try {
    await client.query("begin");
    for (const row of prepared.validRows) {
      const result = await client.query(
        `
          update cl.heydouga_4017_m002_master_staging
          set review_status = $2,
              confirmed_unique_key = coalesce(nullif($3, ''), confirmed_unique_key),
              confirmed_base_no = coalesce(nullif($4, ''), confirmed_base_no),
              confirmed_branch_no = coalesce(nullif($5, ''), confirmed_branch_no),
              note = coalesce(nullif($6, ''), note),
              updated_at = now()
          where staging_id = $1
            and raw_id = $7
            and updated_at = $8::timestamptz
          returning staging_id
        `,
        [
          row.stagingId,
          row.reviewStatus,
          row.confirmedUniqueKey,
          row.confirmedBaseNo,
          row.confirmedBranchNo,
          row.note,
          row.rawId,
          row.updatedAt,
        ]
      );
      if (result.rowCount !== 1) {
        throw new Error(`staging row did not match staging_id/raw_id: ${row.stagingId}/${row.rawId}`);
      }
      rowsUpdated += result.rowCount;
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }

  return { applied: true, summary, rowsUpdated };
}

function readCsvRows(csvPath) {
  const text = fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
  const records = parseCsvRecords(text);
  if (records.length < 1) return [];

  const headers = records[0].map((header) => header.trim());
  const rows = records.slice(1).filter((record) => record.some((value) => value !== "")).map((record) => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = record[index] || "";
    });
    return row;
  });
  rows.headers = headers;
  return rows;
}

function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\r") {
      if (next === "\n") i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}

function prepareReviewImportRows(rows) {
  const validStatuses = new Set(["pending", "approved", "rejected", "needs_review"]);
  const headers = new Set(rows.headers || []);
  const requiredHeaders = ["staging_id", "raw_id", "review_status", "updated_at"];
  const validRows = [];
  const invalidRows = [];

  const missingHeaders = requiredHeaders.filter((header) => !headers.has(header));
  if (missingHeaders.length > 0) {
    return {
      validRows,
      invalidRows: [{ rowNumber: 1, errors: `missing_headers:${missingHeaders.join("|")}` }],
      rowsRead: rows.length,
    };
  }

  rows.forEach((row, index) => {
    const stagingId = Number(row.staging_id || row.stagingId);
    const rawId = Number(row.raw_id || row.rawId);
    const reviewStatus = String(row.review_status || "").trim();
    const updatedAt = String(row.updated_at || "").trim();
    const candidateUniqueKey = String(row.candidate_unique_key || "").trim();
    const candidateBaseNo = String(row.candidate_base_no || "").trim();
    const candidateBranchNo = String(row.candidate_branch_no || "").trim();
    const confirmedUniqueKey = String(row.confirmed_unique_key || "").trim();
    const confirmedBaseNo = String(row.confirmed_base_no || "").trim();
    const confirmedBranchNo = String(row.confirmed_branch_no || "").trim();
    const effectiveUniqueKey = confirmedUniqueKey || candidateUniqueKey;
    const effectiveBaseNo = confirmedBaseNo || candidateBaseNo;
    const effectiveBranchNo = confirmedBranchNo || candidateBranchNo;
    const errors = [];

    if (!Number.isInteger(stagingId) || stagingId < 1) {
      errors.push("invalid_staging_id");
    }
    if (!Number.isInteger(rawId) || rawId < 1) {
      errors.push("invalid_raw_id");
    }
    if (!validStatuses.has(reviewStatus)) {
      errors.push("invalid_review_status");
    }
    if (!updatedAt) {
      errors.push("missing_updated_at");
    }
    if (reviewStatus === "approved") {
      if (!effectiveUniqueKey || !effectiveBaseNo || !effectiveBranchNo) {
        errors.push("approved_key_incomplete");
      } else if (effectiveUniqueKey !== `${effectiveBaseNo}-${effectiveBranchNo}`) {
        errors.push("approved_key_mismatch");
      } else if (!/^[0-9]{1,5}-[0-9A-Za-z]+$/.test(effectiveUniqueKey)) {
        errors.push("approved_key_format");
      }
    }

    if (errors.length > 0) {
      invalidRows.push({ rowNumber: index + 2, errors: errors.join(";") });
      return;
    }

    validRows.push({
      stagingId,
      rawId,
      reviewStatus,
      updatedAt,
      confirmedUniqueKey,
      confirmedBaseNo,
      confirmedBranchNo,
      note: String(row.note || "").trim(),
    });
  });

  return { validRows, invalidRows, rowsRead: rows.length };
}

function summarizeReviewImport(prepared) {
  const byStatus = {};
  for (const row of prepared.validRows) {
    byStatus[row.reviewStatus] = (byStatus[row.reviewStatus] || 0) + 1;
  }

  return {
    rows_read: prepared.rowsRead,
    valid_rows: prepared.validRows.length,
    invalid_rows: prepared.invalidRows.length,
    by_review_status: byStatus,
    invalid_samples: prepared.invalidRows.slice(0, 20),
  };
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

  if (args.step === "staging-review-export") {
    const result = await exportStagingReview(args);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          source_name: SOURCE_NAME,
          step: args.step,
          env_file_loaded: Boolean(loadedEnv),
          run_id: result.runId,
          summary: result.summary,
          output_paths: result.outputPaths,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (args.step === "master-promote") {
    const result = await promoteMaster(args);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          source_name: SOURCE_NAME,
          step: args.step,
          dry_run: !args.apply,
          env_file_loaded: Boolean(loadedEnv),
          promotion: result,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (args.step === "staging-review-import") {
    if (!args.apply) {
      const result = await importStagingReview(args);
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            source_name: SOURCE_NAME,
            step: args.step,
            dry_run: true,
            env_file_loaded: Boolean(loadedEnv),
            import: result,
          },
          null,
          2
        )}\n`
      );
      return;
    }

    const result = await importStagingReview(args);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          source_name: SOURCE_NAME,
          step: args.step,
          dry_run: false,
          env_file_loaded: Boolean(loadedEnv),
          import: result,
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
