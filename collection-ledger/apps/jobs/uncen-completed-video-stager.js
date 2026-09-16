"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ENV_FILE = process.env.UNCEN_ENV_FILE || "C:\\Users\\toyoaki\\Desktop\\filedatachange\\.env";
loadEnv(ENV_FILE);
const P_ROOT = process.env.UNCEN_P_ROOT || "R:\\uncen";
const DOWNLOAD_ROOT = process.env.TORRENT_DOWNLOAD_DIR || "";
const DUPLICATE_REVIEW_DIR = process.env.UNCEN_DUPLICATE_REVIEW_DIR || path.join(P_ROOT, "duplicate_review");
const AUDIT_LOG_DIR = process.env.UNCEN_VIDEO_STAGE_LOG_DIR || process.env.TORRENT_LOG_DIR || path.join(P_ROOT, "torrent_automation", "logs", "video-stage");
const EXECUTE = process.env.UNCEN_VIDEO_STAGE_EXECUTE === "YES";
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".wmv", ".avi", ".mov", ".m4v"]);
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}_${process.pid}`;
let auditLogPath;
const sites = [
  { key: "10musume", dir: "10musume_new_mp4", re: /(?:10mu|天然むすめ).*?\d{6}(?:_\d{2})?|\d{6}(?:_\d{2})?.*?(?:10mu|天然むすめ)/i },
  { key: "1pondo", dir: "1pondo_new_mp4", re: /1pon.*?\d{6}(?:_[0-9a-z]{3})?|\d{6}(?:_[0-9a-z]{3})?.*?1pon/i },
  { key: "carib", dir: "carib_new_mp4", re: /(\d{6}[-_][0-9a-z]{3}).*?carib|carib.*?(\d{6}[-_][0-9a-z]{3})/i },
  { key: "paco", dir: "paco_new_mp4", re: /(\d{6}[-_][0-9a-z]+).*?paco|paco.*?(\d{6}[-_][0-9a-z]+)/i },
  { key: "heyzo", dir: "heyzo_new_mp4", re: /heyzo[-_ ]?(\d{1,6})/i },
  { key: "h0930", dir: "h0930_new_mp4", re: /h0930.*?((?:orijuku|orimrs|ori|gol|ki|pla|tk)\d+)|((?:orijuku|orimrs|ori|gol|ki|pla|tk)\d+).*?h0930/i },
  { key: "tokyo_hot", dir: "tokyo_hot_new_mp4", re: /tokyo[-_ ]?hot.*?((?:n|k|e|pp|sky)[-_]?\d{3,5})|((?:n|k|e|pp|sky)[-_]?\d{3,5}).*?tokyo[-_ ]?hot/i },
];

async function qbSession() {
  const base = String(process.env.QB_URL || "http://localhost:8080").replace(/\/+$/, "");
  const url = new URL(base);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("QB_URL must be local");
  const body = new URLSearchParams({ username: process.env.QB_USERNAME || "", password: process.env.QB_PASSWORD || "" });
  const response = await fetch(`${base}/api/v2/auth/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`qB login failed: ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("qB login cookie missing");
  return { base, cookie };
}

async function completedTorrents(session) {
  if (!DOWNLOAD_ROOT) throw new Error("TORRENT_DOWNLOAD_DIR is required");
  const response = await fetch(`${session.base}/api/v2/torrents/info`, { headers: { cookie: session.cookie } });
  if (!response.ok) throw new Error(`qB list failed: ${response.status}`);
  const downloadRoot = path.win32.resolve(DOWNLOAD_ROOT).toLowerCase();
  const states = new Set(["uploading", "stalledUP", "queuedUP", "pausedUP", "forcedUP", "checkingUP"]);
  return (await response.json()).filter((torrent) => Number(torrent.progress) >= 1 && states.has(torrent.state) && path.win32.resolve(torrent.save_path || "").toLowerCase() === downloadRoot);
}

function filesUnder(contentPath) {
  if (!fs.existsSync(contentPath)) return [];
  const stat = fs.statSync(contentPath);
  if (stat.isFile()) return [contentPath];
  const result = [];
  const stack = [contentPath];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full); else if (entry.isFile()) result.push(full);
    }
  }
  return result;
}

function identify(file) {
  const text = file.replace(/[\\/]+/g, " ");
  return sites.find((site) => site.re.test(text));
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertWithinRoot(root, candidate, label) {
  if (!root || !isWithinRoot(root, candidate)) throw new Error(`${label} is outside configured root: ${candidate}`);
}

function assertExistingWithinRoot(root, candidate, label) {
  const rootReal = fs.realpathSync(root);
  const candidateReal = fs.realpathSync(candidate);
  assertWithinRoot(rootReal, candidateReal, label);
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function audit(event) {
  const record = { at: new Date().toISOString(), runId: RUN_ID, ...event };
  const line = JSON.stringify(record);
  if (!auditLogPath) {
    fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
    auditLogPath = path.join(AUDIT_LOG_DIR, `${RUN_ID}.jsonl`);
  }
  fs.appendFileSync(auditLogPath, `${line}\n`, "utf8");
  process.stdout.write(`${line}\n`);
}

function auditBestEffort(event) {
  try {
    audit(event);
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} AUDIT_BEST_EFFORT_FAILED event=${event.event || "unknown"} message=${error.message}\n`);
  }
}

function safeComponent(value) {
  return String(value || "unknown").replace(/[^0-9a-z_-]/gi, "_").slice(0, 100) || "unknown";
}

function duplicateReviewTarget(source, sourceHash, site, torrentHash, reviewRoot = DUPLICATE_REVIEW_DIR) {
  const dir = path.join(reviewRoot, safeComponent(site.key), safeComponent(torrentHash));
  const ext = path.extname(source);
  const base = path.basename(source, ext);
  const stem = `${base}__${sourceHash.slice(0, 12)}`;
  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const candidate = path.join(dir, `${stem}${suffix ? `_${suffix}` : ""}${ext}`);
    assertWithinRoot(reviewRoot, candidate, "duplicate review target");
    if (!fs.existsSync(candidate)) return { target: candidate, alreadyVerified: false };
    const stat = fs.statSync(candidate);
    if (stat.isFile() && stat.size === fs.statSync(source).size && sha256File(candidate) === sourceHash) {
      return { target: candidate, alreadyVerified: true };
    }
  }
  throw new Error(`could not allocate collision-safe duplicate review target for ${source}`);
}

function targetPlan(site, source, torrentHash, options = {}) {
  const pRoot = options.pRoot || P_ROOT;
  const reviewRoot = options.reviewRoot || DUPLICATE_REVIEW_DIR;
  const target = path.join(pRoot, site.dir, path.basename(source));
  assertWithinRoot(pRoot, target, "stage target");
  if (!fs.existsSync(target)) return { disposition: "stage", source, target };

  const sourceStat = fs.statSync(source);
  const targetStat = fs.statSync(target);
  const sourceHash = sha256File(source);
  const targetHash = sourceStat.size === targetStat.size ? sha256File(target) : null;
  const sourceAfter = fs.statSync(source);
  const targetAfter = fs.statSync(target);
  if (sourceAfter.size !== sourceStat.size || sourceAfter.mtimeMs !== sourceStat.mtimeMs) {
    throw new Error(`source changed during duplicate inspection: ${source}`);
  }
  if (targetAfter.size !== targetStat.size || targetAfter.mtimeMs !== targetStat.mtimeMs) {
    throw new Error(`existing target changed during duplicate inspection: ${target}`);
  }
  if (targetHash === sourceHash) {
    return {
      disposition: "same_sha256",
      source,
      existingTarget: target,
      sourceHash,
      targetHash,
      reason: "same_name_same_content",
    };
  }

  const review = duplicateReviewTarget(source, sourceHash, site, torrentHash, reviewRoot);
  return {
    disposition: review.alreadyVerified ? "review_copy_verified" : "review_copy_required",
    source,
    target: review.target,
    existingTarget: target,
    sourceHash,
    targetHash,
    reason: sourceStat.size === targetStat.size ? "same_name_same_size_different_content" : "same_name_different_size",
  };
}

function verifyExistingPair(plan) {
  const verifiedTarget = plan.disposition === "same_sha256" ? plan.existingTarget : plan.target;
  const sourceBefore = fs.statSync(plan.source);
  const targetBefore = fs.statSync(verifiedTarget);
  const sourceHash = sha256File(plan.source);
  const targetHash = sha256File(verifiedTarget);
  const sourceAfter = fs.statSync(plan.source);
  const targetAfter = fs.statSync(verifiedTarget);
  if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) {
    throw new Error(`source changed during final verification: ${plan.source}`);
  }
  if (targetBefore.size !== targetAfter.size || targetBefore.mtimeMs !== targetAfter.mtimeMs) {
    throw new Error(`target changed during final verification: ${verifiedTarget}`);
  }
  if (sourceHash !== targetHash) throw new Error(`existing pair SHA-256 mismatch: ${plan.source}`);
  return sourceHash;
}

async function removeUiRegistration(session, hash) {
  const body = new URLSearchParams({ hashes: hash, deleteFiles: "false" });
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${session.base}/api/v2/torrents/delete`, { method: "POST", headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" }, body });
      if (response.ok) return;
      lastError = new Error(`qB delete registration failed: ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw lastError;
}

function stageVerified(source, target, expectedSourceHash = null) {
  const before = fs.statSync(source);
  if (!before.isFile()) throw new Error(`source is not a file: ${source}`);
  let method;
  try {
    fs.linkSync(source, target);
    method = "hard_link";
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    method = "verified_copy";
  }

  try {
    const targetStat = fs.statSync(target);
    if (!targetStat.isFile() || targetStat.size !== before.size) {
      throw new Error(`stage size verification failed: ${source}`);
    }
    const sourceHash = sha256File(source);
    const targetHash = sha256File(target);
    const after = fs.statSync(source);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`source changed during staging: ${source}`);
    }
    if (sourceHash !== targetHash) throw new Error(`stage SHA-256 verification failed: ${source}`);
    if (expectedSourceHash && sourceHash !== expectedSourceHash) {
      throw new Error(`source changed after duplicate review planning: ${source}`);
    }
    return { method, sha256: sourceHash };
  } catch (error) {
    // target was created by this function and is removed only when its verification fails.
    try { fs.unlinkSync(target); } catch (cleanupError) {
      error.message += `; incomplete target cleanup failed: ${cleanupError.message}`;
    }
    throw error;
  }
}

function validateConfiguration() {
  if (!path.isAbsolute(P_ROOT)) throw new Error(`UNCEN_P_ROOT must be an absolute path: ${P_ROOT}`);
  if (!DOWNLOAD_ROOT || !path.isAbsolute(DOWNLOAD_ROOT)) {
    throw new Error("TORRENT_DOWNLOAD_DIR must be an absolute path");
  }
  if (!fs.existsSync(P_ROOT)) throw new Error(`UNCEN_P_ROOT is not accessible: ${P_ROOT}`);
  if (!fs.existsSync(DOWNLOAD_ROOT)) throw new Error(`TORRENT_DOWNLOAD_DIR is not accessible: ${DOWNLOAD_ROOT}`);
  if (!path.isAbsolute(DUPLICATE_REVIEW_DIR)) {
    throw new Error(`UNCEN_DUPLICATE_REVIEW_DIR must be an absolute path: ${DUPLICATE_REVIEW_DIR}`);
  }
  assertWithinRoot(P_ROOT, DUPLICATE_REVIEW_DIR, "duplicate review root");
}

function auditPlan(torrent, plan, event, extra = {}) {
  audit({
    event,
    execute: EXECUTE,
    torrentHash: torrent.hash,
    torrentName: torrent.name,
    site: plan.site.key,
    source: plan.source,
    target: plan.target || null,
    existingTarget: plan.existingTarget || null,
    disposition: plan.disposition,
    reason: plan.reason || null,
    sourceSha256: plan.sourceHash || extra.sha256 || null,
    existingTargetSha256: plan.targetHash || null,
    ...extra,
  });
}

async function main() {
  validateConfiguration();
  audit({
    event: "RUN_STARTED",
    execute: EXECUTE,
    pRoot: P_ROOT,
    downloadRoot: DOWNLOAD_ROOT,
    duplicateReviewRoot: DUPLICATE_REVIEW_DIR,
  });
  const session = await qbSession();
  const torrents = await completedTorrents(session);
  const summary = {
    completedTorrents: torrents.length,
    staged: 0,
    duplicateExact: 0,
    duplicateReview: 0,
    duplicateReviewAlreadyVerified: 0,
    unmatched: 0,
    nonVideo: 0,
    sourceRetained: 0,
    qBRegistrationsRemoved: 0,
    qBRemovalUnconfirmed: 0,
    failed: 0,
  };

  for (const torrent of torrents) {
    let qBRemovalAttempted = false;
    let qBRegistrationRemoved = false;
    try {
      const files = filesUnder(torrent.content_path || path.join(torrent.save_path, torrent.name));
      const plans = [];
      const unmatchedVideos = [];
      const videoSources = [];
      for (const source of files) {
        if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) { summary.nonVideo += 1; continue; }
        assertExistingWithinRoot(DOWNLOAD_ROOT, source, "torrent source");
        videoSources.push(source);
        const site = identify(source);
        if (!site) {
          summary.unmatched += 1;
          unmatchedVideos.push(source);
          audit({ event: "UNMATCHED", execute: EXECUTE, torrentHash: torrent.hash, torrentName: torrent.name, source });
          continue;
        }
        plans.push({ site, ...targetPlan(site, source, torrent.hash) });
      }

      if (unmatchedVideos.length) {
        audit({
          event: "TORRENT_RETAINED_UNMATCHED",
          execute: EXECUTE,
          torrentHash: torrent.hash,
          torrentName: torrent.name,
          unmatchedCount: unmatchedVideos.length,
        });
        continue;
      }
      if (!videoSources.length) continue;

      if (!EXECUTE) {
        for (const plan of plans) {
          const event = plan.disposition === "stage" ? "WOULD_STAGE"
            : plan.disposition === "same_sha256" ? "SAME_SHA256"
              : plan.disposition === "review_copy_verified" ? "REVIEW_COPY_ALREADY_VERIFIED" : "WOULD_REVIEW_COPY";
          auditPlan(torrent, plan, event);
        }
        continue;
      }

      for (const plan of plans) {
        if (plan.disposition === "same_sha256") {
          const sha256 = verifyExistingPair(plan);
          summary.duplicateExact += 1;
          auditPlan(torrent, plan, "SAME_SHA256_VERIFIED", { sha256, result: "verified" });
          continue;
        }
        if (plan.disposition === "review_copy_verified") {
          const sha256 = verifyExistingPair(plan);
          summary.duplicateReviewAlreadyVerified += 1;
          auditPlan(torrent, plan, "REVIEW_COPY_ALREADY_VERIFIED", { sha256, result: "verified" });
          continue;
        }

        fs.mkdirSync(path.dirname(plan.target), { recursive: true });
        const staged = stageVerified(plan.source, plan.target, plan.sourceHash || null);
        if (plan.disposition === "review_copy_required") summary.duplicateReview += 1;
        else summary.staged += 1;
        auditPlan(torrent, plan, plan.disposition === "review_copy_required" ? "REVIEW_COPY_VERIFIED" : "STAGED_VERIFIED", {
          method: staged.method,
          sha256: staged.sha256,
          result: "verified",
        });
      }

      summary.sourceRetained += videoSources.length;
      audit({
        event: "QB_REGISTRATION_REMOVE_AUTHORIZED",
        execute: true,
        torrentHash: torrent.hash,
        torrentName: torrent.name,
        deleteFiles: false,
        verifiedVideos: plans.length,
        retainedSources: videoSources,
      });
      qBRemovalAttempted = true;
      await removeUiRegistration(session, torrent.hash);
      qBRegistrationRemoved = true;
      summary.qBRegistrationsRemoved += 1;
      auditBestEffort({
        event: "QB_REGISTRATION_REMOVED",
        execute: true,
        torrentHash: torrent.hash,
        torrentName: torrent.name,
        deleteFiles: false,
        result: "success",
      });
    } catch (error) {
      summary.failed += 1;
      if (qBRemovalAttempted && !qBRegistrationRemoved) summary.qBRemovalUnconfirmed += 1;
      auditBestEffort({
        event: qBRegistrationRemoved
          ? "TORRENT_POST_QB_LOG_FAILED_SOURCE_RETAINED"
          : qBRemovalAttempted
            ? "TORRENT_FAILED_QB_STATE_UNCONFIRMED_SOURCE_RETAINED"
            : "TORRENT_FAILED_SOURCE_AND_QB_RETAINED",
        execute: EXECUTE,
        torrentHash: torrent.hash,
        torrentName: torrent.name,
        error: error.message,
      });
    }
  }
  auditBestEffort({ event: "RUN_COMPLETE", execute: EXECUTE, summary });
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

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = {
  isWithinRoot,
  sha256File,
  stageVerified,
  targetPlan,
  verifyExistingPair,
};
