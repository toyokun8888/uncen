"use strict";

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { spawnSync } = require("child_process");

const PACO_SOURCE_NAME = "paco";
const PACO_BASE_URL = "https://www.caribbeancom.com";
const DEFAULT_MASTER_URL = `${PACO_BASE_URL}/listpages/paco/all1.htm`;
const DEFAULT_NEW_MP4_DIR = "P:\\uncen\\paco_new_mp4";
const DEFAULT_OWNED_DIR = "P:\\uncen\\paco";
const DEFAULT_TRASH_DIR = "P:\\uncen\\paco_trash";
const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "storage", "exports", "paco-manual-dry-run");
const PACO_SITE_ID = 1;

function parseArgs(argv) {
  const args = {
    source: PACO_SOURCE_NAME,
    step: "",
    envFile: "",
    masterUrl: DEFAULT_MASTER_URL,
    newMp4Dir: DEFAULT_NEW_MP4_DIR,
    ownedDir: DEFAULT_OWNED_DIR,
    trashDir: DEFAULT_TRASH_DIR,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") {
      args.source = argv[++i];
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg === "--step") {
      args.step = argv[++i];
    } else if (arg.startsWith("--step=")) {
      args.step = arg.slice("--step=".length);
    } else if (arg === "--env-file") {
      args.envFile = argv[++i];
    } else if (arg.startsWith("--env-file=")) {
      args.envFile = arg.slice("--env-file=".length);
    } else if (arg === "--master-url") {
      args.masterUrl = argv[++i];
    } else if (arg.startsWith("--master-url=")) {
      args.masterUrl = arg.slice("--master-url=".length);
    } else if (arg === "--new-mp4-dir") {
      args.newMp4Dir = argv[++i];
    } else if (arg.startsWith("--new-mp4-dir=")) {
      args.newMp4Dir = arg.slice("--new-mp4-dir=".length);
    } else if (arg === "--owned-dir") {
      args.ownedDir = argv[++i];
    } else if (arg.startsWith("--owned-dir=")) {
      args.ownedDir = arg.slice("--owned-dir=".length);
    } else if (arg === "--trash-dir") {
      args.trashDir = argv[++i];
    } else if (arg.startsWith("--trash-dir=")) {
      args.trashDir = arg.slice("--trash-dir=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.source !== PACO_SOURCE_NAME) {
    throw new Error(`Unsupported source: ${args.source}`);
  }
  if (!["master-dry-run", "master-apply", "owned-dry-run", "owned-apply"].includes(args.step)) {
    throw new Error("step must be master-dry-run, master-apply, owned-dry-run, or owned-apply");
  }

  return args;
}

function loadEnvFile(envFile) {
  if (!envFile) return false;
  const envPath = path.resolve(envFile);
  if (!fs.existsSync(envPath)) {
    throw new Error(`env-file does not exist: ${envPath}`);
  }

  const dotenv = require("dotenv");
  const result = dotenv.config({ path: envPath });
  if (result.error) {
    throw result.error;
  }
  return true;
}

function runVideoMetadataCollect(envFile) {
  const scriptPath = path.resolve(__dirname, "collect-video-metadata.js");
  const commandArgs = [scriptPath, "--source", PACO_SOURCE_NAME, "--step", "collect"];
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

function buildRunId(step) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${PACO_SOURCE_NAME}_${step}_${stamp}_${process.pid}`;
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const bytes = await response.arrayBuffer();
  return new TextDecoder("euc-jp").decode(bytes);
}

function parsePacoEntries(html, pageUrl) {
  const $ = cheerio.load(html);
  const rows = [];

  $(".entry").each((index, element) => {
    const entry = $(element);
    const detailPath =
      entry.find(".meta-title a").attr("href") || entry.find(".media-thum a").attr("href") || "";
    const dateText = entry.find(".entry-meta .meta-data").first().text().trim();
    const title = cleanText(entry.find(".meta-title a").text());
    const actorName = entry
      .find('[itemprop="actor"] [itemprop="name"]')
      .map((_, actor) => cleanText($(actor).text()))
      .get()
      .filter(Boolean)
      .join(",");
    const channelName = cleanText(entry.find(".tag-channel").first().text());
    const thumbnailUrl = normalizeUrl(entry.find("img.media-image").attr("src"), pageUrl);

    if (!detailPath || !dateText || !title) return;

    const movieCode = firstMatch(detailPath, /\/moviepages\/([^/]+)\/index\.html/);
    const relationKey = dateToMmddyy(dateText);
    const suffix = movieCode ? firstMatch(movieCode, /^[0-9]{6}_(.+)$/) : "";

    rows.push({
      relation_key_mmddyy: relationKey,
      release_date: dateText,
      movie_code: movieCode || "",
      movie_code_suffix: suffix || "",
      title,
      actor_name: actorName,
      channel_name: channelName,
      detail_path: detailPath,
      detail_url: normalizeUrl(detailPath, pageUrl),
      thumbnail_url: thumbnailUrl,
      source_page_url: pageUrl,
      row_index_in_page: index + 1,
    });
  });

  return rows;
}

function firstMatch(value, regex) {
  const match = String(value || "").match(regex);
  return match ? match[1] : "";
}

function cleanText(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  return raw ? new URL(raw, baseUrl).toString() : "";
}

function dateToMmddyy(dateText) {
  const match = String(dateText || "").match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/);
  if (!match) {
    throw new Error(`Invalid date: ${dateText}`);
  }
  return `${match[2]}${match[3]}${match[1].slice(2)}`;
}

function validatePacoRows(rows) {
  for (const row of rows) {
    if (!row.movie_code.match(/^[0-9]{6}_.+$/)) {
      throw new Error(`Invalid movie_code: ${row.movie_code}`);
    }
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

async function fetchMasterRowsByMovieCode(client, movieCodes) {
  if (movieCodes.length === 0) return new Map();
  const result = await client.query(
    `
      select movie_code, release_date::text as release_date, title, actor_name, detail_url, thumbnail_url
      from cl.paco_m001_master_staging
      where movie_code = any($1::text[])
    `,
    [movieCodes]
  );
  return new Map(result.rows.map((row) => [row.movie_code, row]));
}

async function fetchOwnedCountsByMovieCode(client, movieCodes) {
  if (movieCodes.length === 0) return new Map();
  const result = await client.query(
    `
      select movie_code, count(*)::integer as owned_count
      from cl.paco_owned_file
      where movie_code = any($1::text[])
      group by movie_code
    `,
    [movieCodes]
  );
  return new Map(result.rows.map((row) => [row.movie_code, row.owned_count]));
}

async function runMasterDryRun(args) {
  const runId = buildRunId("master_dry_run");
  const html = await fetchHtml(args.masterUrl);
  const rows = parsePacoEntries(html, args.masterUrl);
  validatePacoRows(rows);

  const movieCodes = unique(rows.map((row) => row.movie_code));
  const client = createPgClient();
  await client.connect();
  try {
    const existingRows = await fetchMasterRowsByMovieCode(client, movieCodes);
    const resultRows = rows.map((row) => ({
      ...row,
      exists_in_master: existingRows.has(row.movie_code),
      dry_run_action: existingRows.has(row.movie_code) ? "skip_existing_master" : "would_insert_master",
    }));
    const newRows = resultRows.filter((row) => !row.exists_in_master);
    const output = {
      ok: true,
      step: "master-dry-run",
      dry_run: true,
      source: PACO_SOURCE_NAME,
      master_url: args.masterUrl,
      fetched_count: rows.length,
      existing_count: rows.length - newRows.length,
      new_count: newRows.length,
      json_path: "",
      csv_path: "",
      new_rows: newRows,
    };
    writeReports(runId, resultRows, output);
    return output;
  } finally {
    await client.end();
  }
}

async function runMasterApply(args) {
  const runId = buildRunId("master_apply");
  const html = await fetchHtml(args.masterUrl);
  const rows = parsePacoEntries(html, args.masterUrl);
  validatePacoRows(rows);

  const movieCodes = unique(rows.map((row) => row.movie_code));
  const client = createPgClient();
  await client.connect();
  try {
    const existingRows = await fetchMasterRowsByMovieCode(client, movieCodes);
    const newRows = rows.filter((row) => !existingRows.has(row.movie_code));
    await insertNewMasterRows(client, runId, newRows);
    const output = {
      ok: true,
      step: "master-apply",
      dry_run: false,
      source: PACO_SOURCE_NAME,
      master_url: args.masterUrl,
      fetched_count: rows.length,
      existing_count: rows.length - newRows.length,
      inserted_count: newRows.length,
      json_path: "",
      csv_path: "",
      inserted_rows: newRows,
    };
    writeReports(runId, newRows, output);
    return output;
  } finally {
    await client.end();
  }
}

async function insertNewMasterRows(client, runId, rows) {
  await client.query("begin");
  try {
    await client.query(
      `
        insert into cl.paco_m001_master_collect_runs (
          run_id, source_name, mode, status, pages_requested, pages_processed, rows_collected, rows_inserted
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [runId, PACO_SOURCE_NAME, "manual-apply", "running", 1, 1, rows.length, 0]
    );

    for (const row of rows) {
      const rawResult = await client.query(
        `
          insert into cl.paco_m001_master_raw (
            relation_key_mmddyy,
            release_date,
            movie_code,
            movie_code_suffix,
            title,
            actor_name,
            channel_name,
            detail_path,
            detail_url,
            thumbnail_url,
            source_page_url,
            page_number,
            row_index_in_page,
            raw_payload,
            last_run_id
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, 1, $12, $13::jsonb, $14
          )
          on conflict (movie_code) do nothing
          returning id
        `,
        [
          row.relation_key_mmddyy,
          row.release_date,
          row.movie_code,
          row.movie_code_suffix,
          row.title,
          row.actor_name,
          row.channel_name,
          row.detail_path,
          row.detail_url,
          row.thumbnail_url,
          row.source_page_url,
          row.row_index_in_page,
          JSON.stringify(row),
          runId,
        ]
      );

      const rawId = rawResult.rows[0] ? rawResult.rows[0].id : null;
      await client.query(
        `
          insert into cl.paco_m001_master_staging (
            relation_key_mmddyy,
            release_date,
            movie_code,
            movie_code_suffix,
            title,
            actor_name,
            channel_name,
            detail_url,
            thumbnail_url,
            raw_id,
            last_run_id
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          on conflict (movie_code) do nothing
        `,
        [
          row.relation_key_mmddyy,
          row.release_date,
          row.movie_code,
          row.movie_code_suffix,
          row.title,
          row.actor_name,
          row.channel_name,
          row.detail_url,
          row.thumbnail_url,
          rawId,
          runId,
        ]
      );
    }

    await client.query(
      `
        update cl.paco_m001_master_collect_runs
        set finished_at = now(),
            status = 'success',
            rows_inserted = $2
        where run_id = $1
      `,
      [runId, rows.length]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function runOwnedDryRun(args) {
  const { files, mp4Files, resultRows } = await buildOwnedPlan(args);
  const runId = buildRunId("owned_dry_run");
  const summary = summarizeOwnedRows(resultRows);
  const output = {
    ok: true,
    step: "owned-dry-run",
    dry_run: true,
    source: PACO_SOURCE_NAME,
    scan_root: path.resolve(args.newMp4Dir),
    files_seen: files.length,
    mp4_files_seen: mp4Files.length,
    ignored_non_mp4_files: files.length - mp4Files.length,
    json_path: "",
    csv_path: "",
    ...summary,
    preview: resultRows.slice(0, 20),
  };
  writeReports(runId, resultRows, output);
  return output;
}

async function buildOwnedPlan(args) {
  const runId = buildRunId("owned_dry_run");
  const scanRoot = path.resolve(args.newMp4Dir);
  if (!fs.existsSync(scanRoot)) {
    throw new Error(`new-mp4-dir does not exist: ${scanRoot}`);
  }

  const files = listFilesRecursive(scanRoot);
  const mp4Files = files.filter((filePath) => path.extname(filePath).toLowerCase() === ".mp4");
  const scannedRows = mp4Files.map((filePath) => {
    const fileName = path.basename(filePath);
    const stat = fs.statSync(filePath);
    return {
      file_path: filePath,
      file_name: fileName,
      file_ext: "mp4",
      file_size_bytes: stat.size,
      file_mtime: stat.mtime.toISOString(),
      movie_code: extractMovieCode(fileName),
    };
  });

  const movieCodes = unique(scannedRows.map((row) => row.movie_code).filter(Boolean));
  const client = createPgClient();
  await client.connect();
  try {
    const masterRows = await fetchMasterRowsByMovieCode(client, movieCodes);
    const ownedCounts = await fetchOwnedCountsByMovieCode(client, movieCodes);
    const resultRows = scannedRows.map((row) =>
      buildOwnedDryRunRow(row, masterRows, ownedCounts, args.ownedDir, args.trashDir)
    );
    return { runId, scanRoot, files, mp4Files, resultRows };
  } finally {
    await client.end();
  }
}

async function runOwnedApply(args) {
  const { files, mp4Files, resultRows } = await buildOwnedPlan(args);
  const runId = buildRunId("owned_apply");
  const summary = summarizeOwnedRows(resultRows);
  const unsupported = resultRows.filter((row) => row.dry_run_status === "already_owned");
  if (unsupported.length > 0) {
    throw new Error(`already_owned rows are not applied: ${unsupported.length}`);
  }

  const rowsToOwned = resultRows.filter((row) => row.dry_run_status === "ready_to_move");
  const rowsToTrash = resultRows.filter((row) => row.dry_run_status.startsWith("would_move_trash_"));
  const manifestRows = buildApplyManifestRows(rowsToOwned, rowsToTrash);
  const manifestOutput = {
    ok: true,
    step: "owned-apply-manifest",
    dry_run: false,
    source: PACO_SOURCE_NAME,
    scan_root: path.resolve(args.newMp4Dir),
    files_seen: files.length,
    mp4_files_seen: mp4Files.length,
    ignored_non_mp4_files: files.length - mp4Files.length,
    ...summary,
  };
  writeReports(runId, manifestRows, manifestOutput);

  const movedRows = [];
  for (const row of manifestRows) {
    fs.mkdirSync(path.dirname(row.actual_target_path), { recursive: true });
    fs.renameSync(row.source_path, row.actual_target_path);
    movedRows.push({
      ...row,
      applied: true,
    });
  }

  const ownedDbRows = movedRows
    .filter((row) => row.apply_action === "move_to_owned")
    .map((row) => buildOwnedDbRow(row));
  const dbResult = await upsertOwnedDbRows(ownedDbRows);
  const videoMetadataResult = ownedDbRows.length > 0 ? runVideoMetadataCollect(args.envFile) : {};

  const output = {
    ok: true,
    step: "owned-apply",
    dry_run: false,
    source: PACO_SOURCE_NAME,
    scan_root: path.resolve(args.newMp4Dir),
    files_seen: files.length,
    mp4_files_seen: mp4Files.length,
    ignored_non_mp4_files: files.length - mp4Files.length,
    moved_to_owned_count: ownedDbRows.length,
    moved_to_trash_count: movedRows.length - ownedDbRows.length,
    db_result: dbResult,
    video_metadata_result: videoMetadataResult,
    json_path: "",
    csv_path: "",
    manifest_json_path: manifestOutput.json_path,
    manifest_csv_path: manifestOutput.csv_path,
    moved_rows: movedRows,
  };
  writeReports(`${runId}_result`, movedRows, output);
  return output;
}

function listFilesRecursive(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b, "ja"));
}

function extractMovieCode(fileName) {
  const normalized = String(fileName || "").replace(/([0-9]{6})-([0-9A-Za-z]+)/g, "$1_$2");
  const match = normalized.match(/([0-9]{6}_[0-9A-Za-z]+)/);
  return match ? match[1] : "";
}

function buildOwnedDryRunRow(row, masterRows, ownedCounts, ownedDir, trashDir) {
  const master = row.movie_code ? masterRows.get(row.movie_code) : null;
  const ownedCount = row.movie_code ? ownedCounts.get(row.movie_code) || 0 : 0;
  const base = {
    ...row,
    matched_master: Boolean(master),
    owned_count: ownedCount,
    already_owned: ownedCount > 0,
    master_title: master ? master.title : "",
    master_actor_name: master ? master.actor_name || "" : "",
    master_release_date: master ? master.release_date : "",
    detail_url: master ? master.detail_url || "" : "",
    thumbnail_url: master ? master.thumbnail_url || "" : "",
    planned_target_path: "",
    planned_trash_path: "",
  };

  if (!row.movie_code) {
    return {
      ...base,
      dry_run_status: "would_move_trash_unreadable_movie_code",
      planned_trash_path: path.join(path.resolve(trashDir), row.file_name),
    };
  }
  if (!master) {
    return {
      ...base,
      dry_run_status: "would_move_trash_missing_master",
      planned_trash_path: path.join(path.resolve(trashDir), row.file_name),
    };
  }

  const targetName = buildOwnedFileName(row.movie_code, master.title, master.actor_name, row.file_ext);
  const plannedTargetPath = path.join(path.resolve(ownedDir), targetName);
  return {
    ...base,
    dry_run_status: ownedCount > 0 ? "already_owned" : "ready_to_move",
    planned_target_path: plannedTargetPath,
  };
}

function buildOwnedFileName(movieCode, title, actorName, fileExt) {
  const parts = [movieCode, title, actorName].map((part) => sanitizeFileNamePart(part)).filter(Boolean);
  return `${parts.join("_")}.${fileExt || "mp4"}`;
}

function buildApplyManifestRows(rowsToOwned, rowsToTrash) {
  const usedTargets = new Set();
  return [...rowsToOwned, ...rowsToTrash].map((row) => {
    const plannedPath = row.dry_run_status === "ready_to_move" ? row.planned_target_path : row.planned_trash_path;
    const actualTargetPath = availablePath(plannedPath, usedTargets);
    return {
      apply_action: row.dry_run_status === "ready_to_move" ? "move_to_owned" : "move_to_trash",
      dry_run_status: row.dry_run_status,
      movie_code: row.movie_code,
      source_path: row.file_path,
      source_file_name: row.file_name,
      planned_target_path: plannedPath,
      actual_target_path: actualTargetPath,
      actual_target_file_name: path.basename(actualTargetPath),
      master_title: row.master_title,
      master_actor_name: row.master_actor_name,
      file_ext: row.file_ext,
      file_size_bytes: row.file_size_bytes,
      file_mtime: row.file_mtime,
    };
  });
}

function availablePath(targetPath, usedTargets) {
  const parsed = path.parse(targetPath);
  let candidate = targetPath;
  let index = 1;
  while (fs.existsSync(candidate) || usedTargets.has(candidate.toLowerCase())) {
    candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
  usedTargets.add(candidate.toLowerCase());
  return candidate;
}

function buildOwnedDbRow(row) {
  const stat = fs.statSync(row.actual_target_path);
  const driveMatch = path.resolve(row.actual_target_path).match(/^([A-Za-z]):\\/);
  return {
    source_site_id: PACO_SITE_ID,
    movie_code: row.movie_code,
    file_path: row.actual_target_path,
    file_name: path.basename(row.actual_target_path),
    file_ext: row.file_ext,
    drive_letter: driveMatch ? driveMatch[1].toUpperCase() : "",
    file_size_bytes: stat.size,
    file_mtime: stat.mtime,
  };
}

async function getActorLinksForMovie(client, movieCode) {
  const result = await client.query(
    `
      select
        actor_name_master.actor_name_id,
        actor_name_master.actor_group_id
      from cl.paco_m001_master_staging master
      cross join lateral regexp_split_to_table(coalesce(master.actor_name, ''), ',') as actor_name_part
      join cl.actor_name_master actor_name_master
        on actor_name_master.site_id = $2
       and actor_name_master.actor_name = btrim(actor_name_part)
      where master.movie_code = $1
        and btrim(actor_name_part) <> ''
      order by actor_name_master.actor_name_id
    `,
    [movieCode, PACO_SITE_ID]
  );

  return result.rows;
}

async function upsertOwnedDbRows(rows) {
  if (rows.length === 0) {
    return { imported_file_count: 0, imported_actor_link_count: 0 };
  }

  const client = createPgClient();
  await client.connect();
  try {
    await client.query("begin");
    let actorLinkCount = 0;
    for (const row of rows) {
      const ownedResult = await client.query(
        `
          insert into cl.paco_owned_file (
            source_site_id,
            movie_code,
            file_path,
            file_name,
            file_ext,
            drive_letter,
            file_size_bytes,
            file_mtime,
            last_seen_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, now())
          on conflict (file_path) do update set
            source_site_id = excluded.source_site_id,
            movie_code = excluded.movie_code,
            file_name = excluded.file_name,
            file_ext = excluded.file_ext,
            drive_letter = excluded.drive_letter,
            file_size_bytes = excluded.file_size_bytes,
            file_mtime = excluded.file_mtime,
            last_seen_at = now(),
            updated_at = now()
          returning owned_file_id
        `,
        [
          row.source_site_id,
          row.movie_code,
          row.file_path,
          row.file_name,
          row.file_ext,
          row.drive_letter,
          row.file_size_bytes,
          row.file_mtime,
        ]
      );

      const ownedFileId = ownedResult.rows[0].owned_file_id;
      await client.query("delete from cl.paco_owned_file_actor where owned_file_id = $1", [ownedFileId]);

      const actorLinks = await getActorLinksForMovie(client, row.movie_code);
      for (const actorLink of actorLinks) {
        await client.query(
          `
            insert into cl.paco_owned_file_actor (
              owned_file_id,
              actor_name_id,
              actor_group_id
            )
            values ($1, $2, $3)
            on conflict (owned_file_id, actor_name_id) do nothing
          `,
          [ownedFileId, actorLink.actor_name_id, actorLink.actor_group_id]
        );
        actorLinkCount += 1;
      }
    }
    await client.query("commit");
    return { imported_file_count: rows.length, imported_actor_link_count: actorLinkCount };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

function sanitizeFileNamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeOwnedRows(rows) {
  const summary = {
    ready_to_move_count: 0,
    already_owned_count: 0,
    missing_master_count: 0,
    unreadable_movie_code_count: 0,
  };
  for (const row of rows) {
    if (row.dry_run_status === "ready_to_move") summary.ready_to_move_count += 1;
    if (row.dry_run_status === "already_owned") summary.already_owned_count += 1;
    if (row.dry_run_status === "would_move_trash_missing_master") summary.missing_master_count += 1;
    if (row.dry_run_status === "would_move_trash_unreadable_movie_code") summary.unreadable_movie_code_count += 1;
  }
  return summary;
}

function unique(values) {
  return Array.from(new Set(values));
}

function writeReports(runId, rows, output) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const jsonPath = path.join(OUTPUT_DIR, `${runId}.json`);
  const csvPath = path.join(OUTPUT_DIR, `${runId}.csv`);
  const outputWithPaths = { ...output, json_path: jsonPath, csv_path: csvPath };
  fs.writeFileSync(jsonPath, JSON.stringify({ ...outputWithPaths, rows }, null, 2), "utf8");
  fs.writeFileSync(csvPath, toCsv(rows), "utf8");
  output.json_path = jsonPath;
  output.csv_path = csvPath;
}

function toCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => set.add(key));
    return set;
  }, new Set()));
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(","))].join("\r\n");
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);
  const output =
    args.step === "master-dry-run"
      ? await runMasterDryRun(args)
      : args.step === "master-apply"
        ? await runMasterApply(args)
      : args.step === "owned-dry-run"
        ? await runOwnedDryRun(args)
        : await runOwnedApply(args);
  process.stdout.write(`${JSON.stringify({ ...output, env_file_loaded: loadedEnv }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
