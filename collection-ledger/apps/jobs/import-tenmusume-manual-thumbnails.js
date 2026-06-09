"use strict";

const fs = require("fs");
const path = require("path");

const SOURCE = "10musume";
const DB_PREFIX = "tenmusume";
const DEFAULT_INPUT_DIR = "P:\\uncen\\10musume_thumbnails";
const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "storage", "thumbnails", SOURCE, "master");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function parseArgs(argv) {
  const args = { step: "review", inputDir: DEFAULT_INPUT_DIR, planCsv: "", envFile: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--step") args.step = argv[++i];
    else if (arg.startsWith("--step=")) args.step = arg.slice(7);
    else if (arg === "--input-dir") args.inputDir = argv[++i];
    else if (arg.startsWith("--input-dir=")) args.inputDir = arg.slice(12);
    else if (arg === "--plan-csv") args.planCsv = argv[++i];
    else if (arg.startsWith("--plan-csv=")) args.planCsv = arg.slice(11);
    else if (arg === "--env-file") args.envFile = argv[++i];
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice(11);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnvFile(envFile) {
  const target = [envFile, path.resolve(__dirname, "..", "..", ".env")]
    .filter(Boolean).map((candidate) => path.resolve(candidate)).find((candidate) => fs.existsSync(candidate));
  if (!target) return;
  for (const raw of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim().replace(/^\uFEFF/, "");
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
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

function listImages(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(root, entry.name));
}

function isSupportedImage(filePath) {
  const bytes = Buffer.alloc(12);
  const fd = fs.openSync(filePath, "r");
  try {
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length < 4) return false;
    const hex = bytes.subarray(0, length).toString("hex");
    return hex.startsWith("ffd8ff") ||
      hex.startsWith("89504e470d0a1a0a") ||
      (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP");
  } finally {
    fs.closeSync(fd);
  }
}

async function buildPlan(client, inputDir) {
  const masters = await client.query(`select movie_code,title from cl.${DB_PREFIX}_m003_master`);
  const masterMap = new Map(masters.rows.map((row) => [row.movie_code, row]));
  const files = listImages(inputDir);
  const counts = new Map();
  for (const file of files) counts.set(path.parse(file).name, (counts.get(path.parse(file).name) || 0) + 1);
  return files.map((file) => {
    const key = path.parse(file).name;
    const ext = path.extname(file).toLowerCase() === ".jpeg" ? ".jpg" : path.extname(file).toLowerCase();
    const stat = fs.statSync(file);
    let status = "ready";
    if (!/^[0-9]{6}_[0-9A-Za-z]+$/.test(key)) status = "invalid_unique_key";
    else if ((counts.get(key) || 0) > 1) status = "duplicate_unique_key";
    else if (!stat.size) status = "invalid_image_file";
    else if (!isSupportedImage(file)) status = "invalid_image_file";
    else if (!masterMap.has(key)) status = "missing_master";
    return { status, movie_code: key, title: masterMap.get(key)?.title || "", source_path: file, output_path: path.join(OUTPUT_DIR, `${key}${ext}`), bytes: stat.size, file_mtime: stat.mtime.toISOString() };
  });
}

function writeCsv(rows, inputDir, label) {
  fs.mkdirSync(inputDir, { recursive: true });
  const output = path.join(inputDir, `${SOURCE}_manual_thumbnail_${label}_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}.csv`);
  const columns = ["status", "movie_code", "title", "source_path", "output_path", "bytes", "file_mtime"];
  const escape = (value) => { const raw = String(value ?? ""); return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw; };
  fs.writeFileSync(output, `${[columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\r\n")}\r\n`, "utf8");
  return output;
}

function parseCsv(text) {
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); records.push(row); row = []; field = ""; }
    else field += char;
  }
  const headers = records.shift() || [];
  return records.filter((record) => record.some(Boolean)).map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] || ""])));
}

async function readApprovedPlan(client, inputDir, planCsv) {
  if (!planCsv) throw new Error("--plan-csv is required for apply");
  const inputRoot = path.resolve(inputDir).toLowerCase();
  const outputRoot = path.resolve(OUTPUT_DIR).toLowerCase();
  const rows = parseCsv(fs.readFileSync(path.resolve(planCsv), "utf8"));
  const expectedRows = await buildPlan(client, inputDir);
  const expectedBySource = new Map(expectedRows.map((row) => [path.resolve(row.source_path).toLowerCase(), row]));
  for (const row of rows) {
    if (row.status !== "ready") throw new Error(`Plan contains unsafe row: ${row.status}`);
    const source = path.resolve(row.source_path).toLowerCase();
    const output = path.resolve(row.output_path).toLowerCase();
    if (!source.startsWith(`${inputRoot}${path.sep}`) || !output.startsWith(`${outputRoot}${path.sep}`)) throw new Error(`Invalid plan path: ${row.source_path}`);
    const expected = expectedBySource.get(source);
    if (!expected) throw new Error(`Plan row is no longer valid: ${row.source_path}`);
    for (const column of ["status", "movie_code", "title", "source_path", "output_path", "bytes", "file_mtime"]) {
      if (String(row[column] || "") !== String(expected[column] || "")) throw new Error(`Plan CSV ${column} changed for ${row.source_path}`);
    }
    const stat = fs.statSync(row.source_path);
    if (!stat.isFile() || stat.size !== Number(row.bytes) || stat.mtime.getTime() !== new Date(row.file_mtime).getTime()) throw new Error(`Image changed after review: ${row.source_path}`);
    if (!isSupportedImage(row.source_path)) throw new Error(`Image is invalid: ${row.source_path}`);
    const master = await client.query(`select 1 from cl.${DB_PREFIX}_m003_master where movie_code=$1`, [row.movie_code]);
    if (!master.rowCount) throw new Error(`Master is missing: ${row.movie_code}`);
  }
  return rows;
}

async function apply(client, rows) {
  const unsafe = rows.filter((row) => row.status !== "ready");
  if (unsafe.length) throw new Error(`Manual thumbnail plan has unsafe rows: ${unsafe.length}`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const row of rows) {
    const tempPath = `${row.output_path}.manual-${process.pid}-${Date.now()}.tmp`;
    const backupPath = `${row.output_path}.manual-${process.pid}-${Date.now()}.bak`;
    fs.copyFileSync(row.source_path, tempPath);
    let committed = false;
    try {
      if (fs.existsSync(row.output_path)) fs.renameSync(row.output_path, backupPath);
      fs.renameSync(tempPath, row.output_path);
      await client.query("begin");
      await client.query(`insert into cl.${DB_PREFIX}_m003_thumbnail_assets (movie_code,local_thumbnail_path,local_thumbnail_file_name,thumbnail_status,bytes,last_checked_at,downloaded_at)
        values ($1,$2,$3,'collected',$4,now(),now()) on conflict (movie_code) do update set local_thumbnail_path=excluded.local_thumbnail_path,
        local_thumbnail_file_name=excluded.local_thumbnail_file_name,thumbnail_status='collected',bytes=excluded.bytes,last_error=null,last_checked_at=now(),downloaded_at=now(),updated_at=now()`,
      [row.movie_code, row.output_path, path.basename(row.output_path), row.bytes]);
      await client.query(`update cl.${DB_PREFIX}_m003_master set thumbnail_file_path=$2,updated_at=now() where movie_code=$1`, [row.movie_code, row.output_path]);
      await client.query("commit");
      committed = true;
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    } catch (error) {
      if (!committed) await client.query("rollback");
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (!committed) {
        if (fs.existsSync(row.output_path)) fs.unlinkSync(row.output_path);
        if (fs.existsSync(backupPath)) fs.renameSync(backupPath, row.output_path);
      }
      throw error;
    }
    try {
      fs.unlinkSync(row.source_path);
    } catch (error) {
      process.stderr.write(`warning: imported thumbnail but could not remove source image: ${row.source_path}: ${error.message}\n`);
    }
  }
  return { imported: rows.length };
}

async function main() {
  const args = parseArgs(process.argv);
  loadEnvFile(args.envFile);
  const client = createPgClient();
  await client.connect();
  try {
    const rows = args.step === "apply" ? await readApprovedPlan(client, args.inputDir, args.planCsv) : await buildPlan(client, args.inputDir);
    const outputPath = writeCsv(rows, args.inputDir, args.step);
    const result = args.step === "apply" ? await apply(client, rows) : {};
    if (!["review", "apply"].includes(args.step)) throw new Error(`Unsupported step: ${args.step}`);
    process.stdout.write(`${JSON.stringify({ ok: true, step: args.step, input_dir: args.inputDir, output_path: outputPath, result }, null, 2)}\n`);
  } finally { await client.end(); }
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
