"use strict";

const fs = require("fs");
const path = require("path");

const SOURCE_NAME = "heydouga_4017";
const DEFAULT_INPUT_DIR = "P:\\uncen\\heydouga_4017_thumbnails";
const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "storage", "thumbnails", SOURCE_NAME, "master");
const EXPORT_DIR = path.resolve(__dirname, "..", "..", "storage", "exports", SOURCE_NAME);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function parseArgs(argv) {
  const args = { step: "review", inputDir: DEFAULT_INPUT_DIR, envFile: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--step") args.step = argv[++i];
    else if (arg.startsWith("--step=")) args.step = arg.slice("--step=".length);
    else if (arg === "--input-dir") args.inputDir = argv[++i];
    else if (arg.startsWith("--input-dir=")) args.inputDir = arg.slice("--input-dir=".length);
    else if (arg === "--env-file") args.envFile = argv[++i];
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice("--env-file=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnvFile(envFile) {
  const candidates = [];
  if (envFile) candidates.push(path.resolve(envFile));
  candidates.push(path.resolve(__dirname, "..", "..", ".env"));
  const target = candidates.find((candidate) => fs.existsSync(candidate));
  if (!target) return "";

  for (const rawLine of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  return target;
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function createPgClient() {
  const { Client } = require("pg");
  const database = process.env.PGDATABASE || process.env.DB_NAME;
  const user = process.env.PGUSER || process.env.DB_USER;
  if (!database || !user) throw new Error("DB connection is not configured. Set PGDATABASE/PGUSER or DB_NAME/DB_USER.");
  return new Client({
    host: process.env.PGHOST || process.env.DB_HOST || "localhost",
    port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
    database,
    user,
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD,
  });
}

async function fetchMasterMap(client) {
  const result = await client.query(
    `
      select unique_key, title, thumbnail_file_path
      from cl.heydouga_4017_m002_master
    `
  );
  return new Map(result.rows.map((row) => [row.unique_key, row]));
}

function listImageFiles(inputDir) {
  const files = [];
  if (!fs.existsSync(inputDir)) return files;

  const stack = [inputDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function buildPlan(inputDir, masterMap) {
  const files = listImageFiles(inputDir);
  const keyCounts = new Map();
  for (const filePath of files) {
    const uniqueKey = path.parse(filePath).name.trim();
    keyCounts.set(uniqueKey, (keyCounts.get(uniqueKey) || 0) + 1);
  }

  return files.map((filePath) => {
    const parsed = path.parse(filePath);
    const uniqueKey = parsed.name.trim();
    const ext = parsed.ext.toLowerCase() === ".jpeg" ? ".jpg" : parsed.ext.toLowerCase();
    const master = masterMap.get(uniqueKey) || null;
    const outputPath = path.join(OUTPUT_DIR, `${uniqueKey}${ext}`);
    const sourceStat = safeStat(filePath);
    const outputStat = safeStat(outputPath);
    const status = classifyRow({ uniqueKey, master, duplicateCount: keyCounts.get(uniqueKey) || 0, sourceStat, outputStat });

    return {
      status,
      unique_key: uniqueKey,
      master_title: master?.title || "",
      source_path: filePath,
      output_path: outputPath,
      output_file_name: path.basename(outputPath),
      source_bytes: sourceStat?.size || "",
      output_exists: outputStat ? "yes" : "no",
      existing_thumbnail_file_path: master?.thumbnail_file_path || "",
    };
  });
}

function classifyRow({ uniqueKey, master, duplicateCount, sourceStat }) {
  if (!uniqueKey) return "invalid_file_name";
  if (!/^[0-9]+(?:-[0-9A-Za-z]+)?$/.test(uniqueKey)) return "invalid_unique_key";
  if (duplicateCount > 1) return "duplicate_unique_key";
  if (!sourceStat || sourceStat.size <= 0) return "invalid_image_file";
  if (!master) return "missing_master";
  return "ready";
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

async function applyPlan(client, plan) {
  const unsafe = plan.filter((row) => row.status !== "ready");
  if (unsafe.length > 0) throw new Error(`Manual thumbnail plan has unsafe rows: ${unsafe.length}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  await client.query("begin");
  try {
    let moved = 0;
    let updated = 0;
    for (const row of plan) {
      moveReplacing(row.source_path, row.output_path);
      moved += 1;
      const result = await client.query(
        `
          update cl.heydouga_4017_m002_master
          set thumbnail_file_path = $2,
              updated_at = now()
          where unique_key = $1
        `,
        [row.unique_key, row.output_path]
      );
      updated += result.rowCount;
    }
    await client.query("commit");
    return { moved, updated };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

function moveReplacing(sourcePath, outputPath) {
  const tempPath = `${outputPath}.manual-${process.pid}-${Date.now()}.tmp`;
  fs.copyFileSync(sourcePath, tempPath);
  fs.renameSync(tempPath, outputPath);
  fs.unlinkSync(sourcePath);
}

async function getSummary(client) {
  const result = await client.query(
    `
      select
        count(*)::integer as master_count,
        count(*) filter (where coalesce(thumbnail_file_path, '') <> '')::integer as with_thumbnail_file_path,
        count(*) filter (where coalesce(thumbnail_url, '') <> '')::integer as with_thumbnail_url
      from cl.heydouga_4017_m002_master
    `
  );
  return result.rows[0];
}

function writePlanCsv(plan, label) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const outputPath = path.join(EXPORT_DIR, `${SOURCE_NAME}_manual_thumbnail_${label}_${stamp}.csv`);
  const columns = [
    "status",
    "unique_key",
    "master_title",
    "source_path",
    "output_path",
    "output_file_name",
    "source_bytes",
    "output_exists",
    "existing_thumbnail_file_path",
  ];
  const lines = [columns.join(",")];
  for (const row of plan) lines.push(columns.map((column) => escapeCsv(row[column])).join(","));
  fs.writeFileSync(outputPath, `${lines.join("\r\n")}\r\n`, "utf8");
  return outputPath;
}

function escapeCsv(value) {
  const raw = String(value ?? "");
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function summarizePlan(plan) {
  const byStatus = {};
  for (const row of plan) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  return {
    total_images: plan.length,
    by_status: byStatus,
    unsafe_preview: plan
      .filter((row) => row.status !== "ready")
      .slice(0, 20)
      .map((row) => ({
        status: row.status,
        unique_key: row.unique_key,
        source_path: row.source_path,
      })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);
  const client = createPgClient();
  await client.connect();
  try {
    const masterMap = await fetchMasterMap(client);
    const plan = buildPlan(args.inputDir, masterMap);

    if (args.step === "review") {
      const planPath = writePlanCsv(plan, "review");
      const dbSummary = await getSummary(client);
      process.stdout.write(
        `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), input_dir: args.inputDir, output_dir: OUTPUT_DIR, plan_path: planPath, summary: summarizePlan(plan), db_summary: dbSummary }, null, 2)}\n`
      );
      return;
    }

    if (args.step === "apply") {
      const result = await applyPlan(client, plan);
      const planPath = writePlanCsv(plan, "applied");
      const dbSummary = await getSummary(client);
      process.stdout.write(
        `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), input_dir: args.inputDir, output_dir: OUTPUT_DIR, plan_path: planPath, result, summary: summarizePlan(plan), db_summary: dbSummary }, null, 2)}\n`
      );
      return;
    }

    if (args.step === "status") {
      const dbSummary = await getSummary(client);
      process.stdout.write(
        `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), input_dir: args.inputDir, output_dir: OUTPUT_DIR, summary: summarizePlan(plan), db_summary: dbSummary }, null, 2)}\n`
      );
      return;
    }

    throw new Error(`Unsupported step: ${args.step}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
