const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    csvPath: "",
    execute: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--execute") {
      args.execute = true;
    } else if (arg === "--dry-run") {
      args.execute = false;
    } else if (arg === "--csv") {
      args.csvPath = path.resolve(argv[++i]);
    } else if (arg.startsWith("--csv=")) {
      args.csvPath = path.resolve(arg.slice("--csv=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.csvPath) {
    throw new Error("csv is required");
  }

  return args;
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

function sanitizeFilePart(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
}

function normalizeForCompare(value) {
  return path.resolve(value).toLowerCase();
}

function resolveCollisionPath(targetPath, reservedTargets) {
  const normalizedTargetPath = normalizeForCompare(targetPath);
  if (!fs.existsSync(targetPath) && !reservedTargets.has(normalizedTargetPath)) {
    reservedTargets.add(normalizedTargetPath);
    return targetPath;
  }

  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);

  for (let index = 1; index < 100000; index += 1) {
    const candidate = path.join(dir, `${base}(${index})${ext}`);
    const normalizedCandidate = normalizeForCompare(candidate);
    if (!fs.existsSync(candidate) && !reservedTargets.has(normalizedCandidate)) {
      reservedTargets.add(normalizedCandidate);
      return candidate;
    }
  }

  throw new Error(`Could not resolve collision for: ${targetPath}`);
}

function buildPlan(rows) {
  const reservedTargets = new Set();
  const plannedBySource = new Map();

  for (const row of rows) {
    if (row.match_status === "unmatched") {
      continue;
    }

    const sourcePath = String(row.file_path || "").trim();
    const sourceDir = path.dirname(sourcePath);
    if (path.basename(sourceDir).toLowerCase() !== "unmatched") {
      continue;
    }
    if (plannedBySource.has(normalizeForCompare(sourcePath))) {
      throw new Error(`Multiple master candidates for source: ${sourcePath}`);
    }

    const movieCode = String(row.movie_code || "").trim();
    const title = sanitizeFilePart(row.title);
    const actorName = sanitizeFilePart(row.actor_name);

    if (!movieCode.match(/^[0-9]{6}_.+$/)) {
      throw new Error(`Invalid movie_code: ${movieCode}`);
    }
    if (!title) {
      throw new Error(`Missing title movie_code=${movieCode}`);
    }
    if (!actorName) {
      throw new Error(`Missing actor_name movie_code=${movieCode}`);
    }

    const targetDir = path.dirname(sourceDir);
    const ext = path.extname(sourcePath) || ".mp4";
    const targetFileName = `${movieCode}_${title}_${actorName}${ext}`;
    const targetPath = resolveCollisionPath(path.join(targetDir, targetFileName), reservedTargets);

    plannedBySource.set(normalizeForCompare(sourcePath), {
      match_status: row.match_status,
      match_method: row.match_method,
      movie_code: movieCode,
      source_path: sourcePath,
      target_path: targetPath,
      target_file_name: path.basename(targetPath),
      source_exists: fs.existsSync(sourcePath),
      target_exists: fs.existsSync(targetPath),
    });
  }

  return Array.from(plannedBySource.values()).sort((a, b) =>
    a.source_path.localeCompare(b.source_path, "ja")
  );
}

function writePlan(runId, plan) {
  const outputDir = path.resolve(__dirname, "..", "..", "storage", "logs", "paco-owned-rename");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${runId}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify({ run_id: runId, plan }, null, 2)}\n`, "utf8");
  return outputPath;
}

function run(args) {
  if (!fs.existsSync(args.csvPath)) {
    throw new Error(`CSV not found: ${args.csvPath}`);
  }

  const rows = parseCsv(fs.readFileSync(args.csvPath, "utf8"));
  const plan = buildPlan(rows);
  const missingSources = plan.filter((item) => !item.source_exists);
  const existingTargets = plan.filter((item) => item.target_exists);
  const runId = `paco_owned_matched_unmatched_rename_${new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14)}_${process.pid}`;

  if (missingSources.length > 0) {
    throw new Error(`Missing source files: ${missingSources.map((item) => item.source_path).join(", ")}`);
  }
  if (existingTargets.length > 0) {
    throw new Error(`Target unexpectedly exists: ${existingTargets.map((item) => item.target_path).join(", ")}`);
  }

  if (args.execute) {
    for (const item of plan) {
      fs.renameSync(item.source_path, item.target_path);
    }
  }

  const planPath = writePlan(runId, plan);
  return {
    ok: true,
    dry_run: !args.execute,
    csv_path: args.csvPath,
    csv_rows: rows.length,
    planned_files: plan.length,
    moved_files: args.execute ? plan.length : 0,
    plan_path: planPath,
    preview: plan,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const result = run(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
