"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  isWithinRoot,
  stageVerified,
  targetPlan,
  verifyExistingPair,
} = require("./uncen-completed-video-stager");

function tempTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uncen-stager-"));
  t.after(() => {
    const tempRoot = path.resolve(os.tmpdir());
    assert.notEqual(path.resolve(root), tempRoot);
    assert.equal(isWithinRoot(tempRoot, root), true);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const downloadRoot = path.join(root, "downloads");
  const pRoot = path.join(root, "storage");
  const reviewRoot = path.join(pRoot, "duplicate_review");
  fs.mkdirSync(downloadRoot, { recursive: true });
  fs.mkdirSync(pRoot, { recursive: true });
  return { downloadRoot, pRoot, reviewRoot };
}

test("same-name files are duplicates only after SHA-256 matches", (t) => {
  const { downloadRoot, pRoot, reviewRoot } = tempTree(t);
  const site = { key: "test", dir: "test_new_mp4" };
  const source = path.join(downloadRoot, "movie.mp4");
  const target = path.join(pRoot, site.dir, "movie.mp4");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(source, "same-content");
  fs.writeFileSync(target, "same-content");

  const plan = targetPlan(site, source, "torrent-a", { pRoot, reviewRoot });

  assert.equal(plan.disposition, "same_sha256");
  assert.equal(plan.sourceHash, plan.targetHash);
  assert.equal(fs.existsSync(source), true);
});

test("same-size different content is copied to collision-safe review storage", (t) => {
  const { downloadRoot, pRoot, reviewRoot } = tempTree(t);
  const site = { key: "test", dir: "test_new_mp4" };
  const source = path.join(downloadRoot, "movie.mp4");
  const target = path.join(pRoot, site.dir, "movie.mp4");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(source, "AAAA");
  fs.writeFileSync(target, "BBBB");

  const plan = targetPlan(site, source, "torrent-b", { pRoot, reviewRoot });
  assert.equal(plan.disposition, "review_copy_required");
  assert.equal(plan.reason, "same_name_same_size_different_content");
  assert.equal(isWithinRoot(reviewRoot, plan.target), true);

  fs.mkdirSync(path.dirname(plan.target), { recursive: true });
  const result = stageVerified(source, plan.target, plan.sourceHash);
  assert.equal(result.sha256, plan.sourceHash);
  assert.equal(fs.readFileSync(plan.target, "utf8"), "AAAA");
  assert.equal(fs.readFileSync(target, "utf8"), "BBBB");
  assert.equal(fs.existsSync(source), true);

  const retry = targetPlan(site, source, "torrent-b", { pRoot, reviewRoot });
  assert.equal(retry.disposition, "review_copy_verified");
  assert.equal(verifyExistingPair(retry), plan.sourceHash);
});

test("staging never overwrites an existing target", (t) => {
  const { downloadRoot, pRoot } = tempTree(t);
  const source = path.join(downloadRoot, "movie.mp4");
  const target = path.join(pRoot, "target.mp4");
  fs.writeFileSync(source, "source");
  fs.writeFileSync(target, "existing");

  assert.throws(() => stageVerified(source, target), (error) => error && error.code === "EEXIST");
  assert.equal(fs.readFileSync(target, "utf8"), "existing");
  assert.equal(fs.readFileSync(source, "utf8"), "source");
});
