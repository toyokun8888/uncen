"use strict";

const fs = require("fs");
const path = require("path");

const SOURCE_NAME = "heydouga_4017";
const DEFAULT_DRIVES = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P"];
const VIDEO_EXTENSIONS = new Set([
  ".avi",
  ".m2ts",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpg",
  ".mpeg",
  ".ts",
  ".wmv",
]);

function parseArgs(argv) {
  const args = {
    step: "dry-run",
    envFile: "",
    drives: DEFAULT_DRIVES,
    limit: 0,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg.startsWith("--step=")) {
      args.step = arg.slice("--step=".length);
    } else if (arg === "--step") {
      args.step = argv[++i];
    } else if (arg.startsWith("--env-file=")) {
      args.envFile = arg.slice("--env-file=".length);
    } else if (arg === "--env-file") {
      args.envFile = argv[++i];
    } else if (arg.startsWith("--drives=")) {
      args.drives = parseDrives(arg.slice("--drives=".length));
    } else if (arg === "--drives") {
      args.drives = parseDrives(argv[++i]);
    } else if (arg.startsWith("--limit=")) {
      args.limit = parseNonNegativeInt(arg.slice("--limit=".length), "limit");
    } else if (arg === "--limit") {
      args.limit = parseNonNegativeInt(argv[++i], "limit");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseDrives(value) {
  return String(value || "")
    .split(",")
    .map((drive) => drive.trim().replace(/:$/, "").toUpperCase())
    .filter(Boolean);
}

function parseNonNegativeInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
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

async function fetchMasterKeys() {
  const client = createPgClient();

  await client.connect();
  try {
    const result = await client.query(
      `
        select unique_key, base_no, branch_no, title
        from cl.heydouga_4017_m002_master
      `
    );
    return new Map(result.rows.map((row) => [row.unique_key, row]));
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

function ensureCollectDirs(drives) {
  const dirs = [];

  for (const drive of drives) {
    const driveRoot = `${drive}:\\`;
    if (!fs.existsSync(driveRoot)) {
      continue;
    }
    const targetDir = path.join(driveRoot, "uncen", SOURCE_NAME);
    fs.mkdirSync(targetDir, { recursive: true });
    dirs.push(targetDir);
  }

  return dirs;
}

function scanDrive(drive, masterKeys, limit) {
  const root = `${drive}:\\`;
  const targetDir = path.join(root, "uncen", SOURCE_NAME);
  const rows = [];
  const errors = [];

  if (!fs.existsSync(root)) {
    return { drive, root, targetDir, rows, errors: [{ path: root, error: "root_not_found" }] };
  }

  walkFiles(root, targetDir, limit, rows, errors, (filePath) => {
    const row = buildCandidateRow(drive, root, targetDir, filePath, masterKeys);
    if (row) {
      rows.push(row);
    }
  });

  return { drive, root, targetDir, rows, errors };
}

function walkFiles(root, targetDir, limit, rows, errors, onFile) {
  const stack = [root];
  const normalizedTarget = normalizePath(targetDir);
  const skipDirectoryNames = new Set(["$recycle.bin", "system volume information"]);

  while (stack.length > 0) {
    if (limit > 0 && rows.length >= limit) {
      break;
    }

    const current = stack.pop();
    if (normalizePath(current) === normalizedTarget) {
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: current, error: error.code || error.message });
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push({ path: fullPath, error: "symbolic_link_skipped" });
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirectoryNames.has(entry.name.toLowerCase())) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      onFile(fullPath);
      if (limit > 0 && rows.length >= limit) {
        break;
      }
    }
  }
}

function buildCandidateRow(drive, root, targetDir, filePath, masterKeys) {
  const parsed = path.parse(filePath);
  const ext = parsed.ext.toLowerCase();

  if (!VIDEO_EXTENSIONS.has(ext)) {
    return null;
  }

  const haystack = `${parsed.name} ${path.dirname(filePath)}`;
  if (!isPotentialHeydouga4017Candidate(haystack)) {
    return null;
  }

  let extraction = extractHeydouga4017Key(parsed.name);
  if (!extraction.baseNo) {
    extraction = extractHeydouga4017Key(haystack);
  }
  const master = extraction.uniqueKey ? masterKeys.get(extraction.uniqueKey) : null;
  if (extraction.anchorType === "heydouga_ppv_without_4017" && !master) {
    return null;
  }

  const destinationPath = path.join(targetDir, path.basename(filePath));
  const destinationExists = normalizePath(destinationPath) !== normalizePath(filePath) && fs.existsSync(destinationPath);
  const status = classifyCandidate(extraction, master, destinationExists);
  const stat = safeStat(filePath);

  return {
    drive_letter: drive,
    match_status: status.matchStatus,
    match_note: status.matchNote,
    action: status.action,
    source_path: filePath,
    proposed_target_path: destinationPath,
    destination_exists: destinationExists ? "yes" : "no",
    file_name: path.basename(filePath),
    file_ext: ext.slice(1),
    file_size_bytes: stat ? stat.size : "",
    file_mtime: stat ? stat.mtime.toISOString() : "",
    candidate_unique_key: extraction.uniqueKey || "",
    candidate_base_no: extraction.baseNo || "",
    candidate_branch_no: extraction.branchNo || "",
    owned_manual_key: extraction.ownedManualKey || "",
    master_unique_key: master ? master.unique_key : "",
    master_title: master ? master.title : "",
  };
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isPotentialHeydouga4017Candidate(value) {
  const normalized = normalizeForMatch(value);

  if (/(?:heydouga|hey)[\s_.-]*(?:4037|4044)/i.test(normalized)) {
    return false;
  }

  if (
    /(?:shirohame|しろハメ|しろはめ|シロハメ)/i.test(normalized) &&
    !/(?:heydouga|hey)[\s_.-]*4017/i.test(normalized) &&
    !/\b4017\b/i.test(normalized)
  ) {
    return false;
  }

  if (/(?:heydouga|hey)[\s_.-]*4017/i.test(normalized)) return true;
  if (/\b4017[\s_.-]*(?:ppv)?[\s_.-]*[0-9]{1,5}/i.test(normalized)) return true;
  if (/(?:heydouga|hey)[\s_.-]*ppv[\s_.-]*[0-9]{1,5}/i.test(normalized)) return true;

  return false;

  return (
    /(?:heydouga|hey)[\s_.-]*4017/i.test(normalized) ||
    /\b4017[\s_.-]*(?:ppv)?[\s_.-]*[0-9]{1,5}/i.test(normalized) ||
    /(?:heydouga|hey)[\s_.-]*ppv[\s_.-]*[0-9]{1,5}/i.test(normalized) ||
    /(?:shirohame|しろハメ|しろはめ|シロハメ)/i.test(normalized)
  );
}

function extractHeydouga4017Key(value) {
  const normalized = normalizeForMatch(value);
  const lower = normalized.toLowerCase();
  const siteMatch = lower.match(/(?:heydouga|hey)[\s_.-]*4017/);
  const heydougaPpvMatch = lower.match(/(?:heydouga|hey)[\s_.-]*ppv/);
  const bare4017Match = lower.match(/\b4017\b/);

  if (!siteMatch && !heydougaPpvMatch && !bare4017Match) {
    return { status: "needs_review", note: "site_anchor_not_found" };
  }

  const anchorMatch = siteMatch || bare4017Match || heydougaPpvMatch;
  const anchorType =
    siteMatch || bare4017Match ? "explicit_4017" : "heydouga_ppv_without_4017";
  const afterAnchor = normalized.slice(anchorMatch.index + anchorMatch[0].length);
  const windowText = afterAnchor.slice(0, 100);
  const baseMatch = windowText.match(/^[\s_.-]*(?:ppv[\s_.-]*)?([0-9]{1,5})/i);

  if (!baseMatch) {
    return { status: "needs_review", note: "base_no_not_found_after_anchor", anchorType };
  }

  const baseNo = baseMatch[1];
  const afterBase = windowText.slice(baseMatch[0].length);
  const branchNo = extractBranchNoAfterBase(afterBase);

  if (!branchNo) {
    return {
      baseNo,
      status: "needs_review",
      note: "group_title_candidate",
      anchorType,
    };
  }

  if (/^[a-zA-Z]$/.test(branchNo)) {
    const ownedManualKey = `${baseNo}-${branchNo.toLowerCase()}`;
    return {
      baseNo,
      branchNo: branchNo.toLowerCase(),
      uniqueKey: ownedManualKey,
      ownedManualKey,
      status: "needs_review",
      note: "owned_manual_key_requires_human_confirmation",
      anchorType,
    };
  }

  return {
    baseNo,
    branchNo,
    uniqueKey: `${baseNo}-${branchNo}`,
    status: "matched",
    note: "",
    anchorType,
  };
}

function extractBranchNoAfterBase(value) {
  const text = String(value || "");
  const partMatch = text.match(/^[\s_.-]*(?:part)[\s_.-]*([0-9]{1,5})/i);
  if (partMatch) return partMatch[1];

  const ppvBranchMatch = text.match(/^[\s_.-]*(?:ppv)[\s_.-]*([0-9]{1,5})/i);
  if (ppvBranchMatch) return ppvBranchMatch[1];

  const qualityMatch = text.match(/^[\s_.-]*(?:fhd|hd)[\s_.-]*([0-9]{1,5})/i);
  if (qualityMatch) return qualityMatch[1];

  const directNumberMatch = text.match(/^[\s_.-]+([0-9]{1,5})(?=\s|$|fhd|hd|[^0-9A-Za-z])/i);
  if (directNumberMatch) return directNumberMatch[1];

  const directLetterMatch = text.match(/^[\s_.-]+([a-zA-Z])(?![a-zA-Z])/);
  if (directLetterMatch) return directLetterMatch[1];

  const trailingQualityMatch = text.match(/(?:^|[\s_.-])(?:fhd|hd)[\s_.-]*([0-9]{1,5})(?=$|[\s_.-]|[^0-9A-Za-z])/i);
  if (trailingQualityMatch) return trailingQualityMatch[1];

  const trailingPartMatch = text.match(/(?:^|[\s_.-])part[\s_.-]*([0-9]{1,5})(?=$|[\s_.-]|[^0-9A-Za-z])/i);
  if (trailingPartMatch) return trailingPartMatch[1];

  return "";
}

function classifyCandidate(extraction, master, destinationExists) {
  if (destinationExists) {
    return {
      matchStatus: "duplicate_candidate",
      matchNote: "destination_file_exists",
      action: "review_only",
    };
  }
  if (extraction.ownedManualKey) {
    return {
      matchStatus: "manual_key_required",
      matchNote: extraction.note,
      action: "review_only",
    };
  }
  if (extraction.uniqueKey && master) {
    return {
      matchStatus: "matched_master",
      matchNote: "",
      action: "move_candidate",
    };
  }
  if (extraction.uniqueKey && !master) {
    return {
      matchStatus: "missing_master",
      matchNote: "candidate_key_not_found_in_master",
      action: "review_only",
    };
  }
  if (extraction.baseNo) {
    return {
      matchStatus: "manual_key_required",
      matchNote: extraction.note || "base_no_without_branch",
      action: "review_only",
    };
  }
  return {
    matchStatus: "needs_review",
    matchNote: extraction.note || "key_not_found",
    action: "review_only",
  };
}

function normalizeForMatch(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizePath(value) {
  return path.resolve(String(value || "")).toLowerCase();
}

function writeDriveCsv(targetDir, drive, rows) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const outputPath = path.join(targetDir, `${SOURCE_NAME}_owned_file_dry_run_${stamp}_${drive}.csv`);
  const columns = [
    "drive_letter",
    "match_status",
    "match_note",
    "action",
    "candidate_unique_key",
    "candidate_base_no",
    "candidate_branch_no",
    "owned_manual_key",
    "master_unique_key",
    "master_title",
    "source_path",
    "proposed_target_path",
    "destination_exists",
    "file_name",
    "file_ext",
    "file_size_bytes",
    "file_mtime",
  ];

  writeCsvRows(outputPath, columns, rows);
  return outputPath;
}

function writeCsvRows(outputPath, columns, rows) {
  const lines = [columns.join(",")];

  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsv(row[column])).join(","));
  }

  fs.writeFileSync(outputPath, `${lines.join("\r\n")}\r\n`, "utf8");
}

function escapeCsv(value) {
  const raw = escapeSpreadsheetFormula(String(value ?? ""));
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function escapeSpreadsheetFormula(value) {
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function summarizeRows(rows) {
  const byStatus = {};
  const byAction = {};

  for (const row of rows) {
    byStatus[row.match_status] = (byStatus[row.match_status] || 0) + 1;
    byAction[row.action] = (byAction[row.action] || 0) + 1;
  }

  return {
    total_candidates: rows.length,
    by_status: byStatus,
    by_action: byAction,
  };
}

async function runDryRun(args) {
  const masterKeys = await fetchMasterKeys();
  const collectDirs = ensureCollectDirs(args.drives);
  const results = [];

  for (const drive of args.drives) {
    const driveResult = scanDrive(drive, masterKeys, args.limit);
    if (fs.existsSync(driveResult.targetDir)) {
      driveResult.outputPath = writeDriveCsv(driveResult.targetDir, drive, driveResult.rows);
    }
    driveResult.summary = summarizeRows(driveResult.rows);
    results.push(driveResult);
  }

  return {
    master_key_count: masterKeys.size,
    collect_dirs: collectDirs,
    drives: results.map((result) => ({
      drive: result.drive,
      root: result.root,
      target_dir: result.targetDir,
      output_path: result.outputPath || "",
      summary: result.summary,
      error_count: result.errors.length,
      errors: result.errors.slice(0, 20),
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);

  if (args.step === "ensure-dirs") {
    const collectDirs = ensureCollectDirs(args.drives);
    process.stdout.write(
      `${JSON.stringify({ ok: true, source_name: SOURCE_NAME, step: args.step, collect_dirs: collectDirs }, null, 2)}\n`
    );
    return;
  }

  if (args.step === "dry-run") {
    const result = await runDryRun(args);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          source_name: SOURCE_NAME,
          step: args.step,
          dry_run: true,
          env_file_loaded: Boolean(loadedEnv),
          result,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  throw new Error(`Unsupported step: ${args.step}`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
