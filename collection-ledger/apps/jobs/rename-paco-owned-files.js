const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    csvPath: "",
    execute: false,
    rollback: false,
    manifestPath: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--execute") {
      args.execute = true;
    } else if (arg === "--dry-run") {
      args.execute = false;
    } else if (arg === "--rollback") {
      args.rollback = true;
    } else if (arg === "--csv") {
      args.csvPath = path.resolve(argv[++i]);
    } else if (arg.startsWith("--csv=")) {
      args.csvPath = path.resolve(arg.slice("--csv=".length));
    } else if (arg === "--manifest") {
      args.manifestPath = path.resolve(argv[++i]);
    } else if (arg.startsWith("--manifest=")) {
      args.manifestPath = path.resolve(arg.slice("--manifest=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.rollback && !args.manifestPath) {
    throw new Error("manifest is required for rollback");
  }
  if (!args.rollback && !args.csvPath) {
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

function buildTargetFileName(movieCode, title, actorName, ext) {
  const maxFileNameLength = 240;
  let safeTitle = title;
  let safeActorName = actorName;
  let fileName = `${movieCode}_${safeTitle}_${safeActorName}${ext}`;

  if (fileName.length <= maxFileNameLength) {
    return fileName;
  }

  const fixedLength = movieCode.length + ext.length + 2;
  const availableLength = Math.max(20, maxFileNameLength - fixedLength);
  const titleLength = Math.min(safeTitle.length, Math.max(20, Math.floor(availableLength * 0.6)));
  const actorLength = Math.min(safeActorName.length, Math.max(10, availableLength - titleLength));

  safeTitle = safeTitle.slice(0, titleLength).replace(/[. ]+$/g, "");
  safeActorName = safeActorName.slice(0, actorLength).replace(/[. ]+$/g, "");
  fileName = `${movieCode}_${safeTitle}_${safeActorName}${ext}`;

  if (fileName.length > maxFileNameLength) {
    const overflow = fileName.length - maxFileNameLength;
    safeTitle = safeTitle.slice(0, Math.max(20, safeTitle.length - overflow)).replace(/[. ]+$/g, "");
    fileName = `${movieCode}_${safeTitle}_${safeActorName}${ext}`;
  }

  return fileName;
}

function normalizeForCompare(value) {
  return path.resolve(value).toLowerCase();
}

function resolveCollisionPath(targetPath, reservedTargets, sourcePath) {
  const normalizedSourcePath = normalizeForCompare(sourcePath);
  const normalizedTargetPath = normalizeForCompare(targetPath);
  if (
    normalizedTargetPath === normalizedSourcePath ||
    (!fs.existsSync(targetPath) && !reservedTargets.has(normalizedTargetPath))
  ) {
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
  const problems = [];

  for (const row of rows) {
    if (row.match_status === "unmatched") {
      problems.push({ type: "unmatched", file_path: row.file_path });
      continue;
    }

    const sourcePath = String(row.file_path || "").trim();
    const sourceDir = path.dirname(sourcePath);
    if (path.basename(sourceDir).toLowerCase() === "unmatched") {
      continue;
    }

    const normalizedSourcePath = normalizeForCompare(sourcePath);
    if (plannedBySource.has(normalizedSourcePath)) {
      problems.push({ type: "multiple_master_candidates", file_path: sourcePath });
      continue;
    }

    const movieCode = String(row.movie_code || "").trim();
    const title = sanitizeFilePart(row.title);
    const actorName = sanitizeFilePart(row.actor_name);

    if (!movieCode.match(/^[0-9]{6}_.+$/)) {
      problems.push({ type: "invalid_movie_code", movie_code: movieCode, file_path: sourcePath });
      continue;
    }
    if (!title) {
      problems.push({ type: "missing_title", movie_code: movieCode, file_path: sourcePath });
      continue;
    }
    if (!actorName) {
      problems.push({ type: "missing_actor_name", movie_code: movieCode, file_path: sourcePath });
      continue;
    }

    const ext = path.extname(sourcePath) || ".mp4";
    const targetFileName = buildTargetFileName(movieCode, title, actorName, ext);
    const targetPath = resolveCollisionPath(path.join(sourceDir, targetFileName), reservedTargets, sourcePath);
    const normalizedTargetPath = normalizeForCompare(targetPath);

    plannedBySource.set(normalizedSourcePath, {
      status: "pending",
      match_status: row.match_status,
      match_method: row.match_method,
      movie_code: movieCode,
      title,
      actor_name: actorName,
      original_path: sourcePath,
      target_path: targetPath,
      original_file_name: path.basename(sourcePath),
      target_file_name: path.basename(targetPath),
      source_exists: fs.existsSync(sourcePath),
      target_exists: normalizedTargetPath === normalizedSourcePath ? false : fs.existsSync(targetPath),
      no_op: normalizedTargetPath === normalizedSourcePath,
    });
  }

  const plan = Array.from(plannedBySource.values()).sort((a, b) =>
    a.original_path.localeCompare(b.original_path, "ja")
  );

  return { plan, problems };
}

function buildRunId() {
  return `paco_owned_full_rename_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}_${process.pid}`;
}

function writeManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function createManifest(runId, csvPath, plan, problems, mode) {
  const outputDir = path.resolve(__dirname, "..", "..", "storage", "logs", "paco-owned-rename");
  fs.mkdirSync(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, `${runId}.json`);
  const manifest = {
    run_id: runId,
    mode,
    csv_path: csvPath,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    safety_note: "original_path and target_path are retained so renamed files can be restored if needed.",
    summary: summarizePlan(plan, problems),
    problems,
    plan,
  };
  writeManifest(manifestPath, manifest);
  return { manifestPath, manifest };
}

function summarizePlan(plan, problems) {
  return {
    planned_files: plan.length,
    files_to_rename: plan.filter((item) => !item.no_op).length,
    no_op_files: plan.filter((item) => item.no_op).length,
    missing_sources: plan.filter((item) => !item.source_exists).length,
    existing_targets: plan.filter((item) => item.target_exists).length,
    problems: problems.length,
  };
}

function validatePlan(plan, problems) {
  if (problems.length > 0) {
    throw new Error(`Plan has problems: ${JSON.stringify(problems.slice(0, 20), null, 2)}`);
  }

  const missingSources = plan.filter((item) => !item.source_exists);
  const existingTargets = plan.filter((item) => item.target_exists);

  if (missingSources.length > 0) {
    throw new Error(`Missing source files: ${missingSources.map((item) => item.original_path).join(", ")}`);
  }
  if (existingTargets.length > 0) {
    throw new Error(`Target unexpectedly exists: ${existingTargets.map((item) => item.target_path).join(", ")}`);
  }
}

function executePlan(manifestPath, manifest) {
  for (const item of manifest.plan) {
    try {
      if (item.no_op) {
        item.status = "no_op";
      } else {
        fs.renameSync(item.original_path, item.target_path);
        item.status = "renamed";
      }
      item.updated_at = new Date().toISOString();
      manifest.updated_at = item.updated_at;
      manifest.summary = summarizeExecuted(manifest.plan, manifest.problems);
      writeManifest(manifestPath, manifest);
    } catch (error) {
      item.status = "failed";
      item.error = error.message;
      item.updated_at = new Date().toISOString();
      manifest.updated_at = item.updated_at;
      manifest.summary = summarizeExecuted(manifest.plan, manifest.problems);
      writeManifest(manifestPath, manifest);
      throw error;
    }
  }
}

function summarizeExecuted(plan, problems) {
  return {
    planned_files: plan.length,
    renamed_files: plan.filter((item) => item.status === "renamed").length,
    no_op_files: plan.filter((item) => item.status === "no_op").length,
    failed_files: plan.filter((item) => item.status === "failed").length,
    pending_files: plan.filter((item) => item.status === "pending").length,
    problems: problems.length,
  };
}

function rollback(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const reversed = [...manifest.plan].reverse();
  const restored = [];
  const skipped = [];

  for (const item of reversed) {
    if (item.status !== "renamed") {
      skipped.push({ reason: item.status, target_path: item.target_path });
      continue;
    }
    if (!fs.existsSync(item.target_path)) {
      skipped.push({ reason: "target_missing", target_path: item.target_path });
      continue;
    }
    if (fs.existsSync(item.original_path)) {
      skipped.push({ reason: "original_exists", original_path: item.original_path });
      continue;
    }

    fs.renameSync(item.target_path, item.original_path);
    item.status = "rolled_back";
    item.updated_at = new Date().toISOString();
    restored.push({ from: item.target_path, to: item.original_path });
  }

  manifest.mode = "rollback";
  manifest.updated_at = new Date().toISOString();
  manifest.rollback = { restored, skipped };
  manifest.summary = {
    ...summarizeExecuted(manifest.plan, manifest.problems || []),
    rolled_back_files: restored.length,
    rollback_skipped_files: skipped.length,
  };
  writeManifest(manifestPath, manifest);

  return {
    ok: true,
    rollback: true,
    manifest_path: manifestPath,
    restored_files: restored.length,
    skipped_files: skipped.length,
  };
}

function run(args) {
  if (args.rollback) {
    return rollback(args.manifestPath);
  }

  if (!fs.existsSync(args.csvPath)) {
    throw new Error(`CSV not found: ${args.csvPath}`);
  }

  const rows = parseCsv(fs.readFileSync(args.csvPath, "utf8"));
  const { plan, problems } = buildPlan(rows);
  const runId = buildRunId();
  const { manifestPath, manifest } = createManifest(
    runId,
    args.csvPath,
    plan,
    problems,
    args.execute ? "execute" : "dry-run"
  );

  validatePlan(plan, problems);

  if (args.execute) {
    executePlan(manifestPath, manifest);
  }

  const finalManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return {
    ok: true,
    dry_run: !args.execute,
    csv_path: args.csvPath,
    csv_rows: rows.length,
    manifest_path: manifestPath,
    summary: finalManifest.summary,
    preview: finalManifest.plan.slice(0, 20),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const result = run(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
