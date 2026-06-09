"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SOURCE_NAME = "heydouga_4017";
const DEFAULT_INPUT_DIR = "F:\\uncen\\heydouga_4017_new_mp4";
const VIDEO_EXTENSIONS = new Set([".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpg", ".mpeg", ".ts", ".wmv"]);

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

function runVideoMetadataCollect(envFile) {
  const scriptPath = path.resolve(__dirname, "collect-video-metadata.js");
  const commandArgs = [scriptPath, "--source", SOURCE_NAME, "--step", "collect"];
  if (envFile) commandArgs.push("--env-file", envFile);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: path.resolve(__dirname, "..", ".."),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`video metadata collect failed: ${result.stderr || result.stdout}`);
  }
  const output = String(result.stdout || "").trim();
  const jsonStart = output.indexOf("{");
  return jsonStart >= 0 ? JSON.parse(output.slice(jsonStart)) : {};
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

function resolveDirs(inputDir) {
  const resolvedInput = path.resolve(inputDir);
  const root = path.parse(resolvedInput).root;
  if (!root || !/^[A-Za-z]:\\$/.test(root)) throw new Error(`Input directory must be on a Windows drive: ${inputDir}`);
  return {
    inputDir: resolvedInput,
    targetDir: path.join(root, "uncen", SOURCE_NAME),
    driveLetter: root.slice(0, 1).toUpperCase(),
  };
}

async function fetchMasterMap(client) {
  const result = await client.query(
    `
      select unique_key, base_no, branch_no, title
      from cl.heydouga_4017_m002_master
    `
  );
  return new Map(result.rows.map((row) => [row.unique_key, row]));
}

async function fetchOwnedPathSet(client) {
  const result = await client.query("select file_path from cl.heydouga_4017_owned_file");
  return new Set(result.rows.map((row) => normalizePath(row.file_path)));
}

function listVideoFiles(inputDir, missingIsError = true) {
  const files = [];
  const errors = [];
  if (!fs.existsSync(inputDir)) {
    if (missingIsError) errors.push({ path: inputDir, error: "input_dir_not_found" });
    return { files, errors };
  }
  const stack = [inputDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: current, error: error.code || error.message });
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
    }
  }
  return { files: files.sort((a, b) => a.localeCompare(b)), errors };
}

function parseFileName(filePath) {
  const stem = path.parse(filePath).name.trim();
  const match = stem.match(/^([0-9]{1,5})(?:[_-]([0-9A-Za-z]+))?(?:\s+(.+))?$/);
  if (!match) return { uniqueKey: "", baseNo: "", branchNo: "", titlePart: "" };
  const baseNo = match[1];
  const branchNo = normalizeBranchNo(match[2] || "");
  return {
    uniqueKey: branchNo ? `${baseNo}-${branchNo}` : baseNo,
    baseNo,
    branchNo,
    titlePart: String(match[3] || "").trim(),
  };
}

function normalizeBranchNo(branchNo) {
  const value = String(branchNo || "");
  if (/^[0-9]+$/.test(value)) return String(Number(value));
  return value;
}

function buildPlan(dirs, masterMap, ownedPathSet) {
  const scan = listVideoFiles(dirs.inputDir);
  const files = scan.files;
  const keyCounts = new Map();
  const parsedFiles = files.map((filePath) => {
    const parsed = parseFileName(filePath);
    if (parsed.uniqueKey) keyCounts.set(parsed.uniqueKey, (keyCounts.get(parsed.uniqueKey) || 0) + 1);
    return { filePath, parsed };
  });

  const rows = parsedFiles.map(({ filePath, parsed }) => {
    const master = parsed.uniqueKey ? masterMap.get(parsed.uniqueKey) || null : null;
    const targetPath = path.join(dirs.targetDir, path.basename(filePath));
    const stat = safeStat(filePath);
    const status = classifyRow({
      parsed,
      master,
      duplicateCount: keyCounts.get(parsed.uniqueKey) || 0,
      sourceStat: stat,
      targetExists: fs.existsSync(targetPath),
    });
    const masterTitle = master?.title || buildMasterTitle(parsed);
    return {
      status,
      operation: "move_and_register",
      master_action: master ? "existing_master" : status === "ready_new_master" ? "insert_master" : "",
      unique_key: parsed.uniqueKey,
      base_no: parsed.baseNo,
      branch_no: parsed.branchNo,
      title: masterTitle,
      source_path: filePath,
      target_path: targetPath,
      file_name: path.basename(filePath),
      file_ext: path.extname(filePath).replace(/^\./, "").toLowerCase(),
      drive_letter: dirs.driveLetter,
      file_size_bytes: stat?.size || "",
      file_mtime: stat?.mtime ? stat.mtime.toISOString() : "",
    };
  });
  const recoveryScan = listVideoFiles(dirs.targetDir, false);
  for (const filePath of recoveryScan.files) {
    if (ownedPathSet.has(normalizePath(filePath))) continue;
    const parsed = parseFileName(filePath);
    if (!parsed.uniqueKey) continue;
    const master = masterMap.get(parsed.uniqueKey) || null;
    const stat = safeStat(filePath);
    const status = !stat || stat.size <= 0
      ? "recovery_invalid_video_file"
      : master
        ? "ready_recover_owned"
        : "recovery_missing_master";
    rows.push({
      status,
      operation: "register_owned_only",
      master_action: master ? "existing_master" : "",
      unique_key: parsed.uniqueKey,
      base_no: parsed.baseNo,
      branch_no: parsed.branchNo,
      title: master?.title || "",
      source_path: filePath,
      target_path: filePath,
      file_name: path.basename(filePath),
      file_ext: path.extname(filePath).replace(/^\./, "").toLowerCase(),
      drive_letter: dirs.driveLetter,
      file_size_bytes: stat?.size || "",
      file_mtime: stat?.mtime ? stat.mtime.toISOString() : "",
    });
  }
  for (const error of recoveryScan.errors) scan.errors.push(error);
  for (const error of scan.errors) {
    rows.push({
      status: "scan_error",
      operation: "",
      master_action: "",
      unique_key: "",
      base_no: "",
      branch_no: "",
      title: "",
      source_path: error.path,
      target_path: "",
      file_name: "",
      file_ext: "",
      drive_letter: dirs.driveLetter,
      file_size_bytes: "",
      file_mtime: "",
      error: error.error,
    });
  }
  return rows;
}

function classifyRow({ parsed, master, duplicateCount, sourceStat, targetExists }) {
  if (!parsed.uniqueKey) return "invalid_file_name";
  if (duplicateCount > 1) return "duplicate_unique_key";
  if (!sourceStat || sourceStat.size <= 0) return "invalid_video_file";
  if (targetExists) return "target_exists";
  if (master) return "ready_existing_master";
  if (parsed.branchNo && !/^[0-9]+$/.test(parsed.branchNo)) return "invalid_new_master_branch";
  if (!parsed.titlePart) return "missing_master_title";
  return "ready_new_master";
}

function buildMasterTitle(parsed) {
  if (!parsed.uniqueKey || !parsed.titlePart) return "";
  return `Heydouga 4017 PPV${parsed.uniqueKey} ${parsed.titlePart}`;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isReady(row) {
  return row.status === "ready_existing_master" || row.status === "ready_new_master" || row.status === "ready_recover_owned";
}

async function applyPlan(client, dirs, plan) {
  const unsafe = plan.filter((row) => !isReady(row));
  if (unsafe.length > 0) throw new Error(`Import plan has unsafe rows: ${unsafe.length}`);

  fs.mkdirSync(dirs.targetDir, { recursive: true });
  const databaseResult = await prepareMasterRows(client, plan);
  let moved = 0;
  let recoveredOwned = 0;
  let upsertedOwned = 0;
  for (const row of plan) {
    if (row.operation === "move_and_register") {
      fs.renameSync(row.source_path, row.target_path);
      moved += 1;
    }
    await upsertOwnedRow(client, row);
    upsertedOwned += 1;
    if (row.operation === "register_owned_only") recoveredOwned += 1;
  }
  return { moved, recovered_owned: recoveredOwned, upserted_owned: upsertedOwned, ...databaseResult };
}

async function prepareMasterRows(client, plan) {
  await client.query("begin");
  try {
    let insertedMasters = 0;
    for (const row of plan) {
      if (row.master_action === "insert_master") {
        const result = await client.query(
          `
            insert into cl.heydouga_4017_m002_master (
              unique_key,
              base_no,
              branch_no,
              title,
              primary_source_site,
              review_status,
              note
            )
            values ($1, $2, $3, $4, 'owned_new_mp4_manual', 'manual_added', $5)
            on conflict (unique_key) do nothing
          `,
          [row.unique_key, row.base_no, row.branch_no, row.title, "Added from heydouga_4017_new_mp4 filename."]
        );
        insertedMasters += result.rowCount;
      }

      const masterResult = await client.query(
        `
          select unique_key, base_no, branch_no
          from cl.heydouga_4017_m002_master
          where unique_key = $1
          for update
        `,
        [row.unique_key]
      );
      const master = masterResult.rows[0];
      if (!master || master.base_no !== row.base_no || master.branch_no !== row.branch_no) {
        throw new Error(`Master key conflict: ${row.unique_key}`);
      }
    }
    await client.query("commit");
    return { inserted_masters: insertedMasters };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function upsertOwnedRow(client, row) {
  const targetStat = safeStat(row.target_path);
  if (!targetStat || targetStat.size <= 0) {
    throw new Error(`Target video file is missing or empty: ${row.target_path}`);
  }
  await client.query(
    `
      insert into cl.heydouga_4017_owned_file (
        movie_code,
        base_no,
        branch_no,
        file_path,
        file_name,
        file_ext,
        drive_letter,
        file_size_bytes,
        file_mtime,
        last_seen_at,
        note
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
      on conflict (file_path) do update
      set movie_code = excluded.movie_code,
          base_no = excluded.base_no,
          branch_no = excluded.branch_no,
          file_name = excluded.file_name,
          file_ext = excluded.file_ext,
          drive_letter = excluded.drive_letter,
          file_size_bytes = excluded.file_size_bytes,
          file_mtime = excluded.file_mtime,
          last_seen_at = now(),
          note = excluded.note,
          updated_at = now()
    `,
    [
      row.unique_key,
      row.base_no,
      row.branch_no,
      row.target_path,
      row.file_name,
      row.file_ext,
      row.drive_letter,
      targetStat.size,
      targetStat.mtime ? targetStat.mtime.toISOString() : null,
      row.operation === "register_owned_only"
        ? "Recovered owned registration from heydouga_4017 target folder."
        : "Imported from heydouga_4017_new_mp4 batch.",
    ]
  );
}

function normalizePath(value) {
  return path.resolve(String(value || "")).toLowerCase();
}

function writePlanCsv(dirs, plan, label) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const outputPath = path.join(dirs.inputDir, `${SOURCE_NAME}_new_mp4_${label}_${stamp}.csv`);
  const columns = [
    "status",
    "operation",
    "master_action",
    "unique_key",
    "base_no",
    "branch_no",
    "title",
    "source_path",
    "target_path",
    "file_name",
    "file_ext",
    "drive_letter",
    "file_size_bytes",
    "file_mtime",
    "error",
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
  let existingMasters = 0;
  let newMasters = 0;
  for (const row of plan) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    if (row.master_action === "existing_master") existingMasters += 1;
    if (row.master_action === "insert_master") newMasters += 1;
  }
  return {
    total_video_files: plan.length,
    by_status: byStatus,
    existing_master: existingMasters,
    new_master: newMasters,
    unsafe_preview: plan
      .filter((row) => !isReady(row))
      .slice(0, 20)
      .map((row) => ({ status: row.status, file_name: row.file_name, source_path: row.source_path })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);
  const dirs = resolveDirs(args.inputDir);
  fs.mkdirSync(dirs.inputDir, { recursive: true });

  const client = createPgClient();
  await client.connect();
  try {
    const masterMap = await fetchMasterMap(client);
    const ownedPathSet = await fetchOwnedPathSet(client);
    const plan = buildPlan(dirs, masterMap, ownedPathSet);

    if (args.step === "review") {
      const planPath = writePlanCsv(dirs, plan, "review");
      process.stdout.write(
        `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), input_dir: dirs.inputDir, target_dir: dirs.targetDir, plan_path: planPath, summary: summarizePlan(plan) }, null, 2)}\n`
      );
      return;
    }

    if (args.step === "apply") {
      const result = await applyPlan(client, dirs, plan);
      if (result.upsertedOwned > 0) {
        result.video_metadata = runVideoMetadataCollect(args.envFile);
      }
      const planPath = writePlanCsv(dirs, plan, "applied");
      process.stdout.write(
        `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), input_dir: dirs.inputDir, target_dir: dirs.targetDir, plan_path: planPath, result, summary: summarizePlan(plan) }, null, 2)}\n`
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
