"use strict";

// Gachinco ownership review/apply follows the Night24 manual workflow. This
// entry point is never scheduled by PM2; review is read-only and apply only
// processes rows already classified in the review CSV.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildCatalogIndex, normalizeTitle, matchOwnedFile } = require("../../packages/domain/src/gachinco-catalog");

const ROOT = path.resolve(__dirname, "..", "..");
const IMPORT_DIR = path.join(ROOT, "storage", "imports", "gachinco");
const EXPORT_DIR = path.join(ROOT, "storage", "exports", "gachinco");
const DEFAULT_CATALOG = path.join(IMPORT_DIR, "gachinco-catalog-latest.json");
const DRIVES = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P", "Q", "R", "T"];
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".avi", ".wmv", ".m4v", ".ts", ".m2ts", ".rmvb", ".asf", ".mpg", ".mpeg", ".webm", ".flv", ".vob", ".mts", ".3gp", ".ogv", ".divx", ".f4v", ".qt"]);
const SKIP_DIRS = new Set(["system volume information", "$recycle.bin", "recycler", "found.000", "recovery", "$winreagent", "windows", "windowsapps", "program files", "program files (x86)"]);
const SAMPLE_ROOTS = [
  "G:\\all\\お気に入りD(F)\\購入\\20180502 ガチん娘",
  "G:\\all\\お気に入りD(F)\\新規DL\\ガチん娘",
  "F:\\all\\保存E(H)\\お気に入り\\ガチん娘",
  "H:\\all\\保存",
];
const REQUIRED_REGISTRY_RELATIONS = [
  "cl.paco_owned_file", "cl.heydouga_4017_owned_file", "cl.tenmusume_owned_file",
  "cl.heyzo_owned_file", "cl.onepondo_owned_file", "cl.h0930_owned_file",
  "cl.carib_owned_file", "cl.tokyo_hot_owned_file", "cl.night24_tm002_owned_files",
  "cl.gachinco_tm002_owned_files",
];
const COLUMNS = [
  "run_id", "status", "classification", "match_method", "confidence", "movie_code", "title",
  "detail_url", "candidate_matches", "source_code", "source_record_id", "source_path", "target_path", "file_name",
  "file_size_bytes", "file_mtime", "drive_letter", "path_marker", "filename_marker", "provider_marker",
  "move_approved", "register_owned", "note",
];

function parseArgs(argv) {
  const args = { step: "", envFile: "", inputFile: "", catalogFile: DEFAULT_CATALOG, outputFile: "", apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--step") args.step = argv[++i] || "";
    else if (arg.startsWith("--step=")) args.step = arg.slice(7);
    else if (arg === "--env-file") args.envFile = argv[++i] || "";
    else if (arg.startsWith("--env-file=")) args.envFile = arg.slice(11);
    else if (arg === "--input-file") args.inputFile = argv[++i] || "";
    else if (arg.startsWith("--input-file=")) args.inputFile = arg.slice(13);
    else if (arg === "--catalog-file") args.catalogFile = argv[++i] || "";
    else if (arg.startsWith("--catalog-file=")) args.catalogFile = arg.slice(15);
    else if (arg === "--output-file") args.outputFile = argv[++i] || "";
    else if (arg.startsWith("--output-file=")) args.outputFile = arg.slice(14);
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else throw new Error("unknown_argument:" + arg);
  }
  if (!args.step) throw new Error("step_required");
  args.catalogFile = path.resolve(args.catalogFile || DEFAULT_CATALOG);
  if (args.inputFile) args.inputFile = path.resolve(args.inputFile);
  if (args.outputFile) args.outputFile = path.resolve(args.outputFile);
  return args;
}

function say(value) { process.stdout.write(String(value) + "\n"); }
function makeId() { return new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + crypto.randomBytes(4).toString("hex"); }
function inside(value, base) {
  const target = path.resolve(value).toLowerCase();
  const root = path.resolve(base).toLowerCase();
  return target === root || target.startsWith(root + path.sep.toLowerCase());
}
function normalizePath(value) {
  const raw = String(value || "").trim().replace(/\//g, "\\");
  return path.win32.normalize(raw.replace(/^\\+([A-Za-z]:)/, "$1").replace(/^([A-Za-z]):(?!\\)/, "$1:\\"));
}
function driveOf(value) { return normalizePath(value).match(/^([A-Za-z]):\\/)?.[1].toUpperCase() || ""; }
function allowedDrive(value) { return DRIVES.includes(driveOf(value)); }
function targetPath(source, unmatched = false) {
  const normalized = normalizePath(source);
  const drive = driveOf(normalized);
  if (!DRIVES.includes(drive)) throw new Error("drive_not_allowed:" + drive);
  return path.win32.join(drive + ":\\uncen\\gachinco", unmatched ? "unmatched" : "", path.win32.basename(normalized));
}
function isGachincoTarget(value) {
  const normalized = normalizePath(value).toLowerCase();
  const drive = driveOf(value);
  const targetRoot = drive + ":\\uncen\\gachinco";
  return DRIVES.includes(drive) && (normalized === targetRoot || normalized.startsWith(targetRoot + "\\"));
}
function isOtherUncenPath(value) {
  const normalized = normalizePath(value).toLowerCase();
  return /^[a-z]:\\uncen(?:\\|$)/.test(normalized) && !isGachincoTarget(value);
}
function hasFc2Marker(value) {
  const normalized = normalizePath(value);
  return /(?:^|[\\/._\s-])fc2(?:$|[\\/._\s-])|fc2[-_ ]?ppv/i.test(normalized);
}
function markerState(filePath) {
  const normalized = normalizePath(filePath);
  const fileName = path.win32.basename(normalized);
  const pathParts = normalized.split(/[\\/]+/).filter(Boolean);
  const pathMarker = pathParts.some((part) => /(?:^|[^a-z0-9])gachi(?:nco)?(?:$|[^a-z0-9])|(?:^|[^a-z0-9])gachi\d+(?=$|[^a-z0-9])|ガチん娘/i.test(part));
  // The Japanese interview-series wording is an explicit Gachinco marker per
  // the reviewed samples; generic `ガチ` alone is deliberately insufficient.
  const filenameMarker = /(?:^|[^a-z0-9])gachi(?:nco)?(?:$|[^a-z0-9])|(?:^|[^a-z0-9])gachi\d+(?=$|[^a-z0-9])|ガチん娘|(?:実録)?ガチ面接\s*\d+/i.test(fileName);
  // 4037 is a marker only as the exact provider token; a bare number is never enough.
  const providerMarker = /(?:^|[^a-z0-9])heydouga[-_. ]4037(?:$|[^0-9])/i.test(fileName);
  return { pathMarker, filenameMarker, providerMarker };
}
function catalogIndex(file) {
  if (!inside(file, IMPORT_DIR)) throw new Error("catalog_file_outside_gachinco_import_dir");
  const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(data.rows) || !Array.isArray(data.pageLogs)) throw new Error("catalog_file_invalid");
  return buildCatalogIndex(data.rows);
}
function csvQuote(value) { return '"' + String(value === null || value === undefined ? "" : value).replace(/"/g, '""') + '"'; }
function writeCsv(file, rows, columns) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [columns.map(csvQuote).join(",")].concat(rows.map((row) => columns.map((column) => csvQuote(row[column])).join(","))).join("\r\n") + "\r\n", "utf8");
}
function readCsv(text) {
  const records = [];
  let row = [], field = "", quoted = false;
  const value = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quoted && char === '"' && value[i + 1] === '"') { field += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if (char === "\n" && !quoted) { row.push(field.replace(/\r$/, "")); if (row.some((item) => item !== "")) records.push(row); row = []; field = ""; }
    else field += char;
  }
  if (row.length || field) { row.push(field.replace(/\r$/, "")); if (row.some((item) => item !== "")) records.push(row); }
  if (!records.length) return [];
  const headers = records.shift();
  return records.map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] || ""])));
}
function appendJsonLine(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  try { fs.writeSync(fd, JSON.stringify(record) + "\n", null, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function expectedFileAt(file, row) {
  try { const stat = fs.statSync(file); return stat.isFile() && stat.size === Number(row.file_size_bytes) && Math.abs(stat.mtimeMs - Date.parse(row.file_mtime)) <= 2000; } catch { return false; }
}
function loadEnv(file) {
  const candidates = [file, process.env.GACHINCO_ENV_FILE, process.env.NIGHT24_ENV_FILE, path.join(ROOT, ".env")].filter(Boolean);
  const selected = candidates.map((value) => path.resolve(value)).find((value) => fs.existsSync(value));
  if (!selected) throw new Error("database_env_file_not_found_pass_env_file");
  for (const raw of fs.readFileSync(selected, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const position = line.indexOf("=");
    const key = line.slice(0, position).trim().replace(/^\uFEFF/, "");
    let value = line.slice(position + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
function envValue(...keys) { return keys.map((key) => process.env[key]).find((value) => value !== undefined && value !== ""); }
function createPgClient() {
  const { Client } = require("pg");
  const connectionString = envValue("DATABASE_URL", "POSTGRES_URL");
  const config = connectionString ? { connectionString } : {
    host: envValue("PGHOST", "DB_HOST", "POSTGRES_HOST") || "localhost",
    port: Number(envValue("PGPORT", "DB_PORT", "POSTGRES_PORT") || 5432),
    database: envValue("PGDATABASE", "DB_NAME", "POSTGRES_DB", "POSTGRES_DATABASE", "DATABASE_NAME"),
    user: envValue("PGUSER", "DB_USER", "POSTGRES_USER"),
    password: envValue("PGPASSWORD", "DB_PASSWORD", "POSTGRES_PASSWORD", "DATABASE_PASSWORD"),
  };
  if (!connectionString && (!config.database || !config.user || !config.password)) throw new Error("database_settings_missing");
  return new Client(config);
}
async function withDb(args, action) {
  loadEnv(args.envFile);
  const db = createPgClient();
  await db.connect();
  try { return await action(db); } finally { await db.end(); }
}
function quoteIdentifier(value) { return '"' + String(value).replace(/"/g, '""') + '"'; }

async function discoverRegistryRelations(db) {
  const result = await db.query(`
    select n.nspname as schema_name, c.relname as relation_name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'file_path' and not a.attisdropped
    where c.relkind in ('r','p','v','m','f')
      and n.nspname not in ('pg_catalog','information_schema')
    order by n.nspname, c.relname
  `);
  const relations = result.rows.map((row) => ({ schema: row.schema_name, name: row.relation_name, key: row.schema_name + "." + row.relation_name }));
  const known = new Set(relations.map((row) => row.key.toLowerCase()));
  const missing = REQUIRED_REGISTRY_RELATIONS.filter((name) => !known.has(name.toLowerCase()));
  if (missing.length) throw new Error("owned_path_registry_incomplete:" + missing.join(","));
  if (!relations.length) throw new Error("owned_path_registry_empty");
  return relations;
}
function registryUnionSql(relations) {
  return relations.map((row) => `select file_path::text as file_path from ${quoteIdentifier(row.schema)}.${quoteIdentifier(row.name)} where file_path is not null`).join(" union all ");
}
async function fetchRegisteredPaths(db, relations) {
  const result = await db.query(registryUnionSql(relations));
  return new Set(result.rows.map((row) => normalizePath(row.file_path).toLowerCase()));
}
async function findRegisteredPath(db, relations, paths) {
  const normalized = [...new Set(paths.map((item) => normalizePath(item).toLowerCase()))];
  const sql = `select file_path::text as file_path from (${registryUnionSql(relations)}) registered where lower(replace(file_path, '/', E'\\\\')) = any($1::text[])`;
  const result = await db.query(sql, [normalized]);
  return result.rows.map((row) => normalizePath(row.file_path).toLowerCase());
}

function exactParentFolderMatch(source, index) {
  const parts = normalizePath(source).split(/\\+/).filter(Boolean);
  for (let offset = 1; offset < parts.length - 1; offset += 1) {
    const folder = parts[parts.length - 1 - offset];
    if (!folder) continue;
    const normalized = normalizeTitle(folder);
    if (!normalized) continue;
    const titleMatches = index.movieCodesByNormalizedTitle?.get(normalized) || new Set();
    const aliasMatches = index.bundleAliasIndex?.get(normalized) || [];
    const codes = [...new Set([...titleMatches, ...aliasMatches.map((row) => row.movieCode)])];
    if (codes.length > 1) {
      return {
        inScope: true,
        status: "ambiguous_catalog_title",
        matchMethod: "ambiguous_exact_parent_folder_title",
        confidence: 0.5,
        candidateMatches: codes.map((movieCode) => ({ movieCode, title: index.masterByCode.get(movieCode)?.title || "" })),
      };
    }
    if (codes.length !== 1) continue;
    const code = codes[0];
    const master = index.masterByCode.get(code);
    const alias = aliasMatches.find((row) => row.movieCode === code);
    const sourceRecord = alias?.sourceRecord || master?.sourceRows?.[0] || null;
    if (!master) continue;
    return {
      inScope: true,
      status: alias ? "bundle_constituent_title" : "catalog_title",
      matchMethod: alias ? "bundle_constituent_parent_folder_exact_title" : "parent_folder_exact_title",
      confidence: 0.9,
      movieCode: code,
      title: master.title,
      detailUrl: alias?.detailUrl || sourceRecord?.detailUrl || master.detailUrl || "",
      sourceCode: sourceRecord?.source || "a_up",
      sourceRecordId: alias?.sourceRecordId || sourceRecord?.sourceRecordId || "",
      candidateMatches: [],
      titleEvidence: "exact_parent_folder_title",
    };
  }
  return null;
}
function matchFile(source, index) {
  const match = matchOwnedFile(source, index);
  if (["catalog_title", "bundle_constituent_title", "exact_catalog_id"].includes(match.status)) return { ...match, titleEvidence: "video_filename" };
  // Use an ancestor only when its entire normalized name is one exact catalog
  // title/explicit bundle constituent. A brand/folder fragment never suffices.
  const parent = exactParentFolderMatch(source, index);
  if (parent && !["ambiguous_catalog_title", "ambiguous_bundle_alias"].includes(match.status)) return { ...match, ...parent, pathMarker: match.pathMarker, filenameMarker: match.filenameMarker, providerMarker: match.providerMarker };
  return match;
}

function rowFor(file, index, runId) {
  const source = normalizePath(file);
  const fileName = path.win32.basename(source);
  const match = matchFile(source, index);
  const markers = markerState(source);
  const isProvider = markers.providerMarker;
  const protectedUncen = isOtherUncenPath(source);
  const protectedFc2 = hasFc2Marker(source);
  const matched = ["exact_catalog_id", "catalog_title", "bundle_constituent_title"].includes(match.status);
  const classification = matched ? match.status : ((markers.filenameMarker || isProvider) && match.status === "not_gachinco" ? "marker_only" : match.status);
  const isCandidate = matched || markers.pathMarker || markers.filenameMarker || isProvider;
  if (!isCandidate) return null;
  const stat = fs.statSync(source);
  const drive = driveOf(source);
  const canRegister = matched;
  const explicitFileMarker = markers.filenameMarker || isProvider;
  const hasSiteEvidence = explicitFileMarker || markers.pathMarker;
  const filenameTitleEvidence = match.titleEvidence === "video_filename";
  const moveApproved = !protectedUncen && !protectedFc2 && (canRegister ? filenameTitleEvidence && hasSiteEvidence : explicitFileMarker);
  const destination = targetPath(source, !canRegister);
  let note = "";
  if (protectedFc2) note = "FC2 marker detected; protect this file from all Gachinco operations.";
  else if (protectedUncen) note = "Existing uncen collection path; protect it from this new site operation.";
  else if (matched && match.matchMethod?.startsWith("bundle_constituent")) note = "Video title is an explicit constituent of this a-up set; register this file to the set master.";
  else if (matched && !hasSiteEvidence) note = "Title match has no Gachinco filename or path marker; keep at source and record in CSV for review.";
  else if (matched && !filenameTitleEvidence) note = "Title is identified only from a parent folder; confirm that each video is part of that work before moving or registering.";
  else if (!matched && markers.pathMarker && !explicitFileMarker) note = "Folder marker only; keep at source and record in CSV for review.";
  else if (!matched) note = "Gachinco marker is explicit in the video filename; move to unmatched for later manual reconciliation.";
  return {
    run_id: runId,
    status: classification,
    classification,
    match_method: match.matchMethod || (isProvider ? "exact_heydouga_4037_marker" : "site_marker"),
    confidence: Number(match.confidence || 0),
    movie_code: canRegister ? match.movieCode : "",
    title: canRegister ? match.title : "",
    detail_url: canRegister ? match.detailUrl || "" : "",
    candidate_matches: JSON.stringify(match.candidateMatches || []),
    source_code: canRegister ? match.sourceCode || "" : "",
    source_record_id: canRegister ? match.sourceRecordId || "" : "",
    source_path: source,
    target_path: destination,
    file_name: fileName,
    file_size_bytes: stat.size,
    file_mtime: stat.mtime.toISOString(),
    drive_letter: drive,
    path_marker: markers.pathMarker ? "yes" : "no",
    filename_marker: markers.filenameMarker ? "yes" : "no",
    provider_marker: isProvider ? "yes" : "no",
    move_approved: moveApproved ? "yes" : "no",
    register_owned: canRegister && filenameTitleEvidence && hasSiteEvidence ? "yes" : "no",
    note,
  };
}

function walk(root, handle, errors, state) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) { errors.push({ path: current, error: String(error.code || error.message || error) }); continue; }
    state.directories += 1;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const next = path.win32.join(current, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name.toLowerCase())) stack.push(next); }
      else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.win32.extname(entry.name).toLowerCase())) {
        state.videoFiles += 1;
        for (const sample of SAMPLE_ROOTS) if (normalizePath(next).toLowerCase().startsWith(normalizePath(sample).toLowerCase() + "\\")) state.sampleCounts[sample] += 1;
        try { const row = handle(next); if (row) state.candidates.push(row); }
        catch (error) { errors.push({ path: next, error: String(error.code || error.message || error) }); }
      }
    }
    if (state.directories % 10000 === 0) say("Directories scanned: " + state.directories);
  }
}
async function review(args) {
  const index = catalogIndex(args.catalogFile);
  const runId = makeId();
  const output = path.resolve(args.outputFile || path.join(EXPORT_DIR, "gachinco-owned-review-" + runId + ".csv"));
  if (!inside(output, EXPORT_DIR)) throw new Error("review_output_outside_gachinco_export_dir");
  const state = { directories: 0, videoFiles: 0, candidates: [], sampleCounts: Object.fromEntries(SAMPLE_ROOTS.map((root) => [root, 0])) };
  const errors = [];
  for (const drive of DRIVES) {
    const root = drive + ":\\";
    if (!fs.existsSync(root)) { errors.push({ path: root, error: "drive_not_available" }); continue; }
    say("Scanning " + root);
    walk(root, (file) => rowFor(file, index, runId), errors, state);
  }
  writeCsv(output, state.candidates, COLUMNS);
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const counts = state.candidates.reduce((result, row) => { result[row.classification] = (result[row.classification] || 0) + 1; return result; }, {});
  fs.writeFileSync(path.join(EXPORT_DIR, "gachinco-owned-review-" + runId + "-scan.json"), JSON.stringify({
    runId, includedDrives: DRIVES, excludedDrives: ["S"], sampleRoots: SAMPLE_ROOTS, sampleRootVideoCounts: state.sampleCounts,
    directories: state.directories, videoFiles: state.videoFiles, candidates: state.candidates.length, counts, scanErrors: errors,
  }, null, 2) + "\n", "utf8");
  say("Scanned " + state.videoFiles + " video files; candidate rows=" + state.candidates.length + "; scan errors=" + errors.length);
  say("Sample root counts: " + JSON.stringify(state.sampleCounts));
  say("Counts: " + JSON.stringify(counts));
  say("Review CSV: " + output);
}

function stableFile(file, row) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size === Number(row.file_size_bytes) && Math.abs(stat.mtimeMs - Date.parse(row.file_mtime)) <= 2000 && Date.now() - stat.mtimeMs >= 10 * 60 * 1000;
  } catch { return false; }
}
function validMovieCode(value) { return /^gch-[0-9a-f]{24}$/.test(String(value || "")); }
function isProtectedByPath(source) { return isOtherUncenPath(source) || hasFc2Marker(source); }

async function apply(args) {
  const input = path.resolve(args.inputFile);
  if (!inside(input, EXPORT_DIR) || path.extname(input).toLowerCase() !== ".csv") throw new Error("input_must_be_gachinco_review_csv");
  const rows = readCsv(fs.readFileSync(input, "utf8"));
  if (!rows.length) throw new Error("review_csv_empty");
  const output = path.join(EXPORT_DIR, path.basename(input, ".csv") + ".apply-results.csv");
  const journalPath = output + ".move-journal.jsonl";
  const journal = readJsonLines(journalPath);
  const prior = fs.existsSync(output) ? readCsv(fs.readFileSync(output, "utf8")) : [];
  const recovered = new Set(prior.filter((row) => ["moved_pending_db", "registered", "unmatched_registered"].includes(row.status))
    .map((row) => normalizePath(row.source_path).toLowerCase() + "=>" + normalizePath(row.target_path).toLowerCase()));
  const durableIntents = new Set(journal.filter((row) => row.event === "move_intent").map((row) => normalizePath(row.source_path).toLowerCase() + "=>" + normalizePath(row.target_path).toLowerCase()));
  const runId = rows[0].run_id || makeId();
  const approved = rows.filter((row) => String(row.move_approved).toLowerCase() === "yes" || String(row.register_owned).toLowerCase() === "yes");
  if (!approved.length) throw new Error("no_preapproved_rows");
  const targetSourceGroups = new Map();
  for (const row of approved) {
    const target = normalizePath(row.target_path).toLowerCase();
    const sources = targetSourceGroups.get(target) || new Set();
    sources.add(normalizePath(row.source_path).toLowerCase());
    targetSourceGroups.set(target, sources);
  }
  const collidedTargets = new Set([...targetSourceGroups].filter(([, sources]) => sources.size > 1).map(([target]) => target));
  const index = catalogIndex(args.catalogFile);
  const outcomes = [];
  await withDb(args, async (db) => {
    const relations = await discoverRegistryRelations(db);
    const registered = await fetchRegisteredPaths(db, relations);
    for (const row of approved) {
      const source = normalizePath(row.source_path);
      const destination = targetPath(source, String(row.register_owned).toLowerCase() !== "yes");
      const requested = normalizePath(row.target_path);
      const registerOwned = String(row.register_owned).toLowerCase() === "yes";
      const markers = markerState(source);
      const actualMatch = matchFile(source, index);
      let status = "planned", note = "";
      if (!allowedDrive(source)) { status = "blocked_path_or_drive"; note = "Only D/E/F/G/H/I/J/K/L/N/P/Q/R/T are allowed; S is excluded."; }
      else if (!VIDEO_EXTENSIONS.has(path.win32.extname(source).toLowerCase())) { status = "blocked_extension"; note = "Unsupported video extension."; }
      else if (isProtectedByPath(source)) { status = "protected_existing_site_path"; note = "FC2 and existing uncen collection paths are protected."; }
      else if (registered.has(source.toLowerCase())) { status = "already_registered_protected"; note = "Path is registered in an existing owned-file relation; no move or update is allowed."; }
      else if (registered.has(destination.toLowerCase())) { status = "registered_destination_protected"; note = "Destination path is already registered in an owned-file relation."; }
      else if (collidedTargets.has(destination.toLowerCase())) { status = "same_drive_target_name_collision"; note = "Multiple distinct source videos share this flat same-drive target name; preserve every source and do not rename or overwrite."; }
      else if (requested.toLowerCase() !== destination.toLowerCase()) { status = "blocked_target_mismatch"; note = "Target must preserve the original file name under same-drive uncen/gachinco."; }
      else if (registerOwned && row.classification !== "manual_confirmed" && (!actualMatch.inScope || !actualMatch.movieCode || actualMatch.movieCode !== row.movie_code)) { status = "catalog_match_changed"; note = "The current catalog no longer verifies this CSV work mapping."; }
      else if (!registerOwned && !actualMatch.inScope && !markers.filenameMarker && !markers.providerMarker) { status = "site_marker_missing"; note = "The current video filename no longer contains an explicit Gachinco marker."; }
      else if (registerOwned && !validMovieCode(row.movie_code)) { status = "blocked_missing_movie_code"; note = "A valid Gachinco master movie_code is required."; }
      else if (registerOwned && !["catalog_title", "bundle_constituent_title", "exact_catalog_id", "manual_confirmed"].includes(row.classification)) { status = "blocked_match_class"; note = "Only a unique catalog title, explicit bundle constituent, or reviewed CSV mapping can be registered."; }
      else if (registerOwned && !markers.filenameMarker && !markers.pathMarker && !markers.providerMarker) { status = "site_marker_missing"; note = "Title-only candidates without a Gachinco filename or path marker stay at the original path."; }
      else if (registerOwned && row.classification !== "manual_confirmed" && actualMatch.titleEvidence === "exact_parent_folder_title") { status = "parent_folder_title_needs_review"; note = "A parent-folder title alone cannot establish that this video is part of the work."; }
      else if (!registerOwned && !markers.filenameMarker && !markers.providerMarker) { status = "filename_marker_missing"; note = "Only explicit video-filename markers may be moved to unmatched."; }
      else if (registerOwned && String(row.move_approved).toLowerCase() !== "yes") { status = "blocked_unapproved_owned_move"; note = "The CSV must approve a mapped Gachinco-marked file before moving/registering."; }
      else {
        const same = source.toLowerCase() === destination.toLowerCase();
        const recoveryKey = source.toLowerCase() + "=>" + destination.toLowerCase();
        if (same && fs.existsSync(source)) status = stableFile(source, row) ? "ready_at_target" : "file_changed_or_recent";
        else if ((recovered.has(recoveryKey) || durableIntents.has(recoveryKey)) && !fs.existsSync(source) && expectedFileAt(destination, row)) status = "ready_after_prior_move";
        else if (!fs.existsSync(source)) { status = "source_missing"; note = "Source disappeared after review."; }
        else if (!stableFile(source, row)) { status = "file_changed_or_recent"; note = "File changed since scan or was modified within the last ten minutes."; }
        else if (fs.existsSync(destination)) { status = "destination_collision"; note = "Destination exists; no overwrite or filename change."; }
        else status = args.apply ? "move_ready" : "planned";
      }
      const outcome = { ...row, status, note, applied_at: args.apply ? new Date().toISOString() : "" };
      if (args.apply && ["move_ready", "ready_at_target", "ready_after_prior_move"].includes(status)) {
        try {
          if (status === "move_ready") {
            // Refresh the cross-site registry immediately before the filesystem mutation.
            const newlyRegistered = await findRegisteredPath(db, relations, [source, destination]);
            if (newlyRegistered.length) throw new Error("registered_path_protection_recheck:" + newlyRegistered.join(" | "));
            if (isProtectedByPath(source)) throw new Error("protected_path_recheck");
            if (registerOwned && (!markers.filenameMarker && !markers.pathMarker && !markers.providerMarker || (row.classification !== "manual_confirmed" && (actualMatch.titleEvidence === "exact_parent_folder_title" || actualMatch.movieCode !== row.movie_code)))) throw new Error("catalog_or_site_evidence_changed_before_move");
            if (!registerOwned && !markers.filenameMarker && !markers.providerMarker) throw new Error("filename_marker_missing_before_unmatched_move");
            if (fs.existsSync(destination)) throw new Error("destination_collision_before_move");
            if (!stableFile(source, row)) throw new Error("source_changed_before_move");
            fs.mkdirSync(path.win32.dirname(destination), { recursive: true });
            const sourceStat = fs.statSync(source);
            const intent = { event: "move_intent", run_id: runId, source_path: source, target_path: destination, file_size_bytes: sourceStat.size, file_mtime: sourceStat.mtime.toISOString(), source_dev: String(sourceStat.dev), source_ino: String(sourceStat.ino), created_at: new Date().toISOString() };
            appendJsonLine(journalPath, intent);
            fs.renameSync(source, destination);
            if (!expectedFileAt(destination, row)) throw new Error("move_postcheck_failed");
            const targetStat = fs.statSync(destination);
            appendJsonLine(journalPath, { ...intent, event: "move_completed", completed_at: new Date().toISOString(), target_dev: String(targetStat.dev), target_ino: String(targetStat.ino) });
            outcome.status = "moved_pending_db";
          } else if (status === "ready_at_target") outcome.status = "moved_pending_db";
          outcome.target_path = destination;
        } catch (error) { outcome.status = "move_failed"; outcome.note = String(error.message || error); }
      }
      outcomes.push(outcome);
      writeCsv(output, outcomes, COLUMNS.concat(["applied_at"]));
    }
    if (!args.apply) return;
    const ready = outcomes.filter((row) => ["moved_pending_db", "ready_after_prior_move"].includes(row.status));
    await db.query("begin");
    try {
      for (const row of ready) {
        const source = normalizePath(row.source_path), destination = normalizePath(row.target_path);
        const stat = fs.statSync(destination);
        if (String(row.register_owned).toLowerCase() === "yes") {
          const master = await db.query("select movie_code from cl.gachinco_tm001_master where movie_code=$1", [row.movie_code]);
          if (master.rowCount !== 1) throw new Error("movie_code_missing_from_master:" + row.movie_code);
          const owned = await db.query(
            "insert into cl.gachinco_tm002_owned_files (movie_code,file_path,original_file_path,file_name,file_ext,drive_letter,file_size_bytes,file_mtime,source_type,match_method,match_score,original_file_name,last_seen_at,note,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,'normal',$9,$10,$4,now(),'gachinco manual ownership registration',now()) on conflict (file_path) do nothing returning owned_file_id",
            [row.movie_code, destination, source, path.win32.basename(destination), path.win32.extname(destination).slice(1).toLowerCase(), driveOf(destination), stat.size, stat.mtime.toISOString(), row.classification === "manual_confirmed" ? "manual_user_match" : row.match_method, Number(row.confidence)]
          );
          if (owned.rowCount !== 1) throw new Error("owned_file_path_conflict:" + destination);
          await db.query(
            "insert into cl.gachinco_tm011_owned_file_video_metadata (owned_file_id,movie_code,file_path,file_name,file_size_bytes,file_mtime,probe_status,updated_at) select owned_file_id,movie_code,file_path,file_name,file_size_bytes,file_mtime,'pending',now() from cl.gachinco_tm002_owned_files where file_path=$1 on conflict (owned_file_id) do nothing",
            [destination]
          );
          row.status = "registered";
          await db.query("update cl.gachinco_tm005_unmatched_files set status='resolved',updated_at=now() where lower(current_path)=any($1::text[])", [[source.toLowerCase(), destination.toLowerCase()]]);
        } else {
          await db.query(
            "insert into cl.gachinco_tm005_unmatched_files (run_id,detected_path,current_path,detected_file_name,current_file_name,extracted_source_record_id,reason,status,source,file_size_bytes,file_mtime,note,updated_at) values ($1,$2,$3,$4,$4,nullif($5,''),$6,'review_required','gachinco_manual',$7,$8,$9,now()) on conflict (current_path) do update set run_id=excluded.run_id,file_size_bytes=excluded.file_size_bytes,file_mtime=excluded.file_mtime,updated_at=now()",
            [runId, source, destination, path.win32.basename(destination), row.source_record_id || "", row.match_method || "site_marker", stat.size, stat.mtime.toISOString(), row.note || "No unique Gachinco catalog identity."]
          );
          row.status = "unmatched_registered";
        }
        await db.query(
          "insert into cl.gachinco_tl001_file_process_logs (run_id,movie_code,old_path,new_path,old_file_name,new_file_name,action,status,source,matched_by,note) values ($1,nullif($2,''),$3,$4,$5,$6,$7,$8,'gachinco_manual',$9,$10)",
          [runId, row.movie_code || "", source, destination, path.win32.basename(source), path.win32.basename(destination), String(row.register_owned).toLowerCase() === "yes" ? "register_owned_file" : (source.toLowerCase() === destination.toLowerCase() ? "record_unmatched_file" : "move_unmatched_file"), row.status, row.match_method || "", row.note || ""]
        );
      }
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
    writeCsv(output, outcomes, COLUMNS.concat(["applied_at"]));
  });
  if (!args.apply) say("DRY-RUN: " + approved.length + " pre-approved CSV rows; no files or DB records changed.");
  say("Plan/results: " + output);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.step === "owned-review") await review(args);
  else if (args.step === "owned-apply") await apply(args);
  else throw new Error("unsupported_step:" + args.step);
}
main().catch((error) => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
