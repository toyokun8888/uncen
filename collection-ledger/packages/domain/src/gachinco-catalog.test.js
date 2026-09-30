"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildCatalogIndex, matchOwnedFile } = require("./gachinco-catalog");

function aup(id, title) {
  return {
    source: "a_up",
    sourceRecordId: id,
    title,
    detailUrl: "https://www.a-up.info/avlady/series/" + id,
    sourcePage: "https://www.a-up.info/avlady/series/index.php?pg=1",
    pageNumber: 1,
    rowIndex: Number(id),
  };
}

function neo(id, title) {
  return {
    source: "neo",
    sourceRecordId: id,
    title,
    detailUrl: "https://neo-adultmovie-revolution.com/db/movie_db/" + id,
    sourcePage: "https://neo-adultmovie-revolution.com/db/movie_db/?page=1",
    pageNumber: 1,
    rowIndex: Number(id),
  };
}

function shiitake(id, title) {
  return {
    source: "shiitake",
    sourceRecordId: id,
    title,
    thumbnailUrl: "https://shiitake-taicho.com/itemimg/" + id + ".webp",
    detailUrl: "https://shiitake-taicho.com/detail/" + id + "/",
    sourcePage: "https://shiitake-taicho.com/maker/42/?page=1",
    pageNumber: 1,
    rowIndex: Number(id),
  };
}

test("matches the numbered Today Gachinco title behind the A-up prefix", () => {
  const index = buildCatalogIndex([
    aup("479487", "【ガチん娘！NK】完全期間限定配信 今日のガチん娘ちゃん。5 - 小道"),
  ]);

  const match = matchOwnedFile("G:\\uncen\\gachinco\\unmatched\\1 今日のガチん娘ちゃん。5　小道.wmv", index);
  assert.equal(match.status, "catalog_title");
  assert.equal(match.sourceRecordId, "479487");
});

test("uses 後編 to distinguish episode 4 from the ordinary episode 4 title", () => {
  const index = buildCatalogIndex([
    aup("471735", "【ガチん娘！NK】完全期間限定配信 実録ガチ面接248、今日のガチん娘ちゃん。4 - MINA、のの"),
    aup("472803", "【ガチん娘！NK】完全期間限定配信 実録ガチ面接249、今日のガチん娘ちゃん。4後編 - たお、のの"),
  ]);

  const ordinary = matchOwnedFile("G:\\uncen\\gachinco\\unmatched\\今日のガチん娘ちゃん。4.wmv", index);
  assert.equal(ordinary.status, "catalog_title");
  assert.equal(ordinary.sourceRecordId, "471735");

  const sequel = matchOwnedFile("G:\\uncen\\gachinco\\unmatched\\今日のガチん娘ちゃん。4 のの（後編）.mp4", index);
  assert.equal(sequel.status, "catalog_title");
  assert.equal(sequel.sourceRecordId, "472803");
});

test("keeps an episode alias ambiguous when two catalog masters share it", () => {
  const index = buildCatalogIndex([
    aup("479487", "【ガチん娘！NK】完全期間限定配信 今日のガチん娘ちゃん。5 - 小道"),
    aup("479488", "【ガチん娘！NK】完全期間限定配信 今日のガチん娘ちゃん。5 - 別人"),
  ]);

  const match = matchOwnedFile("G:\\uncen\\gachinco\\unmatched\\今日のガチん娘ちゃん。5.wmv", index);
  assert.equal(match.status, "ambiguous_catalog_title");
  assert.equal(match.candidateMatches.length, 2);
});

test("does not let episode 5 alias match episode 50", () => {
  const index = buildCatalogIndex([
    aup("479487", "【ガチん娘！NK】完全期間限定配信 今日のガチん娘ちゃん。5 - 小道"),
  ]);

  const match = matchOwnedFile("G:\\uncen\\gachinco\\unmatched\\今日のガチん娘ちゃん。50.wmv", index);
  assert.equal(match.status, "marker_only");
});

test("uses the explicit Neo part delimiter and keeps 89 distinct from 891", () => {
  const index = buildCatalogIndex([
    neo("89", "エッチな日常89"),
    neo("891", "エッチな日常891"),
  ]);

  for (const part of [1, 2, 3]) {
    const match = matchOwnedFile("H:\\all\\保存\\ガチん娘 エッチな日常 89 " + part + ".mp4", index);
    assert.equal(match.status, "catalog_title");
    assert.equal(match.sourceRecordId, "89");
  }
  const episode891 = matchOwnedFile("H:\\all\\保存\\ガチん娘 エッチな日常 891.mp4", index);
  assert.equal(episode891.status, "catalog_title");
  assert.equal(episode891.sourceRecordId, "891");
});

test("does not choose between duplicate 後編 episode aliases when a name gap is present", () => {
  const index = buildCatalogIndex([
    aup("a", "【ガチん娘！NK】今日のガチん娘ちゃん。4後編 X"),
    aup("b", "【ガチん娘！NK】今日のガチん娘ちゃん。4後編 Y"),
  ]);

  const match = matchOwnedFile("G:\\uncen\\gachinco\\unmatched\\今日のガチん娘ちゃん。4 のの（後編）.mp4", index);
  assert.equal(match.status, "ambiguous_catalog_title");
  assert.equal(match.candidateMatches.length, 2);
});

test("matches the reviewed Gachinko Road Movie title core despite performer-first ordering", () => {
  const index = buildCatalogIndex([
    aup("128304", "めぐ - ガチンコロードムービー 〜MEGU〜"),
  ]);

  for (const part of [1, 2, 3, 4]) {
    const match = matchOwnedFile("F:\\uncen\\gachinco\\unmatched\\ガチん娘 ガチンコロードムービー ME･GU めぐ" + part + ".wmv", index);
    assert.equal(match.status, "catalog_title");
    assert.equal(match.sourceRecordId, "128304");
  }
});

test("uses the reviewed primary edition for circled branches and matches unique edition five parts", () => {
  const index = buildCatalogIndex([
    shiitake("125460", "THE KANCHOOOOOO!!!!!! スペシャルエディション 4"),
    aup("151552", "真央 他 - THE KANCHOOOOOO!!!!!! スペシャルエディション４"),
    aup("165887", "莉奈 他 - THE KANCHOOOOOO!!!!!! スペシャルエディション５"),
  ]);
  const four = matchOwnedFile("G:\\uncen\\gachinco\\unmatched\\ガチん娘 THE KANCHOOOOOO スペシャルエディション④1.mp4", index);
  assert.equal(four.status, "catalog_title");
  assert.equal(four.sourceCode, "shiitake");
  assert.equal(four.sourceRecordId, "125460");
  const five = matchOwnedFile("G:\\uncen\\gachinco\\unmatched\\ガチん娘 THE KANCHOOOOOO スペシャルエディション⑤1.mp4", index);
  assert.equal(five.status, "catalog_title");
  assert.equal(five.sourceRecordId, "165887");
});

test("matches reviewed title core with video part digit and zero-padded episode", () => {
  const index = buildCatalogIndex([
    shiitake("113409", "アナルを捧げる女 20 美奈子28歳"),
    shiitake("76166", "せきらら女優 9"),
  ]);
  const anal = matchOwnedFile("G:\\uncen\\gachinco\\unmatched\\ガチん娘 アナルを捧げる女 20 美奈子1.mp4", index);
  assert.equal(anal.status, "catalog_title");
  assert.equal(anal.sourceRecordId, "113409");
  const episode = matchOwnedFile("G:\\uncen\\gachinco\\unmatched\\ガチん娘 せきらら女優 09 明菜1.mp4", index);
  assert.equal(episode.status, "catalog_title");
  assert.equal(episode.sourceRecordId, "76166");
});

test("indexes every written number of an A-up interview bundle", () => {
  const index = buildCatalogIndex([
    aup("469527", "【ガチん娘！NK】完全期間限定配信 実録ガチ面接245、246 - 美音"),
  ]);
  const first = matchOwnedFile("F:\\all\\ガチん娘\\1 実録ガチ面接245 美音1.wmv", index);
  const second = matchOwnedFile("F:\\all\\ガチん娘\\2 実録ガチ面接246 美音2.wmv", index);
  assert.equal(first.movieCode, second.movieCode);
  assert.equal(second.status, "bundle_constituent_title");
  assert.equal(second.sourceRecordId, "469527");
});
