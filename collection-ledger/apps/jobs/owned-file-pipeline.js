"use strict";

const fs = require("fs");
const path = require("path");

const PACO_SITE_ID = 1;
const PACO_SOURCE_NAME = "paco";
const DEFAULT_DRIVES = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P"];

function parseArgs(argv) {
  const args = {
    step: "status",
    source: PACO_SOURCE_NAME,
    envFile: "",
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--step") {
      args.step = argv[++i];
    } else if (arg.startsWith("--step=")) {
      args.step = arg.slice("--step=".length);
    } else if (arg === "--source") {
      args.source = argv[++i];
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg === "--env-file") {
      args.envFile = argv[++i];
    } else if (arg.startsWith("--env-file=")) {
      args.envFile = arg.slice("--env-file=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

async function initDb() {
  const sqlPath = path.resolve(__dirname, "..", "..", "ops", "sql", "040_paco_owned_files.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = createPgClient();

  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function listPacoRootFiles() {
  const files = [];

  for (const drive of DEFAULT_DRIVES) {
    const targetDir = `${drive}:\\uncen\\paco`;
    if (!fs.existsSync(targetDir)) {
      continue;
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      files.push(path.join(targetDir, entry.name));
    }
  }

  return files.sort((a, b) => a.localeCompare(b, "ja"));
}

function extractMovieCode(fileName) {
  const match = String(fileName || "").match(/^([0-9]{6}_[0-9A-Za-z]+)_/);
  return match ? match[1] : "";
}

function buildFileRows(files) {
  return files.map((filePath) => {
    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const parsed = path.parse(filePath);
    const driveMatch = path.resolve(filePath).match(/^([A-Za-z]):\\/);

    return {
      source_site_id: PACO_SITE_ID,
      movie_code: extractMovieCode(fileName),
      file_path: filePath,
      file_name: fileName,
      file_ext: parsed.ext ? parsed.ext.slice(1).toLowerCase() : "",
      drive_letter: driveMatch ? driveMatch[1].toUpperCase() : "",
      file_size_bytes: stat.size,
      file_mtime: stat.mtime,
    };
  });
}

async function fetchKnownMovieCodes(client) {
  const result = await client.query("select movie_code from cl.paco_m001_master_staging");
  return new Set(result.rows.map((row) => row.movie_code));
}

function validateFileRows(fileRows, knownMovieCodes) {
  const problems = [];
  const seenPaths = new Set();

  for (const row of fileRows) {
    const normalizedPath = path.resolve(row.file_path).toLowerCase();
    if (seenPaths.has(normalizedPath)) {
      problems.push({ type: "duplicate_file_path_in_scan", file_path: row.file_path });
    }
    seenPaths.add(normalizedPath);

    if (!row.movie_code) {
      problems.push({ type: "movie_code_not_found_in_file_name", file_path: row.file_path });
      continue;
    }
    if (!knownMovieCodes.has(row.movie_code)) {
      problems.push({ type: "movie_code_not_found_in_master", movie_code: row.movie_code, file_path: row.file_path });
    }
  }

  return problems;
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

async function upsertOwnedFiles(fileRows) {
  const client = createPgClient();
  await client.connect();

  try {
    await client.query("begin");

    const knownMovieCodes = await fetchKnownMovieCodes(client);
    const problems = validateFileRows(fileRows, knownMovieCodes);
    if (problems.length > 0) {
      throw new Error(`Owned file import has problems: ${JSON.stringify(problems.slice(0, 20), null, 2)}`);
    }

    let actorLinkCount = 0;
    for (const row of fileRows) {
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

    return {
      imported_file_count: fileRows.length,
      imported_actor_link_count: actorLinkCount,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

async function buildPlan() {
  const client = createPgClient();
  const fileRows = buildFileRows(listPacoRootFiles());

  await client.connect();
  try {
    const knownMovieCodes = await fetchKnownMovieCodes(client);
    const problems = validateFileRows(fileRows, knownMovieCodes);
    return {
      fileRows,
      problems,
    };
  } finally {
    await client.end();
  }
}

async function getStatus() {
  const client = createPgClient();
  await client.connect();

  try {
    const result = await client.query(
      `
        select
          (select count(*)::integer from cl.paco_owned_file) as owned_file_count,
          (select count(*)::integer from cl.paco_owned_file_actor) as owned_file_actor_count,
          (select count(distinct movie_code)::integer from cl.paco_owned_file) as owned_movie_count,
          (select count(distinct actor_name_id)::integer from cl.paco_owned_file_actor) as owned_actor_name_count,
          (select count(distinct actor_group_id)::integer from cl.paco_owned_file_actor) as owned_actor_group_count
      `
    );
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const loadedEnv = loadEnvFile(args.envFile);

  if (args.source !== PACO_SOURCE_NAME) {
    throw new Error(`Unsupported source: ${args.source}`);
  }

  if (args.step === "init-db") {
    await initDb();
    process.stdout.write(
      `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv) }, null, 2)}\n`
    );
    return;
  }

  if (args.step === "plan") {
    const plan = await buildPlan();
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          step: args.step,
          env_file_loaded: Boolean(loadedEnv),
          file_count: plan.fileRows.length,
          problems: plan.problems,
          preview: plan.fileRows.slice(0, 20),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (args.step === "import") {
    const plan = await buildPlan();
    if (args.dryRun) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            step: args.step,
            dry_run: true,
            env_file_loaded: Boolean(loadedEnv),
            file_count: plan.fileRows.length,
            problems: plan.problems,
            preview: plan.fileRows.slice(0, 20),
          },
          null,
          2
        )}\n`
      );
      return;
    }

    const result = await upsertOwnedFiles(plan.fileRows);
    process.stdout.write(
      `${JSON.stringify({ ok: true, step: args.step, dry_run: false, env_file_loaded: Boolean(loadedEnv), result }, null, 2)}\n`
    );
    return;
  }

  if (args.step === "status") {
    const status = await getStatus();
    process.stdout.write(
      `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), status }, null, 2)}\n`
    );
    return;
  }

  throw new Error(`Unsupported step: ${args.step}`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
