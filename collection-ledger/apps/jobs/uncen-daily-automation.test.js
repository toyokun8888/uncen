"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { csvSnapshot, generatedCsv } = require("./uncen-daily-automation");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uncen-daily-"));
  t.after(() => {
    const tempRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(dir);
    assert.notEqual(resolved, tempRoot);
    assert.equal(resolved.startsWith(`${tempRoot}${path.sep}`), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("generatedCsv selects only the CSV created by the current child run", (t) => {
  const dir = tempDir(t);
  const old = path.join(dir, "site_review_old.csv");
  fs.writeFileSync(old, "old");
  const future = Date.now() + 60 * 60 * 1000;
  fs.utimesSync(old, future / 1000, future / 1000);
  const before = csvSnapshot(dir, "site_review_");
  const startedAt = Date.now();
  const created = path.join(dir, "site_review_new.csv");
  fs.writeFileSync(created, "new");

  assert.equal(generatedCsv(dir, "site_review_", before, startedAt, Date.now()), created);
});

test("generatedCsv stops when a child run produces multiple candidate CSV files", (t) => {
  const dir = tempDir(t);
  const before = csvSnapshot(dir, "site_review_");
  const startedAt = Date.now();
  fs.writeFileSync(path.join(dir, "site_review_a.csv"), "a");
  fs.writeFileSync(path.join(dir, "site_review_b.csv"), "b");

  assert.throws(
    () => generatedCsv(dir, "site_review_", before, startedAt, Date.now()),
    /expected exactly one new/,
  );
});
