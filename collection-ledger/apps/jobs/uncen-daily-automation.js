"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE = process.env.UNCEN_ENV_FILE || "C:\\Users\\toyoaki\\Desktop\\filedatachange\\.env";
const P_ROOT = process.env.UNCEN_P_ROOT || "R:\\uncen";
const LOG_DIR = process.env.UNCEN_AUTOMATION_LOG_DIR || path.join(ROOT, "storage", "logs", "uncen-daily");
const LOCK_DIR = process.env.UNCEN_AUTOMATION_LOCK_DIR || path.join(ROOT, "storage", "locks");
const TIMEOUT_MS = Number(process.env.UNCEN_STEP_TIMEOUT_MS || 3 * 60 * 60 * 1000);
const LOCK_WAIT_MS = Number(process.env.UNCEN_LOCK_WAIT_MS || 12 * 60 * 60 * 1000);
const EXECUTE = process.env.UNCEN_AUTOMATION_EXECUTE === "YES";
const SCHEDULE_HOUR = Number(process.env.UNCEN_SCHEDULE_HOUR ?? -1);
const SCHEDULE_MINUTE = Number(process.env.UNCEN_SCHEDULE_MINUTE || 0);
const SCHEDULE_WINDOW_MINUTES = Number(process.env.UNCEN_SCHEDULE_WINDOW_MINUTES || 10);
const SIX_SITE_TORRENT_ENV = {
  TORRENT_BASE_DIR: path.join(P_ROOT, "torrent_automation"),
  TORRENT_INBOX_DIR: path.join(P_ROOT, "torrent_automation", "inbox"),
  TORRENT_ADDED_DIR: path.join(P_ROOT, "torrent_automation", "added"),
  TORRENT_ERROR_DIR: path.join(P_ROOT, "torrent_automation", "error"),
  TORRENT_LOG_DIR: path.join(P_ROOT, "torrent_automation", "logs"),
  TORRENT_DOWNLOAD_DIR: path.join(P_ROOT, "torrent_automation", "downloads"),
};

const stage = process.argv.find((value) => /^stage[0-4]$/.test(value));
const forceDryRun = process.argv.includes("--dry-run");
const listOnly = process.argv.includes("--list");

const sources = [
  { key: "10musume", pipeline: "tenmusume-pipeline.js", pages: "1" },
  { key: "1pondo", pipeline: "1pondo-pipeline.js", pages: "3" },
  { key: "heyzo", pipeline: "heyzo-pipeline.js", pages: "3" },
  { key: "h0930", pipeline: "h0930-pipeline.js", pages: "3", init: true, thumbLimit: "120" },
  { key: "carib", pipeline: "carib-pipeline.js", pages: "3", init: true, thumbLimit: "120" },
  { key: "tokyo_hot", pipeline: "tokyo-hot-pipeline.js", pages: "3", init: true, thumbLimit: "120" },
];

const manualThumbnails = [
  ["10musume", "import-tenmusume-manual-thumbnails.js", "10musume_manual_thumbnail_review_"],
  ["1pondo", "import-onepondo-manual-thumbnails.js", "1pondo_manual_thumbnail_review_"],
  ["heyzo", "import-heyzo-manual-thumbnails.js", "heyzo_manual_thumbnail_review_"],
  ["h0930", "import-h0930-manual-thumbnails.js", "h0930_manual_thumbnail_review_"],
  ["carib", "import-carib-manual-thumbnails.js", "carib_manual_thumbnail_review_"],
  ["tokyo_hot", "import-tokyo-hot-manual-thumbnails.js", "tokyo_hot_manual_thumbnail_review_"],
];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function nodeStep(name, script, args, options = {}) {
  return { name, command: process.execPath, args: [path.join(ROOT, "apps", "jobs", script), ...args, "--env-file", ENV_FILE], ...options };
}

function buildStage1() {
  const steps = [];
  for (const source of sources) {
    if (source.init) steps.push(nodeStep(`${source.key}:init-db`, source.pipeline, ["--step", "init-db"]));
    steps.push(nodeStep(`${source.key}:master-preflight`, source.pipeline, ["--step", "master", "--dry-run", "--max-pages", "1", "--limit", "25"]));
    steps.push(nodeStep(`${source.key}:master`, source.pipeline, ["--step", "master", "--max-pages", source.pages]));
    steps.push(nodeStep(`${source.key}:common-master`, source.pipeline, ["--step", "common-master"]));
    const thumbArgs = ["--step", "thumbnails"];
    if (source.thumbLimit) thumbArgs.push("--limit", source.thumbLimit);
    steps.push(nodeStep(`${source.key}:thumbnails`, source.pipeline, thumbArgs));
  }
  steps.push(nodeStep("paco:master", "paco-manual-dry-run.js", ["--source", "paco", "--step", "master-apply"]));
  steps.push(nodeStep("paco:common-master", "common-master-pipeline.js", ["--source", "paco", "--step", "seed-paco"]));
  steps.push(nodeStep("paco:thumbnails", "collect-paco-thumbnails.js", ["--source", "paco", "--step", "collect"]));
  return steps;
}

function buildStage2() {
  const steps = manualThumbnails.map(([key, script, prefix]) => {
    const inputDir = path.join(P_ROOT, `${key}_thumbnails`);
    return { name: `${key}:manual-thumbnails`, workflow: "review-apply", script, inputDir, prefix };
  });
  steps.push(nodeStep("heydouga_4017:manual-thumbnails", "import-heydouga-4017-manual-thumbnails.js", ["--step", "apply", "--input-dir", path.join(P_ROOT, "heydouga_4017_thumbnails")], { skipWhenNoInput: path.join(P_ROOT, "heydouga_4017_thumbnails") }));
  steps.push(nodeStep("six-sites:torrent-search", "uncen-sukebei-acquisition.js", [], { env: { ...SIX_SITE_TORRENT_ENV, UNCEN_TORRENT_EXECUTE: "YES" } }));
  steps.push({ name: "six-sites:qbit-import", command: process.execPath, args: ["C:\\Users\\toyoaki\\Desktop\\filedatachange\\torrent_import.js"], env: { ...SIX_SITE_TORRENT_ENV, DRY_RUN: "false", CONFIRM_EXECUTE: "YES" } });
  return steps;
}

function buildStage0() {
  return [nodeStep("completed-video:pre-cleanup-stage", "uncen-completed-video-stager.js", [], { env: { ...SIX_SITE_TORRENT_ENV, UNCEN_VIDEO_STAGE_EXECUTE: "YES" } })];
}

function buildStage3() {
  return [
    nodeStep("completed-video:stage", "uncen-completed-video-stager.js", [], { env: { ...SIX_SITE_TORRENT_ENV, UNCEN_VIDEO_STAGE_EXECUTE: "YES" } }),
    ...buildOwnedReviewSteps(),
    nodeStep("paco:owned", "paco-manual-dry-run.js", ["--source", "paco", "--step", "owned-apply", "--new-mp4-dir", path.join(P_ROOT, "paco_new_mp4"), "--owned-dir", path.join(P_ROOT, "paco"), "--trash-dir", path.join(P_ROOT, "paco_trash")]),
    nodeStep("heydouga_4017:owned", "heydouga-4017-new-mp4-import.js", ["--step", "apply", "--input-dir", path.join(P_ROOT, "heydouga_4017_new_mp4")], { skipWhenNoInput: path.join(P_ROOT, "heydouga_4017_new_mp4") }),
  ];
}

function buildStage4() {
  const keys = ["paco", "heydouga_4017", ...sources.map((source) => source.key)];
  const steps = [nodeStep("completed-video:stage", "uncen-completed-video-stager.js", [], { env: { ...SIX_SITE_TORRENT_ENV, UNCEN_VIDEO_STAGE_EXECUTE: "YES" } })];
  steps.push(...buildOwnedReviewSteps());
  steps.push(nodeStep("paco:owned", "paco-manual-dry-run.js", ["--source", "paco", "--step", "owned-apply", "--new-mp4-dir", path.join(P_ROOT, "paco_new_mp4"), "--owned-dir", path.join(P_ROOT, "paco"), "--trash-dir", path.join(P_ROOT, "paco_trash")]));
  steps.push(...keys.map((key) => nodeStep(`${key}:video-metadata`, "collect-video-metadata.js", ["--source", key, "--step", "collect"])));
  const cmd = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  steps.push({ name: "reload:api", command: cmd, args: ["/d", "/s", "/c", "pm2.cmd", "restart", "always-collection-ledger-api"] });
  steps.push({ name: "reload:web", command: cmd, args: ["/d", "/s", "/c", "pm2.cmd", "restart", "always-collection-ledger-web"] });
  return steps;
}

function buildOwnedReviewSteps() {
  return [
    ["10musume", "tenmusume-owned-operations.js", "10musume_owned-review_", "10musume_owned-ready-plan_"],
    ["1pondo", "1pondo-owned-operations.js", "1pondo_owned-review_", "1pondo_owned-ready-plan_"],
    ["carib", "carib-owned-operations.js", "carib_owned-review_", "carib_owned-ready-plan_"],
    ["heyzo", "heyzo-owned-operations.js", "heyzo_owned-review_", "heyzo_owned-ready-plan_"],
    ["h0930", "h0930-owned-operations.js", "h0930_owned-review_", "h0930_owned-ready-plan_"],
    ["tokyo_hot", "tokyo-hot-owned-operations.js", "tokyo_hot_owned_review_", "tokyo_hot_owned_ready-plan_", "review", "ready-plan", "apply"],
  ].map(([key, script, reviewPrefix, readyPrefix, reviewStep, readyStep, applyStep]) => ({
    name: `${key}:owned`, workflow: "owned-review-apply", script,
    inputDir: path.join(P_ROOT, `${key}_new_mp4`), reviewPrefix, readyPrefix, reviewStep, readyStep, applyStep,
  }));
}

function hasInputFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && !/\.(bat|cmd|csv|log)$/i.test(entry.name));
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}

function csvSnapshot(dir, prefix) {
  const snapshot = new Map();
  if (!fs.existsSync(dir)) return snapshot;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".csv")) continue;
    const stat = fs.statSync(path.join(dir, entry.name));
    snapshot.set(entry.name, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    });
  }
  return snapshot;
}

function generatedCsv(dir, prefix, before, startedAt, finishedAt) {
  const after = csvSnapshot(dir, prefix);
  const candidates = [];
  for (const [name, stat] of after) {
    const old = before.get(name);
    const changed = !old || old.size !== stat.size || old.mtimeMs !== stat.mtimeMs || old.ctimeMs !== stat.ctimeMs;
    const withinRun = stat.mtimeMs >= startedAt - 5000 && stat.mtimeMs <= finishedAt + 5000;
    if (changed && withinRun) candidates.push(path.resolve(dir, name));
  }
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one new ${prefix}*.csv in ${dir}, found ${candidates.length}`);
  }
  return candidates[0];
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, stage, startedAt: new Date().toISOString() }));
      return fd;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (!Number.isInteger(owner.pid) || !processExists(owner.pid)) {
          fs.unlinkSync(lockPath);
          continue;
        }
        writeLine(`waiting for ${owner.stage || "another stage"} pid=${owner.pid}`);
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
        throw new Error(`cannot validate existing lock ${lockPath}: ${readError.message}`);
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for daily automation lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }
}

async function runChild(step, log) {
  const started = new Date();
  log(`START ${step.name} command=${step.command} args=${JSON.stringify(step.args)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, { cwd: ROOT, windowsHide: true, shell: false, env: { ...process.env, ...(step.env || {}) } });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${step.name} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (data) => log(`[${step.name}:stdout] ${String(data).trimEnd()}`));
    child.stderr.on("data", (data) => log(`[${step.name}:stderr] ${String(data).trimEnd()}`));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      log(`END ${step.name} code=${code} signal=${signal || ""} elapsed_ms=${Date.now() - started.getTime()} result=${code === 0 ? "SUCCESS" : "FAILED"}`);
      if (code === 0) resolve(); else reject(new Error(`${step.name} failed with exit code ${code}`));
    });
  });
}

async function runWorkflow(step, log) {
  if (!hasInputFiles(step.inputDir)) { log(`SKIP ${step.name}: no input files in ${step.inputDir}`); return; }
  const before = csvSnapshot(step.inputDir, step.prefix);
  const startedAt = Date.now();
  await runChild(nodeStep(`${step.name}:review`, step.script, ["--step", "review", "--input-dir", step.inputDir]), log);
  const plan = generatedCsv(step.inputDir, step.prefix, before, startedAt, Date.now());
  log(`SELECT ${step.name}: exact review CSV ${plan}`);
  await runChild(nodeStep(`${step.name}:apply`, step.script, ["--step", "apply", "--input-dir", step.inputDir, "--plan-csv", plan]), log);
}

async function runOwnedWorkflow(step, log) {
  if (!hasInputFiles(step.inputDir)) { log(`SKIP ${step.name}: no input files in ${step.inputDir}`); return; }
  const reviewBefore = csvSnapshot(step.inputDir, step.reviewPrefix);
  const reviewStartedAt = Date.now();
  await runChild(nodeStep(`${step.name}:review`, step.script, ["--step", step.reviewStep || "owned-review", "--input-dir", step.inputDir]), log);
  const review = generatedCsv(step.inputDir, step.reviewPrefix, reviewBefore, reviewStartedAt, Date.now());
  log(`SELECT ${step.name}: exact owned review CSV ${review}`);
  const reviewText = fs.readFileSync(review, "utf8");
  if (!/(?:^|\r?\n)ready,/i.test(reviewText)) {
    log(`SKIP ${step.name}: no ready owned rows`);
    return;
  }
  const readyBefore = csvSnapshot(step.inputDir, step.readyPrefix);
  const readyStartedAt = Date.now();
  await runChild(nodeStep(`${step.name}:ready-plan`, step.script, ["--step", step.readyStep || "owned-ready-plan", "--input-dir", step.inputDir, "--plan-csv", review]), log);
  const ready = generatedCsv(step.inputDir, step.readyPrefix, readyBefore, readyStartedAt, Date.now());
  log(`SELECT ${step.name}: exact owned ready-plan CSV ${ready}`);
  await runChild(nodeStep(`${step.name}:apply`, step.script, ["--step", step.applyStep || "owned-apply", "--input-dir", step.inputDir, "--plan-csv", ready]), log);
}

async function main() {
  if (!stage) throw new Error("usage: node uncen-daily-automation.js stage0|stage1|stage2|stage3|stage4 [--dry-run|--list]");
  const builders = { stage0: buildStage0, stage1: buildStage1, stage2: buildStage2, stage3: buildStage3, stage4: buildStage4 };
  const steps = builders[stage]();
  if (listOnly || forceDryRun || !EXECUTE) {
    writeLine(JSON.stringify({ stage, execute: false, reason: listOnly ? "list" : forceDryRun ? "dry-run" : "UNCEN_AUTOMATION_EXECUTE is not YES", steps }, null, 2));
    return;
  }
  if (SCHEDULE_HOUR >= 0 && process.env.UNCEN_RUN_NOW !== "YES") {
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    const scheduled = SCHEDULE_HOUR * 60 + SCHEDULE_MINUTE;
    if (current < scheduled || current >= scheduled + SCHEDULE_WINDOW_MINUTES) {
      writeLine(`skip outside schedule window: stage=${stage} now=${now.toLocaleString()} target=${String(SCHEDULE_HOUR).padStart(2, "0")}:${String(SCHEDULE_MINUTE).padStart(2, "0")}`);
      return;
    }
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = path.join(LOCK_DIR, "uncen-daily-automation.lock");
  const lock = await acquireLock(lockPath);
  const logPath = path.join(LOG_DIR, `${stage}_${stamp()}.log`);
  const log = (message) => { const line = `${new Date().toISOString()} ${message}`; writeLine(line); fs.appendFileSync(logPath, `${line}\n`); };
  try {
    log(`RUN stage=${stage} pid=${process.pid}`);
    for (const step of steps) {
      if (step.skipWhenNoInput && !hasInputFiles(step.skipWhenNoInput)) { log(`SKIP ${step.name}: no input files`); continue; }
      if (step.workflow === "review-apply") await runWorkflow(step, log);
      else if (step.workflow === "owned-review-apply") await runOwnedWorkflow(step, log);
      else await runChild(step, log);
    }
    log(`COMPLETE stage=${stage}`);
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(`${new Date().toISOString()} FATAL ${error.stack || error.message}`); process.exitCode = 1; });
}

module.exports = { csvSnapshot, generatedCsv };
