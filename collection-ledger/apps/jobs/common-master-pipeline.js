"use strict";

const fs = require("fs");
const path = require("path");

const PACO_SITE_ID = 1;
const PACO_SITE_CODE = "paco";
const PACO_SITE_NAME = "pacopacomama";

function parseArgs(argv) {
  const args = {
    step: "status",
    source: PACO_SITE_CODE,
    envFile: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--step") {
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
  const sqlPath = path.resolve(__dirname, "..", "..", "ops", "sql", "030_common_masters.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = createPgClient();

  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function seedPacoMasters() {
  const client = createPgClient();

  await client.connect();
  try {
    await client.query("begin");

    const siteResult = await client.query(
      `
        insert into cl.site_master (site_id, site_code, site_name, note)
        values ($1, $2, $3, $4)
        on conflict (site_code) do update set
          site_name = excluded.site_name,
          note = excluded.note,
          updated_at = now()
        returning site_id, site_code, site_name
      `,
      [PACO_SITE_ID, PACO_SITE_CODE, PACO_SITE_NAME, "seeded from cl.paco_m001_master_staging"]
    );
    const site = siteResult.rows[0];

    await client.query(
      `
        select setval(
          pg_get_serial_sequence('cl.site_master', 'site_id'),
          greatest((select max(site_id) from cl.site_master), 1),
          true
        )
      `
    );

    const actorResult = await client.query(
      `
        with actor_source as (
          select distinct btrim(actor_name_part) as actor_name
          from cl.paco_m001_master_staging
          cross join lateral regexp_split_to_table(coalesce(actor_name, ''), ',') as actor_name_part
          where btrim(actor_name_part) <> ''
        ),
        inserted_groups as (
          insert into cl.actor_group_master (group_code, representative_actor_name, note)
          select
            $2 || ':' || md5(actor_name) as group_code,
            actor_name as representative_actor_name,
            'initial group seeded from ' || $2 || ' actor name' as note
          from actor_source
          where not exists (
            select 1
            from cl.actor_name_master existing_name
            where existing_name.site_id = $1
              and existing_name.actor_name = actor_source.actor_name
          )
          on conflict (group_code) do update set
            representative_actor_name = excluded.representative_actor_name,
            updated_at = now()
          returning actor_group_id, group_code, representative_actor_name
        ),
        group_lookup as (
          select actor_group_id, group_code, representative_actor_name
          from inserted_groups
          union all
          select group_master.actor_group_id, group_master.group_code, group_master.representative_actor_name
          from cl.actor_group_master group_master
          join actor_source
            on group_master.group_code = $2 || ':' || md5(actor_source.actor_name)
        ),
        inserted_names as (
          insert into cl.actor_name_master (site_id, actor_name, actor_group_id, note)
          select
            $1 as site_id,
            actor_source.actor_name,
            group_lookup.actor_group_id,
            'seeded from cl.paco_m001_master_staging' as note
          from actor_source
          join group_lookup
            on group_lookup.group_code = $2 || ':' || md5(actor_source.actor_name)
          on conflict (site_id, actor_name) do update set
            updated_at = now()
          returning actor_name_id, actor_name, actor_group_id
        )
        select
          (select count(*)::integer from actor_source) as actor_source_count,
          (select count(*)::integer from inserted_groups) as inserted_or_updated_group_count,
          (select count(*)::integer from inserted_names) as inserted_or_touched_actor_name_count
      `,
      [site.site_id, site.site_code]
    );

    await client.query(
      `
        select setval(
          pg_get_serial_sequence('cl.actor_group_master', 'actor_group_id'),
          greatest((select max(actor_group_id) from cl.actor_group_master), 1),
          true
        )
      `
    );
    await client.query(
      `
        select setval(
          pg_get_serial_sequence('cl.actor_name_master', 'actor_name_id'),
          greatest((select max(actor_name_id) from cl.actor_name_master), 1),
          true
        )
      `
    );

    await client.query("commit");

    return {
      site,
      ...actorResult.rows[0],
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
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
          (select count(*)::integer from cl.site_master) as site_count,
          (select count(*)::integer from cl.actor_group_master) as actor_group_count,
          (select count(*)::integer from cl.actor_name_master) as actor_name_count,
          (
            select count(*)::integer
            from (
              select distinct btrim(actor_name_part) as actor_name
              from cl.paco_m001_master_staging
              cross join lateral regexp_split_to_table(coalesce(actor_name, ''), ',') as actor_name_part
              where btrim(actor_name_part) <> ''
            ) actor_source
          ) as paco_distinct_actor_source_count
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

  if (args.source !== PACO_SITE_CODE) {
    throw new Error(`Unsupported source: ${args.source}`);
  }

  if (args.step === "init-db") {
    await initDb();
    process.stdout.write(
      `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv) }, null, 2)}\n`
    );
    return;
  }

  if (args.step === "seed-paco") {
    const result = await seedPacoMasters();
    process.stdout.write(
      `${JSON.stringify({ ok: true, step: args.step, env_file_loaded: Boolean(loadedEnv), result }, null, 2)}\n`
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
