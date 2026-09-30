"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { filenameActor, folderActor, titleActor, performerForOwnedFile } = require("./gachinco-performers");

test("file actor takes priority over a different catalog actor", () => {
  const result = performerForOwnedFile({
    file_name: "2 実録ガチ面接270 奈緒 続編192924_1080p.mp4",
    original_file_path: "F:\\ガチん娘\\雛子\\2 実録ガチ面接270 奈緒 続編192924_1080p.mp4",
    title: "実録ガチ面接269、270 - 奈緒、雛子",
  });
  assert.deepEqual(result, { actorNames: "奈緒", source: "file_name" });
});

test("joint names remain joint names", () => {
  assert.equal(filenameActor("2 かんな／もも.wmv"), "かんな、もも");
  assert.equal(folderActor("H:\\保存\\945 バイセクシャル特別篇 まや＆ゆうひ\\1 トーク／レズ.mp4"), "まや、ゆうひ");
  assert.equal(titleActor("由加里、みぃ - ガチンコ特集"), "由加里、みぃ");
});

test("actor before a group count wins over a catalog representative", () => {
  const result = performerForOwnedFile({
    file_name: "1 若菜 他10名11発.wmv",
    original_file_path: "F:\\ガチん娘\\オシッコ大図鑑\\1 若菜 他10名11発.wmv",
    title: "栞 他 - オシッコ大図鑑 Part11",
  });
  assert.deepEqual(result, { actorNames: "若菜 他", source: "file_name" });
});

test("folder actor fills a generic part file", () => {
  assert.deepEqual(performerForOwnedFile({
    file_name: "1 トーク／レズ.mp4",
    original_file_path: "H:\\保存\\945 バイセクシャル特別篇 まや＆ゆうひ\\1 トーク／レズ.mp4",
    title: "バイセクシャル 特別篇",
  }), { actorNames: "まや、ゆうひ", source: "original_folder" });
});

test("catalog actor fills a generic file and parent folder", () => {
  assert.deepEqual(performerForOwnedFile({
    file_name: "1 実録ガチ面接236.wmv",
    original_file_path: "G:\\uncen\\gachinco\\unmatched\\1 実録ガチ面接236.wmv",
    title: "【ガチん娘！NK】実録ガチ面接236、237 - 詩",
  }), { actorNames: "詩", source: "catalog_title" });
});

test("generic chapter labels are not actors", () => {
  assert.equal(filenameActor("3 メイキング映像.wmv"), "");
  assert.equal(filenameActor("3 M女志願23.wmv"), "");
  assert.equal(filenameActor("1 実録ガチ面接245.wmv"), "");
});

test("bracketed chapter and sequel suffix are removed", () => {
  assert.equal(filenameActor("1 菜々緒 【完全版】.wmv"), "菜々緒");
  assert.equal(filenameActor("15 のん バージョン２.wmv"), "のん");
  assert.equal(filenameActor("1 実録ガチ面接250 小道（続編）.wmv"), "小道");
});
