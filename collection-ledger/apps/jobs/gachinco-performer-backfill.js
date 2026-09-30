"use strict";

// Manual metadata backfill. This job reads existing owned rows and only writes
// actor_names; it never changes file paths or moves videos.
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { performerForOwnedFile } = require("../../packages/domain/src/gachinco-performers");

const ROOT = path.resolve(__dirname, "..", "..");
const EXPORT_DIR = path.join(ROOT, "storage", "exports", "gachinco");
const COLUMNS = ["owned_file_id", "movie_code", "file_name", "original_file_path", "title", "previous_actor_names", "proposed_actor_names", "source", "status"];

function argsFrom(argv) {
  const args = { step: "", envFile: "", inputFile: "", outputFile: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--step") args.step = argv[++i] || "";
    else if (part === "--env-file") args.envFile = argv[++i] || "";
    else if (part === "--input-file") args.inputFile = argv[++i] || "";
    else if (part === "--output-file") args.outputFile = argv[++i] || "";
    else throw new Error("unknown_argument:" + part);
  }
  if (!["review", "apply"].includes(args.step)) throw new Error("step_must_be_review_or_apply");
  if (args.step === "apply" && !args.inputFile) throw new Error("input_file_required_for_apply");
  return args;
}

function csvCell(value) {
  const string = String(value ?? "");
  return /[",\r\n]/.test(string) ? '"' + string.replace(/"/g, '""') + '"' : string;
}

function writeCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "\uFEFF" + [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((column) => csvCell(row[column])).join(","))].join("\r\n") + "\r\n", "utf8");
}

function readCsv(file) {
  const source = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const records = [];
  let current = "";
  let row = [];
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { current += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(current); current = ""; }
    else if (char === "\n") {
      row.push(current.replace(/\r$/, ""));
      if (row.some(Boolean)) records.push(row);
      row = []; current = "";
    } else current += char;
  }
  if (quoted) throw new Error("unterminated_csv_quote");
  if (current || row.length) { row.push(current); records.push(row); }
  const header = records.shift();
  if (header?.join(",") !== COLUMNS.join(",")) throw new Error("unexpected_csv_header");
  return records.map((cells) => {
    if (cells.length !== COLUMNS.length) throw new Error("invalid_csv_row");
    return Object.fromEntries(COLUMNS.map((column, index) => [column, cells[index]]));
  });
}

function dbClient() {
  return new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
}

async function ownedRows(client) {
  const result = await client.query(`
    SELECT owned.owned_file_id::text AS owned_file_id, owned.movie_code,
           owned.file_name, owned.original_file_path,
           COALESCE(master.title, '') AS title,
           COALESCE(owned.actor_names, '') AS actor_names
    FROM cl.gachinco_tm002_owned_files AS owned
    LEFT JOIN cl.gachinco_tm001_master AS master ON master.movie_code = owned.movie_code
    ORDER BY owned.owned_file_id`);
  return result.rows;
}

function reviewRows(rows) {
  return rows.map((row) => {
    const performer = row.actor_names ? { actorNames: "", source: "existing" } : performerForOwnedFile(row);
    return {
      owned_file_id: row.owned_file_id,
      movie_code: row.movie_code,
      file_name: row.file_name,
      original_file_path: row.original_file_path,
      title: row.title,
      previous_actor_names: row.actor_names,
      proposed_actor_names: performer.actorNames,
      source: performer.source,
      status: row.actor_names ? "existing" : performer.actorNames ? "proposed" : "unresolved",
    };
  });
}

function summary(rows) {
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  const sources = {};
  for (const row of rows.filter((item) => item.status === "proposed")) sources[row.source] = (sources[row.source] || 0) + 1;
  return { rows: rows.length, counts, sources };
}

async function main() {
  const args = argsFrom(process.argv);
  if (args.envFile) require("dotenv").config({ path: path.resolve(args.envFile), quiet: true });
  const client = dbClient();
  await client.connect();
  try {
    const current = await ownedRows(client);
    if (args.step === "review") {
      const rows = reviewRows(current);
      const out = path.resolve(args.outputFile || path.join(EXPORT_DIR, "gachinco-performers-review.csv"));
      writeCsv(out, rows);
      process.stdout.write(JSON.stringify({ output: out, ...summary(rows) }) + "\n");
      return;
    }
    const reviewed = readCsv(path.resolve(args.inputFile));
    if (reviewed.length !== current.length) throw new Error("review_row_count_changed");
    const byId = new Map(current.map((row) => [row.owned_file_id, row]));
    if (byId.size !== current.length) throw new Error("duplicate_owned_file_id");
    const seen = new Set();
    for (const row of reviewed) {
      if (seen.has(row.owned_file_id)) throw new Error("duplicate_review_id:" + row.owned_file_id);
      seen.add(row.owned_file_id);
      const actual = byId.get(row.owned_file_id);
      if (!actual || actual.movie_code !== row.movie_code || actual.file_name !== row.file_name ||
          actual.original_file_path !== row.original_file_path || actual.title !== row.title ||
          actual.actor_names !== row.previous_actor_names) throw new Error("review_source_changed:" + row.owned_file_id);
      const expected = reviewRows([actual])[0];
      if (expected.proposed_actor_names !== row.proposed_actor_names || expected.source !== row.source ||
          expected.status !== row.status) throw new Error("review_proposal_changed:" + row.owned_file_id);
    }
    const toApply = reviewed.filter((row) => row.status === "proposed");
    await client.query("BEGIN");
    try {
      for (const row of toApply) {
        const result = await client.query(`
          UPDATE cl.gachinco_tm002_owned_files
          SET actor_names = $2
          WHERE owned_file_id = $1 AND COALESCE(actor_names, '') = ''
            AND movie_code = $3 AND file_name = $4 AND original_file_path = $5`,
        [row.owned_file_id, row.proposed_actor_names, row.movie_code, row.file_name, row.original_file_path]);
        if (result.rowCount !== 1) throw new Error("update_failed:" + row.owned_file_id);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const out = path.resolve(args.outputFile || path.join(EXPORT_DIR, "gachinco-performers-applied.csv"));
    writeCsv(out, reviewed.map((row) => ({ ...row, status: row.status === "proposed" ? "applied" : row.status })));
    process.stdout.write(JSON.stringify({ output: out, applied: toApply.length, ...summary(reviewed) }) + "\n");
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((error) => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
module.exports = { argsFrom, readCsv, reviewRows, summary, writeCsv };
