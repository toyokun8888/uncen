const fs = require("fs");
const path = require("path");

const DEFAULT_DRIVES = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P", "Q"];
const DEFAULT_QUERY = "paco";
const BASE_TARGET_DIR_NAME = "uncen";

function parseArgs(argv) {
  const args = {
    execute: false,
    drives: DEFAULT_DRIVES,
    query: DEFAULT_QUERY,
    targetName: DEFAULT_QUERY,
    limit: 0,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--execute") {
      args.execute = true;
    } else if (arg === "--dry-run") {
      args.execute = false;
    } else if (arg === "--drives") {
      args.drives = parseDrives(argv[++i]);
    } else if (arg.startsWith("--drives=")) {
      args.drives = parseDrives(arg.slice("--drives=".length));
    } else if (arg === "--query") {
      args.query = parseQuery(argv[++i]);
    } else if (arg.startsWith("--query=")) {
      args.query = parseQuery(arg.slice("--query=".length));
    } else if (arg === "--target-name") {
      args.targetName = parseTargetName(argv[++i]);
    } else if (arg.startsWith("--target-name=")) {
      args.targetName = parseTargetName(arg.slice("--target-name=".length));
    } else if (arg === "--limit") {
      args.limit = parseLimit(argv[++i]);
    } else if (arg.startsWith("--limit=")) {
      args.limit = parseLimit(arg.slice("--limit=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseDrives(value) {
  const drives = String(value || "")
    .split(",")
    .map((drive) => drive.trim().replace(/[:\\\/]+$/g, "").toUpperCase())
    .filter(Boolean);

  if (drives.length === 0) {
    throw new Error("drives must include at least one drive letter");
  }

  for (const drive of drives) {
    if (!drive.match(/^[A-Z]$/)) {
      throw new Error(`Invalid drive letter: ${drive}`);
    }
  }

  return drives;
}

function parseQuery(value) {
  const query = String(value || "").trim();
  if (!query) {
    throw new Error("query must not be empty");
  }
  return query;
}

function parseTargetName(value) {
  const targetName = String(value || "").trim();
  if (!targetName) {
    throw new Error("target-name must not be empty");
  }
  if (targetName.includes("/") || targetName.includes("\\") || targetName.includes(":")) {
    throw new Error("target-name must be a single directory name, not a path");
  }
  if (!targetName.match(/^[a-zA-Z0-9._-]+$/)) {
    throw new Error("target-name must contain only letters, numbers, dot, underscore, or hyphen");
  }
  return targetName;
}

function parseLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("limit must be a non-negative integer");
  }
  return parsed;
}

function buildRunId() {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `collection_file_move_${stamp}_${process.pid}`;
}

function buildDrivePaths(driveLetter, targetName) {
  const root = `${driveLetter}:\\`;
  const targetDir = path.join(root, BASE_TARGET_DIR_NAME, targetName);
  return { root, targetDir };
}

function normalizeForCompare(value) {
  return path.resolve(value).toLowerCase();
}

function isInsideDirectory(candidate, directory) {
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedDirectory = normalizeForCompare(directory);
  return (
    normalizedCandidate === normalizedDirectory ||
    normalizedCandidate.startsWith(`${normalizedDirectory}${path.sep}`)
  );
}

function shouldSkipDirectory(directoryPath, targetDir) {
  const basename = path.basename(directoryPath).toLowerCase();
  return (
    isInsideDirectory(directoryPath, targetDir) ||
    basename === "system volume information" ||
    basename === "$recycle.bin"
  );
}

function ensureLogDir() {
  const logDir = path.resolve(__dirname, "..", "..", "storage", "logs", "collection-file-move");
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function createLogger(runId) {
  const logDir = ensureLogDir();
  const eventsPath = path.join(logDir, `${runId}.jsonl`);
  const summaryPath = path.join(logDir, `${runId}_summary.json`);

  return {
    eventsPath,
    summaryPath,
    write(event) {
      fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    },
    writeSummary(summary) {
      fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    },
  };
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

function findMatchingFiles(root, targetDir, query, limit) {
  const queryLower = query.toLowerCase();
  const stack = [root];
  const files = [];
  const errors = [];
  let directoriesScanned = 0;

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir || shouldSkipDirectory(currentDir, targetDir)) {
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
      directoriesScanned += 1;
    } catch (error) {
      errors.push({
        type: "read_dir_failed",
        path: currentDir,
        message: error.message,
      });
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entryPath, targetDir)) {
          stack.push(entryPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!entry.name.toLowerCase().includes(queryLower)) {
        continue;
      }

      if (isInsideDirectory(entryPath, targetDir)) {
        continue;
      }

      files.push(entryPath);
      if (limit > 0 && files.length >= limit) {
        return { files, errors, directoriesScanned, limited: true };
      }
    }
  }

  return { files, errors, directoriesScanned, limited: false };
}

function processDrive(driveLetter, args, logger, summary) {
  const { root, targetDir } = buildDrivePaths(driveLetter, args.targetName);
  const driveSummary = {
    drive: driveLetter,
    root,
    target_dir: targetDir,
    status: "pending",
    directories_scanned: 0,
    matched_files: 0,
    moved_files: 0,
    skipped_files: 0,
    scan_warnings: 0,
    errors: 0,
    limited: false,
  };
  summary.drives.push(driveSummary);

  if (!fs.existsSync(root)) {
    driveSummary.status = "missing_drive";
    logger.write({ type: "missing_drive", drive: driveLetter, root });
    return;
  }

  if (args.execute) {
    fs.mkdirSync(targetDir, { recursive: true });
    logger.write({ type: "ensure_target_dir", drive: driveLetter, target_dir: targetDir });
  } else {
    logger.write({ type: "dry_run_target_dir", drive: driveLetter, target_dir: targetDir });
  }

  const scanResult = findMatchingFiles(root, targetDir, args.query, args.limit);
  driveSummary.directories_scanned = scanResult.directoriesScanned;
  driveSummary.matched_files = scanResult.files.length;
  driveSummary.limited = scanResult.limited;
  const reservedTargets = new Set();

  for (const error of scanResult.errors) {
    driveSummary.scan_warnings += 1;
    logger.write({ type: "scan_error", drive: driveLetter, ...error });
  }

  for (const sourcePath of scanResult.files) {
    const targetPath = resolveCollisionPath(path.join(targetDir, path.basename(sourcePath)), reservedTargets);
    const event = {
      type: args.execute ? "move" : "dry_run_move",
      drive: driveLetter,
      source_path: sourcePath,
      target_path: targetPath,
    };

    if (!isInsideDirectory(targetPath, targetDir)) {
      driveSummary.errors += 1;
      logger.write({
        type: "blocked_target_outside_dir",
        drive: driveLetter,
        source_path: sourcePath,
        target_path: targetPath,
      });
      continue;
    }

    if (args.execute) {
      try {
        fs.renameSync(sourcePath, targetPath);
        driveSummary.moved_files += 1;
        logger.write(event);
      } catch (error) {
        driveSummary.errors += 1;
        logger.write({
          ...event,
          type: "move_failed",
          message: error.message,
        });
      }
    } else {
      driveSummary.skipped_files += 1;
      logger.write(event);
    }
  }

  driveSummary.status = driveSummary.errors > 0 ? "completed_with_errors" : "completed";
}

function run(args) {
  const runId = buildRunId();
  const logger = createLogger(runId);
  const summary = {
    ok: true,
    run_id: runId,
    mode: args.execute ? "execute" : "dry-run",
    query: args.query,
    target_name: args.targetName,
    drives_requested: args.drives,
    target_relative_path: path.join(BASE_TARGET_DIR_NAME, args.targetName),
    started_at: new Date().toISOString(),
    finished_at: "",
    drives: [],
    totals: {
      matched_files: 0,
      moved_files: 0,
      skipped_files: 0,
      scan_warnings: 0,
      errors: 0,
    },
    log_files: {
      events: logger.eventsPath,
      summary: logger.summaryPath,
    },
  };

  for (const drive of args.drives) {
    processDrive(drive, args, logger, summary);
  }

  for (const driveSummary of summary.drives) {
    summary.totals.matched_files += driveSummary.matched_files;
    summary.totals.moved_files += driveSummary.moved_files;
    summary.totals.skipped_files += driveSummary.skipped_files;
    summary.totals.scan_warnings += driveSummary.scan_warnings;
    summary.totals.errors += driveSummary.errors;
  }

  summary.ok = summary.totals.errors === 0;
  summary.finished_at = new Date().toISOString();
  logger.writeSummary(summary);
  return summary;
}

function main() {
  const args = parseArgs(process.argv);
  const summary = run(args);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
