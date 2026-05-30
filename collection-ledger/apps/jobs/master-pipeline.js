"use strict";

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const PACO_BASE_URL = "https://www.caribbeancom.com";
const PACO_LIST_URL = `${PACO_BASE_URL}/listpages/paco/all{page}.htm`;
const PACO_SOURCE_NAME = "paco";
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;

function parseArgs(argv) {
  const args = {
    source: PACO_SOURCE_NAME,
    step: "collect",
    dryRun: false,
    startPage: 1,
    maxPages: 1,
    limit: 0,
    writeJson: false,
    envFile: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--write-json") {
      args.writeJson = true;
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg === "--source") {
      args.source = argv[++i];
    } else if (arg.startsWith("--step=")) {
      args.step = arg.slice("--step=".length);
    } else if (arg === "--step") {
      args.step = argv[++i];
    } else if (arg.startsWith("--start-page=")) {
      args.startPage = parsePositiveInt(arg.slice("--start-page=".length), "start-page");
    } else if (arg === "--start-page") {
      args.startPage = parsePositiveInt(argv[++i], "start-page");
    } else if (arg.startsWith("--max-pages=")) {
      args.maxPages = parsePositiveInt(arg.slice("--max-pages=".length), "max-pages");
    } else if (arg === "--max-pages") {
      args.maxPages = parsePositiveInt(argv[++i], "max-pages");
    } else if (arg.startsWith("--limit=")) {
      args.limit = parseNonNegativeInt(arg.slice("--limit=".length), "limit");
    } else if (arg === "--limit") {
      args.limit = parseNonNegativeInt(argv[++i], "limit");
    } else if (arg.startsWith("--env-file=")) {
      args.envFile = arg.slice("--env-file=".length);
    } else if (arg === "--env-file") {
      args.envFile = argv[++i];
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

function buildRunId(sourceName) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${sourceName}_master_collect_${stamp}_${process.pid}`;
}

function buildPacoListUrl(pageNumber) {
  return PACO_LIST_URL.replace("{page}", String(pageNumber));
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

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const bytes = await response.arrayBuffer();
  return new TextDecoder("euc-jp").decode(bytes);
}

function parsePacoEntries(html, pageUrl, pageNumber) {
  const $ = cheerio.load(html);
  const rows = [];

  $(".entry").each((index, element) => {
    const entry = $(element);
    const detailPath =
      entry.find(".meta-title a").attr("href") || entry.find(".media-thum a").attr("href") || "";
    const dateText = entry
      .find(".entry-meta .meta-data")
      .first()
      .text()
      .trim();
    const title = cleanText(entry.find(".meta-title a").text());
    const actorName = entry
      .find('[itemprop="actor"] [itemprop="name"]')
      .map((_, actor) => cleanText($(actor).text()))
      .get()
      .filter(Boolean)
      .join(",");
    const channelName = cleanText(entry.find(".tag-channel").first().text());
    const thumbnailUrl = normalizeUrl(entry.find("img.media-image").attr("src"), pageUrl);

    if (!detailPath || !dateText || !title) {
      return;
    }

    const movieCode = firstMatch(detailPath, /\/moviepages\/([^/]+)\/index\.html/);
    const relationKey = dateToMmddyy(dateText);
    const suffix = movieCode ? firstMatch(movieCode, /^[0-9]{6}_(.+)$/) : "";
    const movieDateKey = movieCode ? movieCode.slice(0, 6) : "";
    const relationKeyMatchesMovieCode = movieDateKey === relationKey;

    rows.push({
      relation_key_mmddyy: relationKey,
      release_date: dateText,
      movie_code: movieCode || "",
      movie_code_suffix: suffix || "",
      title,
      actor_name: actorName,
      channel_name: channelName,
      detail_path: detailPath,
      detail_url: normalizeUrl(detailPath, pageUrl),
      thumbnail_url: thumbnailUrl,
      source_page_url: pageUrl,
      page_number: pageNumber,
      row_index_in_page: index + 1,
      relation_key_matches_movie_code: relationKeyMatchesMovieCode,
      raw_payload: {
        detail_path: detailPath,
        date_text: dateText,
        title_text: title,
        actor_text: actorName,
        channel_text: channelName,
        thumbnail_url: thumbnailUrl,
        movie_code: movieCode || "",
        page_url: pageUrl,
        row_index_in_page: index + 1,
        relation_key_matches_movie_code: relationKeyMatchesMovieCode,
      },
    });
  });

  return rows;
}

function warnForParseAnomalies(rows) {
  for (const row of rows) {
    if (!row.relation_key_matches_movie_code) {
      process.stderr.write(
        `warning: relation key mismatch page=${row.page_number} row=${row.row_index_in_page} ` +
          `release=${row.relation_key_mmddyy} movie_code=${row.movie_code}\n`
      );
    }
  }
}

function firstMatch(value, regex) {
  const match = String(value || "").match(regex);
  return match ? match[1] : "";
}

function cleanText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return new URL(raw, baseUrl).toString();
}

function dateToMmddyy(dateText) {
  const match = String(dateText || "").match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/);
  if (!match) {
    throw new Error(`Invalid date: ${dateText}`);
  }

  return `${match[2]}${match[3]}${match[1].slice(2)}`;
}

function validatePacoRows(rows) {
  for (const row of rows) {
    if (!row.relation_key_mmddyy.match(/^[0-9]{6}$/)) {
      throw new Error(`Invalid relation_key_mmddyy: ${row.relation_key_mmddyy}`);
    }
    if (!row.movie_code.match(/^[0-9]{6}_.+$/)) {
      throw new Error(`Invalid movie_code: ${row.movie_code}`);
    }
  }
}

async function collectPacoMaster(args) {
  const runId = buildRunId(PACO_SOURCE_NAME);
  const rows = [];
  const pageLogs = [];

  for (let offset = 0; offset < args.maxPages; offset += 1) {
    const pageNumber = args.startPage + offset;
    const pageUrl = buildPacoListUrl(pageNumber);
    const html = await fetchHtml(pageUrl);
    const pageRows = parsePacoEntries(html, pageUrl, pageNumber);
    warnForParseAnomalies(pageRows);
    const remaining = args.limit > 0 ? args.limit - rows.length : pageRows.length;
    const selectedRows = args.limit > 0 ? pageRows.slice(0, Math.max(remaining, 0)) : pageRows;

    rows.push(...selectedRows);
    pageLogs.push({
      run_id: runId,
      page_number: pageNumber,
      page_url: pageUrl,
      status: "success",
      rows_found: pageRows.length,
      rows_written: selectedRows.length,
    });

    if (args.limit > 0 && rows.length >= args.limit) {
      break;
    }

    if (offset < args.maxPages - 1) {
      const waitMs = randomDelayMs();
      process.stderr.write(`wait ${waitMs}ms before next page\n`);
      await sleep(waitMs);
    }
  }

  validatePacoRows(rows);

  if (args.writeJson) {
    writeDryRunJson(runId, rows, pageLogs);
  }

  if (!args.dryRun) {
    await insertPacoRows(runId, rows, pageLogs);
  }

  return { runId, rows, pageLogs };
}

function writeDryRunJson(runId, rows, pageLogs) {
  const outputDir = path.resolve(__dirname, "..", "..", "storage", "exports", "paco");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${runId}_dry_run.json`);

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        run_id: runId,
        source_name: PACO_SOURCE_NAME,
        dry_run: true,
        page_logs: pageLogs,
        rows,
      },
      null,
      2
    ),
    "utf8"
  );

  process.stderr.write(`dry-run json written: ${outputPath}\n`);
}

async function insertPacoRows(runId, rows, pageLogs) {
  const client = createPgClient();

  await client.connect();

  try {
    await client.query("begin");
    await client.query(
      `
        insert into cl.paco_m001_master_collect_runs (
          run_id, source_name, mode, status, pages_requested, pages_processed, rows_collected
        )
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [runId, PACO_SOURCE_NAME, "collect", "running", pageLogs.length, pageLogs.length, rows.length]
    );

    for (const pageLog of pageLogs) {
      await client.query(
        `
          insert into cl.paco_m001_master_page_logs (
            run_id, page_number, page_url, status, rows_found, rows_written
          )
          values ($1, $2, $3, $4, $5, $6)
        `,
        [
          pageLog.run_id,
          pageLog.page_number,
          pageLog.page_url,
          pageLog.status,
          pageLog.rows_found,
          pageLog.rows_written,
        ]
      );
    }

    for (const row of rows) {
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
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14::jsonb, $15
          )
          on conflict (movie_code) do update set
            release_date = excluded.release_date,
            relation_key_mmddyy = excluded.relation_key_mmddyy,
            movie_code_suffix = excluded.movie_code_suffix,
            title = excluded.title,
            actor_name = excluded.actor_name,
            channel_name = excluded.channel_name,
            detail_path = excluded.detail_path,
            detail_url = excluded.detail_url,
            thumbnail_url = excluded.thumbnail_url,
            source_page_url = excluded.source_page_url,
            page_number = excluded.page_number,
            row_index_in_page = excluded.row_index_in_page,
            raw_payload = excluded.raw_payload,
            last_run_id = excluded.last_run_id,
            collected_at = now(),
            updated_at = now()
          returning id
        `,
        [
          row.relation_key_mmddyy,
          row.release_date,
          row.movie_code,
          row.movie_code_suffix,
          row.title,
          row.actor_name,
          row.channel_name,
          row.detail_path,
          row.detail_url,
          row.thumbnail_url,
          row.source_page_url,
          row.page_number,
          row.row_index_in_page,
          JSON.stringify(row.raw_payload),
          runId,
        ]
      );

      const rawId = rawResult.rows[0].id;

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
            last_run_id
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          on conflict (movie_code) do update set
            release_date = excluded.release_date,
            relation_key_mmddyy = excluded.relation_key_mmddyy,
            movie_code_suffix = excluded.movie_code_suffix,
            title = excluded.title,
            actor_name = excluded.actor_name,
            channel_name = excluded.channel_name,
            detail_url = excluded.detail_url,
            thumbnail_url = excluded.thumbnail_url,
            raw_id = excluded.raw_id,
            last_run_id = excluded.last_run_id,
            review_status = 'pending',
            approved = false,
            staged_at = now(),
            updated_at = now()
        `,
        [
          row.relation_key_mmddyy,
          row.release_date,
          row.movie_code,
          row.movie_code_suffix,
          row.title,
          row.actor_name,
          row.channel_name,
          row.detail_url,
          row.thumbnail_url,
          rawId,
          runId,
        ]
      );
    }

    await client.query(
      `
        update cl.paco_m001_master_collect_runs
        set finished_at = now(),
            status = 'success',
            rows_inserted = $2
        where run_id = $1
      `,
      [runId, rows.length]
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

async function initPacoDb() {
  const sqlPath = path.resolve(__dirname, "..", "..", "ops", "sql", "010_paco_master.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = createPgClient();

  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function getPacoDbStatus() {
  const client = createPgClient();

  await client.connect();
  try {
    const result = await client.query(
      `
        select
          (select count(*)::integer from cl.paco_m001_master_raw) as raw_count,
          (select count(*)::integer from cl.paco_m001_master_staging) as staging_count,
          (select count(*)::integer from cl.paco_m001_master_collect_runs) as run_count,
          (select count(*)::integer from cl.paco_m001_master_page_logs) as page_log_count
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

function printSummary(result, dryRun) {
  const preview = result.rows.map((row) => ({
    relation_key_mmddyy: row.relation_key_mmddyy,
    release_date: row.release_date,
    movie_code: row.movie_code,
    title: row.title,
    actor_name: row.actor_name,
    thumbnail_url: row.thumbnail_url,
  }));

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        dry_run: dryRun,
        run_id: result.runId,
        rows: result.rows.length,
        pages: result.pageLogs,
        preview,
      },
      null,
      2
    )}\n`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);

  if (args.source !== PACO_SOURCE_NAME) {
    throw new Error(`Unsupported source: ${args.source}`);
  }

  if (args.step === "init-db") {
    await initPacoDb();
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          source: PACO_SOURCE_NAME,
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
    const status = await getPacoDbStatus();
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          source: PACO_SOURCE_NAME,
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

  if (args.step !== "collect") {
    throw new Error(`Unsupported step for now: ${args.step}`);
  }

  const result = await collectPacoMaster(args);
  printSummary(result, args.dryRun);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
