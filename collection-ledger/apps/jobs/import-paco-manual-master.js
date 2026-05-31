const fs = require("fs");
const path = require("path");

const PACO_SOURCE_NAME = "paco";
const DEFAULT_CSV_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "storage",
  "exports",
  "owned-relation-check",
  "paco_missing_master_manual_input_20260531.csv"
);

function parseArgs(argv) {
  const args = {
    source: PACO_SOURCE_NAME,
    csvPath: DEFAULT_CSV_PATH,
    dryRun: false,
    envFile: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--source") {
      args.source = argv[++i];
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg === "--csv") {
      args.csvPath = path.resolve(argv[++i]);
    } else if (arg.startsWith("--csv=")) {
      args.csvPath = path.resolve(arg.slice("--csv=".length));
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, ""));
  return rows
    .filter((values) => values.some((value) => String(value || "").trim()))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function normalizeRow(rawRow) {
  const movieCode = String(rawRow.movie_code || "").trim();
  const relationKey = String(rawRow.relation_key_mmddyy || "").trim();
  const title = String(rawRow.title || "").trim();
  const actorName = String(rawRow.actor_name || "").trim();

  return {
    row_no: String(rawRow.row_no || "").trim(),
    movie_code: movieCode,
    relation_key_mmddyy: relationKey,
    release_date: relationKeyToDate(relationKey),
    movie_code_suffix: movieCode.includes("_") ? movieCode.split("_").slice(1).join("_") : "",
    title,
    actor_name: actorName,
    channel_name: "paco",
    detail_path: `/moviepages/${movieCode}/index.html`,
    detail_url: `https://www.caribbeancom.com/moviepages/${movieCode}/index.html`,
    thumbnail_url: "",
    source_page_url: "manual:paco_missing_master_manual_input_20260531.csv",
    source_file_name: String(rawRow.source_file_name || "").trim(),
    source_file_path: String(rawRow.source_file_path || "").trim(),
    note: String(rawRow.note || "").trim(),
  };
}

function relationKeyToDate(relationKey) {
  const match = String(relationKey || "").match(/^([0-9]{2})([0-9]{2})([0-9]{2})$/);
  if (!match) {
    throw new Error(`Invalid relation_key_mmddyy: ${relationKey}`);
  }

  return `20${match[3]}-${match[1]}-${match[2]}`;
}

function validateRows(rows) {
  const seen = new Set();
  const warnings = [];

  for (const row of rows) {
    if (!row.movie_code.match(/^[0-9]{6}_.+$/)) {
      throw new Error(`Invalid movie_code row=${row.row_no}: ${row.movie_code}`);
    }
    if (!row.relation_key_mmddyy.match(/^[0-9]{6}$/)) {
      throw new Error(`Invalid relation_key_mmddyy row=${row.row_no}: ${row.relation_key_mmddyy}`);
    }
    if (!row.title) {
      throw new Error(`Missing title row=${row.row_no} movie_code=${row.movie_code}`);
    }
    if (seen.has(row.movie_code)) {
      throw new Error(`Duplicate movie_code in CSV: ${row.movie_code}`);
    }
    if (!row.actor_name) {
      warnings.push(`row=${row.row_no} movie_code=${row.movie_code} actor_name is blank`);
    }
    seen.add(row.movie_code);
  }

  return warnings;
}

async function findExistingMovieCodes(client, movieCodes) {
  const result = await client.query(
    `
      select movie_code
      from cl.paco_m001_master_staging
      where movie_code = any($1::text[])
      order by movie_code
    `,
    [movieCodes]
  );

  return result.rows.map((row) => row.movie_code);
}

async function importRows(client, rows, runId) {
  await client.query("begin");
  try {
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
            $1, $2, $3, $4, $5, $6, $7, $8, $9, '',
            $10, 0, $11, $12::jsonb, $13
          )
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
          row.source_page_url,
          Number(row.row_no || 0),
          JSON.stringify({
            import_type: "manual_missing_master",
            row_no: row.row_no,
            movie_code: row.movie_code,
            relation_key_mmddyy: row.relation_key_mmddyy,
            source_file_name: row.source_file_name,
            source_file_path: row.source_file_path,
            note: row.note,
          }),
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
            review_status,
            approved,
            note,
            last_run_id
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, '', $9, 'manual_added', true, $10, $11)
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
          rawId,
          row.note || "manual missing master import",
          runId,
        ]
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);

  if (args.source !== PACO_SOURCE_NAME) {
    throw new Error(`Unsupported source: ${args.source}`);
  }
  if (!fs.existsSync(args.csvPath)) {
    throw new Error(`CSV not found: ${args.csvPath}`);
  }

  const rows = parseCsv(fs.readFileSync(args.csvPath, "utf8")).map(normalizeRow);
  const warnings = validateRows(rows);
  const runId = `paco_manual_master_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}_${process.pid}`;
  const client = createPgClient();

  await client.connect();
  try {
    const existingMovieCodes = await findExistingMovieCodes(
      client,
      rows.map((row) => row.movie_code)
    );

    if (existingMovieCodes.length > 0) {
      throw new Error(`CSV contains movie_code already in master: ${existingMovieCodes.join(", ")}`);
    }

    if (!args.dryRun) {
      await importRows(client, rows, runId);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          dry_run: args.dryRun,
          env_file_loaded: Boolean(loadedEnv),
          csv_path: args.csvPath,
          run_id: runId,
          rows: rows.length,
          warnings,
          preview: rows.map((row) => ({
            movie_code: row.movie_code,
            relation_key_mmddyy: row.relation_key_mmddyy,
            release_date: row.release_date,
            title: row.title,
            actor_name: row.actor_name,
          })),
        },
        null,
        2
      )}\n`
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
