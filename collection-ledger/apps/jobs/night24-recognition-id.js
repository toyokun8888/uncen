"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildRecognitionPlan } = require("../../packages/domain/src/night24-recognition-id");

const ROOT = path.resolve(__dirname, "..", "..");
const EXPORT_DIR = path.join(ROOT, "storage", "exports", "night24");
const MIGRATION_FILE = path.join(ROOT, "ops", "sql", "151_night24_recognition_ids.sql");

function parseArgs(argv) {
  const args = { envFile: "", planFile: "", outputFile: "", apply: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env-file") args.envFile = argv[++i] || "";
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice(11);
    else if (arg === "--plan-file") args.planFile = argv[++i] || "";
    else if (arg.startsWith("--plan-file=")) args.planFile = arg.slice(12);
    else if (arg === "--output-file") args.outputFile = argv[++i] || "";
    else if (arg.startsWith("--output-file=")) args.outputFile = arg.slice(14);
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else throw new Error("unknown_argument:" + arg);
  }
  if (args.apply && !args.planFile) throw new Error("apply_requires_dry_run_plan_file");
  if (args.envFile) args.envFile = path.resolve(args.envFile);
  if (args.planFile) args.planFile = path.resolve(args.planFile);
  if (args.outputFile) args.outputFile = path.resolve(args.outputFile);
  return args;
}

function inside(file, base) {
  const target = path.resolve(file).toLowerCase();
  const root = path.resolve(base).toLowerCase();
  return target === root || target.startsWith(root + path.sep.toLowerCase());
}
function runId() { return new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + crypto.randomBytes(4).toString("hex"); }
function quote(value) { return "\"" + String(value === null || value === undefined ? "" : value).replace(/\"/g, "\"\"") + "\""; }
function writeCsv(file, rows) {
  const columns = ["run_id", "status", "recognition_id", "movie_code", "title"];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [columns.map(quote).join(",")].concat(rows.map((row) => columns.map((column) => quote(row[column])).join(","))).join("\r\n") + "\r\n", "utf8");
}
function readCsv(text) {
  const all = [];
  let row = [];
  let field = "";
  let quoted = false;
  const value = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted && char === "\"" && value[i + 1] === "\"") { field += "\""; i++; }
    else if (char === "\"") quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if (char === "\n" && !quoted) {
      row.push(field.replace(/\r$/, ""));
      if (row.some((item) => item !== "")) all.push(row);
      row = []; field = "";
    } else field += char;
  }
  if (row.length || field) { row.push(field.replace(/\r$/, "")); if (row.some((item) => item !== "")) all.push(row); }
  if (!all.length) return [];
  const headers = all.shift();
  return all.map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] || ""])));
}
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
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
function makeDbClient() {
  const { Client } = require("pg");
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) return new Client({ connectionString: url });
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
async function withDb(args, action) {
  loadEnv(args.envFile);
  const db = makeDbClient();
  await db.connect();
  try { return await action(db); } finally { await db.end(); }
}
async function loadPlan(db) {
  const masters = await db.query("select movie_code,title from cl.night24_tm001_master");
  if (!masters.rowCount) throw new Error("night24_master_is_empty");
  const table = await db.query("select to_regclass('cl.night24_tm012_recognition_ids') as relation");
  const mappings = table.rows[0].relation
    ? await db.query("select movie_code,recognition_id from cl.night24_tm012_recognition_ids")
    : { rows: [] };
  const plan = buildRecognitionPlan(masters.rows, mappings.rows);
  return { masterCount: masters.rowCount, mappedCount: mappings.rows.length, plan };
}
function outputPath(args, id) {
  const file = args.outputFile || path.join(EXPORT_DIR, "night24-recognition-ids-" + id + ".csv");
  if (!inside(file, EXPORT_DIR) || path.extname(file).toLowerCase() !== ".csv") throw new Error("output_must_be_night24_export_csv");
  return file;
}
function readExpectedPlan(file) {
  if (!inside(file, EXPORT_DIR) || path.extname(file).toLowerCase() !== ".csv") throw new Error("plan_must_be_night24_export_csv");
  const rows = readCsv(fs.readFileSync(file, "utf8"));
  if (rows.some((row) => row.status !== "planned" || !/^ngt\d{3,}$/.test(row.recognition_id || ""))) throw new Error("plan_file_contains_invalid_rows");
  return rows.map(({ recognition_id, movie_code, title }) => ({ recognition_id, movie_code, title }));
}
function samePlan(expected, actual) {
  return expected.length === actual.length && expected.every((row, index) =>
    row.recognition_id === actual[index].recognition_id &&
    row.movie_code === actual[index].movie_code &&
    row.title === actual[index].title
  );
}
async function recognitionIds(args) {
  const id = runId();
  const output = outputPath(args, id);
  if (args.apply) {
    const expected = readExpectedPlan(args.planFile);
    const migration = fs.readFileSync(MIGRATION_FILE, "utf8").replace(/^\uFEFF/, "");
    await withDb(args, async (db) => {
      await db.query("begin");
      let transactionOpen = true;
      try {
        await db.query(migration);
        await db.query("lock table cl.night24_tm001_master in share row exclusive mode");
        await db.query("lock table cl.night24_tm012_recognition_ids in share row exclusive mode");
        const current = await loadPlan(db);
        if (!samePlan(expected, current.plan)) throw new Error("recognition_plan_changed_rerun_dry_run");
        for (const row of current.plan) {
          await db.query(
            "insert into cl.night24_tm012_recognition_ids (recognition_id,movie_code) values ($1,$2)",
            [row.recognition_id, row.movie_code]
          );
        }
        const verified = await db.query(
          "select (select count(*) from cl.night24_tm001_master)::integer as masters,(select count(*) from cl.night24_tm012_recognition_ids)::integer as mapped,(select count(*) from cl.night24_tm001_master master left join cl.night24_tm012_recognition_ids ids on ids.movie_code=master.movie_code where ids.movie_code is null)::integer as missing,(select count(distinct recognition_id) from cl.night24_tm012_recognition_ids)::integer as unique_ids"
        );
        const result = verified.rows[0];
        if (result.masters !== result.mapped || result.missing !== 0 || result.unique_ids !== result.mapped) {
          throw new Error("recognition_id_postcheck_failed:" + JSON.stringify(result));
        }
        await db.query("commit");
        transactionOpen = false;
        const finalRows = current.plan.map((row) => ({ run_id: id, status: "assigned", ...row }));
        writeCsv(output, finalRows);
        process.stdout.write(JSON.stringify({ mode: "apply", assigned: finalRows.length, total: result.masters, output }) + "\n");
      } catch (error) {
        if (transactionOpen) await db.query("rollback");
        throw error;
      }
    });
    return;
  }

  const current = await withDb(args, loadPlan);
  const rows = current.plan.map((row) => ({ run_id: id, status: "planned", ...row }));
  writeCsv(output, rows);
  process.stdout.write(JSON.stringify({
    mode: "dry-run",
    total: current.masterCount,
    already_assigned: current.mappedCount,
    planned: rows.length,
    first: rows[0] ? { recognition_id: rows[0].recognition_id, title: rows[0].title } : null,
    last: rows.at(-1) ? { recognition_id: rows.at(-1).recognition_id, title: rows.at(-1).title } : null,
    output,
  }) + "\nDRY-RUN: no database objects or records changed.\n");
}

const args = parseArgs(process.argv);
recognitionIds(args).catch((error) => {
  process.stderr.write(String(error.stack || error) + "\n");
  process.exitCode = 1;
});