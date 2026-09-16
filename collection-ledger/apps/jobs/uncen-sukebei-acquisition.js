"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE = process.env.UNCEN_ENV_FILE || "C:\\Users\\toyoaki\\Desktop\\filedatachange\\.env";
const BASE_URL = "https://sukebei.nyaa.si";
const EXECUTE = process.env.UNCEN_TORRENT_EXECUTE === "YES";
const MAX_PAGES = Math.max(1, Math.min(10, Number(process.env.UNCEN_TORRENT_MAX_PAGES || 3)));
const MAX_PER_SITE = Math.max(1, Math.min(50, Number(process.env.UNCEN_TORRENT_MAX_PER_SITE || 10)));
const REQUEST_TIMEOUT = Number(process.env.UNCEN_TORRENT_TIMEOUT_MS || 30000);

loadEnv(ENV_FILE);

const SITES = [
  { key: "10mu", query: "10mu", view: "tenmusume_v_completion_items", code: /\b(\d{6}_\d{2})-10MU\b/i, normalize: (v) => v.toUpperCase() },
  { key: "1pon", query: "1pon", view: "onepondo_v_completion_items", code: /\b(\d{6}_[0-9A-Z]{3})-1PON\b/i, normalize: (v) => v.toUpperCase() },
  { key: "carib", query: "carib", view: "carib_v_completion_items", code: /\b(\d{6}[-_][0-9A-Z]{3})-CARIB\b/i, normalize: (v) => v.toUpperCase().replace("_", "-") },
  { key: "paco", query: "paco", view: "paco_v_completion_items", code: /\b(\d{6}[-_][0-9A-Z]+)-PACO\b/i, normalize: (v) => v.toUpperCase().replace("-", "_") },
  { key: "heyzo", query: "heyzo", view: "heyzo_v_completion_items", code: /\bHEYZO[-_ ]?(\d{1,6})\b/i, normalize: (v) => {
    const match = String(v).match(/(?:heyzo[-_ ]?)?(\d{1,6})$/i);
    return match ? `heyzo-${Number(match[1])}` : String(v).trim().toLowerCase();
  } },
  { key: "h0930", query: "h0930", view: "h0930_v_completion_items", code: /\bH0930\s+((?:orijuku|orimrs|ori|gol|ki|pla|tk)\d+)\b/i, normalize: (v) => v.toLowerCase() },
];
const SITE_FILTER = new Set(String(process.env.UNCEN_TORRENT_SITES || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean));

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}

function pgClient() {
  const ssl = String(process.env.PGSSL || "false").toLowerCase() === "true" ? { rejectUnauthorized: false } : false;
  return new Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432), database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD, ssl });
}

function normalizePath(value) { return path.win32.resolve(value).replace(/[\\/]+$/, "").toLowerCase(); }

function validatePaths() {
  const base = process.env.TORRENT_BASE_DIR;
  const inbox = process.env.TORRENT_INBOX_DIR;
  if (!base || !inbox) throw new Error("TORRENT_BASE_DIR and TORRENT_INBOX_DIR are required");
  const basePath = `${normalizePath(base)}\\`;
  if (!`${normalizePath(inbox)}\\`.startsWith(basePath)) throw new Error("TORRENT_INBOX_DIR must be inside TORRENT_BASE_DIR");
  return { base, inbox };
}

async function ensureQueue(client) {
  await client.query(`create table if not exists cl.uncen_torrent_acquisition (
    id bigserial primary key, site_key text not null, movie_code text not null,
    torrent_url text not null, torrent_page_url text, torrent_title text,
    seed_count integer not null default 0, status text not null,
    torrent_file_path text, last_error text, first_seen_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(site_key, movie_code), unique(torrent_url)
  )`);
}

async function loadUnowned(client, site) {
  const result = await client.query(`select movie_code from cl.${site.view} where not coalesce(is_owned, false)`);
  return new Set(result.rows.map((row) => site.normalize(String(row.movie_code))));
}

async function fetchPage(site, page) {
  const url = `${BASE_URL}/?f=0&c=2_2&q=${encodeURIComponent(site.query)}&s=id&o=desc&p=${page}`;
  const response = await axios.get(url, { timeout: REQUEST_TIMEOUT, headers: { "user-agent": "Mozilla/5.0", "accept-language": "ja,en;q=0.8" } });
  const $ = cheerio.load(response.data);
  const items = [];
  $("tr").each((_, tr) => {
    const row = $(tr);
    const view = row.find("a[href^='/view/']").first();
    const download = row.find("a[href^='/download/'][href$='.torrent']").first();
    if (!view.length || !download.length) return;
    const title = view.attr("title") || view.text().trim();
    const match = title.match(site.code);
    if (!match) return;
    const rawCode = site.key === "heyzo" || site.key === "h0930" ? match[1] : match[1];
    const seedText = row.find("td").eq(-3).text().trim();
    items.push({ siteKey: site.key, movieCode: site.normalize(rawCode), title, seedCount: Number(seedText) || 0,
      viewUrl: new URL(view.attr("href"), BASE_URL).toString(), torrentUrl: new URL(download.attr("href"), BASE_URL).toString() });
  });
  return { url, items };
}

function bestCandidates(items) {
  const best = new Map();
  for (const item of items) {
    const current = best.get(item.movieCode);
    if (!current || item.seedCount > current.seedCount) best.set(item.movieCode, item);
  }
  return [...best.values()].sort((a, b) => b.seedCount - a.seedCount || a.movieCode.localeCompare(b.movieCode));
}

function safeFileName(value) { return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 180); }

async function downloadTorrent(item, inbox) {
  const response = await axios.get(item.torrentUrl, { timeout: REQUEST_TIMEOUT, responseType: "arraybuffer", headers: { "user-agent": "Mozilla/5.0" } });
  const bytes = Buffer.from(response.data);
  if (bytes.length < 20 || bytes[0] !== 0x64) throw new Error(`invalid torrent response bytes=${bytes.length}`);
  const file = path.join(inbox, `${safeFileName(`${item.siteKey}_${item.movieCode}`)}_${path.basename(new URL(item.torrentUrl).pathname)}`);
  const handle = fs.openSync(file, "wx");
  try { fs.writeFileSync(handle, bytes); } finally { fs.closeSync(handle); }
  return file;
}

async function main() {
  const { inbox } = validatePaths();
  if (EXECUTE) fs.mkdirSync(inbox, { recursive: true });
  const client = pgClient();
  await client.connect();
  const summary = [];
  try {
    if (EXECUTE) await ensureQueue(client);
    for (const site of SITES.filter((item) => !SITE_FILTER.size || SITE_FILTER.has(item.key))) {
      const unowned = await loadUnowned(client, site);
      const raw = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const fetched = await fetchPage(site, page);
        raw.push(...fetched.items);
        writeLine(`SEARCH site=${site.key} page=${page} parsed=${fetched.items.length} url=${fetched.url}`);
      }
      const matched = bestCandidates(raw).filter((item) => unowned.has(item.movieCode)).slice(0, MAX_PER_SITE);
      let downloaded = 0; let duplicates = 0; let errors = 0;
      for (const item of matched) {
        if (!EXECUTE) { writeLine(`DRY_RUN_MATCH site=${site.key} code=${item.movieCode} seeds=${item.seedCount} title=${item.title}`); continue; }
        const reserved = await client.query(`insert into cl.uncen_torrent_acquisition(site_key,movie_code,torrent_url,torrent_page_url,torrent_title,seed_count,status)
          values($1,$2,$3,$4,$5,$6,'reserved')
          on conflict(site_key,movie_code) do update set torrent_url=excluded.torrent_url,torrent_page_url=excluded.torrent_page_url,
            torrent_title=excluded.torrent_title,seed_count=excluded.seed_count,status='reserved',last_error=null,updated_at=now()
          where cl.uncen_torrent_acquisition.status='error' returning id`, [site.key, item.movieCode, item.torrentUrl, item.viewUrl, item.title, item.seedCount]);
        if (!reserved.rowCount) { duplicates += 1; continue; }
        try {
          const file = await downloadTorrent(item, inbox);
          await client.query(`update cl.uncen_torrent_acquisition set status='torrent_downloaded',torrent_file_path=$2,updated_at=now() where id=$1`, [reserved.rows[0].id, file]);
          downloaded += 1;
          writeLine(`DOWNLOADED site=${site.key} code=${item.movieCode} seeds=${item.seedCount} file=${file}`);
        } catch (error) {
          errors += 1;
          await client.query(`update cl.uncen_torrent_acquisition set status='error',last_error=$2,updated_at=now() where id=$1`, [reserved.rows[0].id, error.message]);
          console.error(`ERROR site=${site.key} code=${item.movieCode} message=${error.message}`);
        }
      }
      summary.push({ site: site.key, unowned: unowned.size, candidates: raw.length, matched: matched.length, downloaded, duplicates, errors });
    }
  } finally { await client.end(); }
  writeLine(JSON.stringify({ ok: true, execute: EXECUTE, maxPages: MAX_PAGES, maxPerSite: MAX_PER_SITE, summary }, null, 2));
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
