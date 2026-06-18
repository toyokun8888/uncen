const fs = require("fs");
const path = require("path");

const DEFAULT_TARGET_DIR = "J:\\uncen\\paco";
const DEFAULT_SOURCE = "paco";
const DEFAULT_DRIVES = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P", "Q"];

function parseArgs(argv) {
  const args = {
    source: DEFAULT_SOURCE,
    targetDir: DEFAULT_TARGET_DIR,
    envFile: "",
    recursive: false,
    allPacoDrives: false,
    scanUnmatchedDirs: false,
    unmatchedOnly: false,
    moveUnmatched: false,
    restoreMatched: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--recursive") {
      args.recursive = true;
    } else if (arg === "--all-paco-drives") {
      args.allPacoDrives = true;
    } else if (arg === "--scan-unmatched-dirs") {
      args.scanUnmatchedDirs = true;
    } else if (arg === "--unmatched-only") {
      args.unmatchedOnly = true;
    } else if (arg === "--move-unmatched") {
      args.moveUnmatched = true;
    } else if (arg === "--restore-matched") {
      args.restoreMatched = true;
    } else if (arg === "--source") {
      args.source = argv[++i];
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg === "--target-dir") {
      args.targetDir = argv[++i];
    } else if (arg.startsWith("--target-dir=")) {
      args.targetDir = arg.slice("--target-dir=".length);
    } else if (arg === "--env-file") {
      args.envFile = argv[++i];
    } else if (arg.startsWith("--env-file=")) {
      args.envFile = arg.slice("--env-file=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.allPacoDrives && !args.targetDir) {
    throw new Error("target-dir must not be empty");
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

function buildRunId(sourceName) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${sourceName}_owned_relation_check_${stamp}_${process.pid}`;
}

function listFiles(targetDir, recursive, options = {}) {
  const files = [];
  const stack = [path.resolve(targetDir)];
  const skipUnmatchedDirs = options.skipUnmatchedDirs !== false;

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (skipUnmatchedDirs && entry.name.toLowerCase() === "unmatched") {
          continue;
        }
        if (recursive) {
          stack.push(entryPath);
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b, "ja"));
}

function listTargetDirs(args) {
  if (!args.allPacoDrives) {
    return [path.resolve(args.targetDir)];
  }

  return DEFAULT_DRIVES.map((drive) => `${drive}:\\uncen\\paco`).filter((targetDir) =>
    fs.existsSync(targetDir)
  );
}

function listUnmatchedDirs(targetDirs) {
  return targetDirs
    .map((targetDir) => path.join(targetDir, "unmatched"))
    .filter((targetDir) => fs.existsSync(targetDir));
}

async function fetchMasterRows(sourceName) {
  if (sourceName !== "paco") {
    throw new Error(`Unsupported source: ${sourceName}`);
  }

  const client = createPgClient();
  await client.connect();

  try {
    const result = await client.query(
      `
        select
          relation_key_mmddyy,
          release_date::text as release_date,
          movie_code,
          title,
          actor_name,
          detail_url,
          thumbnail_url
        from cl.paco_m001_master_staging
        order by relation_key_mmddyy, movie_code
      `
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

function buildRelationIndex(masterRows) {
  const relationIndex = new Map();
  const movieCodeIndex = new Map();

  for (const row of masterRows) {
    movieCodeIndex.set(row.movie_code, row);
    if (!relationIndex.has(row.relation_key_mmddyy)) {
      relationIndex.set(row.relation_key_mmddyy, []);
    }
    relationIndex.get(row.relation_key_mmddyy).push(row);
  }

  return { relationIndex, movieCodeIndex };
}

function findKeysInFileName(fileName, keys) {
  const normalizedFileName = normalizeFileNameForMatching(fileName);
  return keys.filter((key) => normalizedFileName.includes(key));
}

function normalizeFileNameForMatching(fileName) {
  return String(fileName || "").replace(/([0-9]{6})-([0-9a-zA-Z]+)/g, "$1_$2");
}

function buildCsvRows(files, indexes) {
  const { relationIndex, movieCodeIndex } = indexes;
  const movieCodes = Array.from(movieCodeIndex.keys()).sort((a, b) => b.length - a.length);
  const relationKeys = Array.from(relationIndex.keys()).sort((a, b) => b.length - a.length);
  const rows = [];

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const matchedMovieCodes = findKeysInFileName(fileName, movieCodes);

    if (matchedMovieCodes.length > 0) {
      for (const movieCode of matchedMovieCodes) {
        const master = movieCodeIndex.get(movieCode);
        rows.push({
          match_status: matchedMovieCodes.length === 1 ? "matched_movie_code" : "matched_multiple_movie_codes",
          match_method: "movie_code",
          file_name: fileName,
          file_path: filePath,
          matched_movie_code: movieCode,
          matched_relation_key: master.relation_key_mmddyy,
          relation_key_count_in_file: 0,
          master_candidates_for_key: 1,
          movie_code: master.movie_code,
          release_date: master.release_date,
          title: master.title,
          actor_name: master.actor_name || "",
          detail_url: master.detail_url || "",
          thumbnail_url: master.thumbnail_url || "",
        });
      }
      continue;
    }

    const matchedKeys = findKeysInFileName(fileName, relationKeys);

    if (matchedKeys.length === 0) {
      rows.push({
        match_status: "unmatched",
        match_method: "",
        file_name: fileName,
        file_path: filePath,
        matched_movie_code: "",
        matched_relation_key: "",
        relation_key_count_in_file: 0,
        master_candidates_for_key: 0,
        movie_code: "",
        release_date: "",
        title: "",
        actor_name: "",
        detail_url: "",
        thumbnail_url: "",
      });
      continue;
    }

    for (const key of matchedKeys) {
      const masters = relationIndex.get(key) || [];
      for (const master of masters) {
        rows.push({
          match_status: masters.length === 1 ? "matched_relation_key" : "matched_multiple_master_candidates",
          match_method: "relation_key_mmddyy",
          file_name: fileName,
          file_path: filePath,
          matched_movie_code: "",
          matched_relation_key: key,
          relation_key_count_in_file: matchedKeys.length,
          master_candidates_for_key: masters.length,
          movie_code: master.movie_code,
          release_date: master.release_date,
          title: master.title,
          actor_name: master.actor_name || "",
          detail_url: master.detail_url || "",
          thumbnail_url: master.thumbnail_url || "",
        });
      }
    }
  }

  return rows;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (text.includes('"') || text.includes(",") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(runId, rows) {
  const outputDir = path.resolve(__dirname, "..", "..", "storage", "exports", "owned-relation-check");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${runId}.csv`);
  const headers = [
    "match_status",
    "match_method",
    "file_name",
    "file_path",
    "matched_movie_code",
    "matched_relation_key",
    "relation_key_count_in_file",
    "master_candidates_for_key",
    "movie_code",
    "release_date",
    "title",
    "actor_name",
    "detail_url",
    "thumbnail_url",
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ];

  fs.writeFileSync(outputPath, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
  return outputPath;
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

function moveUnmatchedFiles(unmatchedRows) {
  const reservedTargets = new Set();
  const results = [];

  for (const row of unmatchedRows) {
    const sourcePath = row.file_path;
    const sourceDir = path.dirname(sourcePath);
    const targetDir = path.join(sourceDir, "unmatched");
    fs.mkdirSync(targetDir, { recursive: true });

    const targetPath = resolveCollisionPath(path.join(targetDir, path.basename(sourcePath)), reservedTargets);
    fs.renameSync(sourcePath, targetPath);
    results.push({
      source_path: sourcePath,
      target_path: targetPath,
    });
  }

  return results;
}

function restoreMatchedFiles(matchedRows) {
  const reservedTargets = new Set();
  const restoredBySource = new Map();

  for (const row of matchedRows) {
    const sourcePath = row.file_path;
    if (restoredBySource.has(sourcePath)) {
      continue;
    }

    const sourceDir = path.dirname(sourcePath);
    if (path.basename(sourceDir).toLowerCase() !== "unmatched") {
      continue;
    }

    const targetDir = path.dirname(sourceDir);
    const targetPath = resolveCollisionPath(path.join(targetDir, path.basename(sourcePath)), reservedTargets);
    fs.renameSync(sourcePath, targetPath);
    restoredBySource.set(sourcePath, {
      source_path: sourcePath,
      target_path: targetPath,
    });
  }

  return Array.from(restoredBySource.values());
}

function summarize(files, csvRows) {
  const matchedFileNames = new Set();
  const unmatchedFileNames = new Set();
  const multipleCandidateFileNames = new Set();

  for (const row of csvRows) {
    if (row.match_status === "unmatched") {
      unmatchedFileNames.add(row.file_path);
    } else {
      matchedFileNames.add(row.file_path);
    }
    if (row.match_status === "matched_multiple_master_candidates") {
      multipleCandidateFileNames.add(row.file_path);
    }
  }

  return {
    file_count: files.length,
    relation_rows: csvRows.length,
    matched_files: matchedFileNames.size,
    unmatched_files: unmatchedFileNames.size,
    files_with_multiple_master_candidates: multipleCandidateFileNames.size,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);
  const runId = buildRunId(args.source);

  if (!args.allPacoDrives && !fs.existsSync(args.targetDir)) {
    throw new Error(`target-dir does not exist: ${args.targetDir}`);
  }

  const baseTargetDirs = listTargetDirs(args);
  const targetDirs = args.scanUnmatchedDirs ? listUnmatchedDirs(baseTargetDirs) : baseTargetDirs;
  const files = targetDirs.flatMap((targetDir) =>
    listFiles(targetDir, args.recursive, { skipUnmatchedDirs: !args.scanUnmatchedDirs })
  );
  const masterRows = await fetchMasterRows(args.source);
  const indexes = buildRelationIndex(masterRows);
  const allCsvRows = buildCsvRows(files, indexes);
  const unmatchedRows = allCsvRows.filter((row) => row.match_status === "unmatched");
  const matchedRows = allCsvRows.filter((row) => row.match_status !== "unmatched");
  const csvRows = args.unmatchedOnly ? unmatchedRows : allCsvRows;
  const restoredMatched = args.restoreMatched ? restoreMatchedFiles(matchedRows) : [];
  const movedUnmatched = args.moveUnmatched ? moveUnmatchedFiles(unmatchedRows) : [];
  const csvPath = writeCsv(runId, csvRows);
  const summary = summarize(files, allCsvRows);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        source: args.source,
        target_dir: args.allPacoDrives ? "" : path.resolve(args.targetDir),
        target_dirs: targetDirs,
        recursive: args.recursive,
        scan_unmatched_dirs: args.scanUnmatchedDirs,
        unmatched_only: args.unmatchedOnly,
        move_unmatched: args.moveUnmatched,
        restore_matched: args.restoreMatched,
        env_file_loaded: Boolean(loadedEnv),
        master_rows: masterRows.length,
        movie_codes: indexes.movieCodeIndex.size,
        relation_keys: indexes.relationIndex.size,
        csv_path: csvPath,
        written_csv_rows: csvRows.length,
        restored_matched_files: restoredMatched.length,
        moved_unmatched_files: movedUnmatched.length,
        ...summary,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
