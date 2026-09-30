"use strict";

const path = require("node:path");

const SERIES = /(?:実録ガチ面接|ガチ面接|実録ガチハメ|素人生撮りファイル|若奥様生撮りファイル|彼女の性癖|エッチな日常|スクールデイズ|別刊マンコレ[・\s]*マニアックス|別刊マンコレ|別刊マジオナ|ヤラレ人形|アナルを捧げる女|M女志願|Sexy(?:ランジェリー|レギンス|ストッキング|ボディコン)の虜|SWEETエンジェル|酔ぃ[〜~ー]?とエンジェル|KURADASHI|今日のガチん娘ちゃん[。.]?|ガンシャされる女たち[。.]?|せきらら女優|ス・テ・キ・な・おねぇサマ|露出体験|女体解析|強制ガチアクメ|曼荼羅性交絵巻|スリム\s*[&＆]\s*タイト|ガチンコプロフィール|GRM(?:現地調達編|番外編)|ガチンコロードムービー|バイセクシャル|マンコレ[・\s]*(?:リミックス|特大号|マニアックス)?|マジオナ[・\s]*(?:超特大号|特大号|マニアックス|特別編)?)/iu;
const BAD_NAME = /(?:ガチ|面接|マンコレ|マジオナ|アナル|中出し|セックス|オナニー|スペシャル|特大号|シリーズ|ストッキング|ランジェリー|レギンス|ボディコン|女志願|スクール|エンジェル|ファイル|ボーナス|トラック|未公開|動画|映像|本編|番外編|画質|HD|DVD|Part|Vol|THE|GRM|FINAL|MIX|KURADASHI|完全版|前編|後編|未編集|浣腸|脱糞|放尿|露出|撮影|体験|番号|巨乳|美乳|ガンシャ|ごっくん|バージョン|プロローグ|おまけ|メイキング|穴編|トーク|レズ|リミックス|バイセクシャル|特別篇|ファッキン)/iu;

function normalizeName(value, { allowOthers = true } = {}) {
  let text = String(value || "").normalize("NFKC").trim();
  const namedGroup = text.match(/^(.+?)(?:他|等)\s*\d{1,2}名(?:\d{1,2}発)?$/u);
  if (namedGroup) {
    const first = normalizeName(namedGroup[1]);
    return first ? first + " 他" : "";
  }
  text = text.replace(/[（(][^）)]*?(?:続編|フルHD|HD|前編|後編|歳|バージョン|マジオナ|リミックス)[^）)]*[）)]/gu, "");
  text = text.replace(/[【\[][^】\]]*?(?:完全版|ボーナストラック)[^】\]]*[】\]]/gu, "");
  text = text.replace(/^[\s「『【[(（]+|[\s」』】\])）.,。-]+$/gu, "");
  text = text.replace(/^(?:[（(]?(?:フルHD|HD)版\d+[）)]?|前編|後編|中編)\s*/gu, "");
  text = text.replace(/(?:前編|後編|中編|完全版|続編|未公開映像集|未公開集|バージョン\d+)\s*$/gu, "");
  text = text.replace(/[\s.\-]+\d{1,4}(?:-\d)?$/u, "");
  text = text.replace(/(?<=\p{L})\d{3,4}$/u, "");
  text = text.replace(/(?<=\p{L})\d{1,2}(?:歳)?$/u, "").trim();
  text = text.replace(/(?:\d{2}歳)$/u, "").trim();
  const others = allowOthers && /\s*(?:他|等)\s*$/u.test(text);
  text = text.replace(/\s*(?:他|等)\s*$/u, "");
  text = text.replace(/[／/&＆]+/gu, "、").replace(/\s*、\s*/gu, "、").trim();
  const names = text.split("、").map((name) => name.trim());
  if (!names.length || names.length > 6 || names.some((name) => !name || name.length > 14 || BAD_NAME.test(name) || !/^[\p{L}ー・]+$/u.test(name))) return "";
  return names.join("、") + (others ? " 他" : "");
}

function filenameActor(fileName) {
  const stem = path.win32.basename(String(fileName || ""), path.win32.extname(String(fileName || ""))).normalize("NFKC");
  const simple = stem.match(/^\s*\d{1,2}\s*([^\s].*)$/u);
  if (simple) {
    const person = normalizeName(simple[1]);
    if (person) return person;
  }
  const sitePrefix = stem.match(/^(?:ガチん娘\s+)?([\p{L}ー・、／&＆]{1,24})\s*[−—–-]\s*【ガチん娘/u);
  if (sitePrefix) {
    const person = normalizeName(sitePrefix[1]);
    if (person) return person;
  }
  // Download names often put the actress before a dash and the work after it.
  const beforeTitle = stem.match(/(?:^|[\s_])([^\s_−—–-]{1,25}(?:[、／&＆][^\s_−—–-]{1,20})*)\s*[−—–-]\s*(?:実録|ガチ面接|別刊|アナル|スクール|酔ぃ|GRM|Sexy|ヤラレ|素人|エッチな日常|女体解析|スリム|せきらら)/iu);
  if (beforeTitle) {
    const person = normalizeName(beforeTitle[1]);
    if (person) return person;
  }
  const specialTail = stem.match(/(?:THE\s*KANCHOOOOOO.*?(?:番外編|未公開映像))\s*([\p{L}ー・、／&＆]{1,25})$/iu);
  if (specialTail) {
    const person = normalizeName(specialTail[1]);
    if (person) return person;
  }
  const afterTilde = stem.match(/[〜~]\s*([\p{L}ー・]{1,20})\s*$/u);
  if (afterTilde) {
    const person = normalizeName(afterTilde[1]);
    if (person) return person;
  }
  const ageLead = stem.match(/[〜~]\s*([\p{L}ー・]{1,20})\s+\d{2}\s*[歳歲]/u);
  if (ageLead) {
    const person = normalizeName(ageLead[1]);
    if (person) return person;
  }
  const found = SERIES.exec(stem);
  if (found) {
    const suffix = stem.slice(found.index + found[0].length).replace(/^\s*(?:DX|Part|Vol\.?)[\s.]*\d*\s*/iu, "")
      .replace(/^\s*[\d０-９①-⑳]+[\s._-]*/u, "");
    const withoutPartLabel = suffix.replace(/^(?:前編|後編|中編|前半|後半)\s*/u, "").replace(/^[^\p{L}]*/u, "");
    const beforeSequel = withoutPartLabel.match(/^([\p{L}ー・、／&＆]{1,25})\s+続編\d+(?:_\d+p)?$/u);
    if (beforeSequel) {
      const named = normalizeName(beforeSequel[1]);
      if (named) return named;
    }
    const person = normalizeName(withoutPartLabel);
    if (person) return person;
    const localizedName = withoutPartLabel.match(/^[A-Za-z・･]{2,12}\s+([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{1,12})\d*$/u);
    if (localizedName) {
      const localized = normalizeName(localizedName[1]);
      if (localized) return localized;
    }
    const beforeDescription = withoutPartLabel.match(/^([\p{L}ー・、／&＆]{1,25})\s+(?:\d+穴|未公開|別バージョン)/u);
    if (beforeDescription) {
      const named = normalizeName(beforeDescription[1]);
      if (named) return named;
    }
    // Numbered episodes may be followed by an actress and a separate source ID.
    const afterNumber = withoutPartLabel.match(/^[\s\d０-９①-⑳._-]*([^\s]+(?:[、／&＆][^\s]+)*)(?:\s+\d{1,4}(?:-\d)?)?\s*$/u);
    if (afterNumber) {
      const personAfterNumber = normalizeName(afterNumber[1]);
      if (personAfterNumber) return personAfterNumber;
    }
  }
  return "";
}

function titleActor(title) {
  const value = String(title || "").normalize("NFKC").trim();
  const embedded = value.match(/^ガチん娘[！!]\s*([\p{L}ー・、／&＆]{1,24}(?:\s+他)?)\s+オシッコ/u);
  if (embedded) {
    const person = normalizeName(embedded[1]);
    if (person) return person;
  }
  const finalName = value.match(/^([\p{L}ー・]{1,14})ファイナル\s+/u);
  if (finalName) {
    const person = normalizeName(finalName[1]);
    if (person) return person;
  }
  const namedTilde = value.match(/(?:DX|ロードムービー)\s*[〜~−-]\s*([\p{L}ー・]{2,16})\s*[〜~−-]?$/u);
  if (namedTilde) {
    const person = normalizeName(namedTilde[1]);
    if (person) return person;
  }
  const bracket = value.match(/[\[(【]([\p{L}ー・、／&＆\s]{1,32})(?:\d{2}歳)?[\])】]\s*$/u);
  if (bracket) {
    const person = normalizeName(bracket[1]);
    if (person) return person;
  }
  const prefix = value.match(/^([^\[【\]-]{1,35}?)\s+-\s+(?:【|[\p{L}])/u);
  if (prefix) {
    const person = normalizeName(prefix[1], { allowOthers: true });
    if (person) return person;
  }
  const suffix = value.match(/(?:【[^】]+】|実録ガチ面接|エッチな日常|アナルを捧げる女|素人生撮りファイル).+?\s+-\s+([\p{L}ー・、／&＆\s]{1,35})$/u);
  if (suffix) {
    const person = normalizeName(suffix[1]);
    if (person) return person;
  }
  const end = value.match(/(?:\d+|[①-⑳])\s+([\p{L}ー・、／&＆]{1,25})(?:\d{2}歳)?\s*$/u);
  return end ? normalizeName(end[1]) : "";
}

function folderActor(originalFilePath) {
  const folder = path.win32.basename(path.win32.dirname(String(originalFilePath || ""))).normalize("NFKC");
  if (!folder || /^(?:ガチん娘|購入|保存|unmatched|branches|\d{1,4})$/iu.test(folder)) return "";
  const prefix = folder.match(/^([^\[【\]-]{1,35}?)\s+-\s+(?:【|[\p{L}])/u);
  if (prefix) {
    const person = normalizeName(prefix[1], { allowOthers: true });
    if (person) return person;
  }
  const joinedSpecial = folder.match(/バイセクシャル特別篇\s+([\p{L}ー・、／&＆]{2,30})$/u);
  if (joinedSpecial) {
    const person = normalizeName(joinedSpecial[1]);
    if (person) return person;
  }
  const namedEdition = folder.match(/アナルを捧げる女\s+スペシャルエディション\s*[〜~]\s*([A-Za-z]{2,15})\s*[〜~]?$/u);
  if (namedEdition) {
    const person = normalizeName(namedEdition[1]);
    if (person) return person;
  }
  const localizedTilde = folder.match(/[〜~]\s*[A-Za-z・･]{2,15}\s*[〜~]\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{1,12})\s*[-ー]?$/u);
  if (localizedTilde) {
    const person = normalizeName(localizedTilde[1]);
    if (person) return person;
  }
  const namedTilde = folder.match(/(?:DX|ロードムービー)\s*[〜~−-]?\s*([A-Za-z・･]{2,16})\s*[〜~−-]?$/u);
  if (namedTilde) {
    const person = normalizeName(namedTilde[1].replace(/[・･]/g, ""));
    if (person) return person;
  }
  const finalFolder = folder.match(/露出体験DX\s+([\p{L}ー・]{1,14})\s*-/u);
  if (finalFolder) {
    const person = normalizeName(finalFolder[1]);
    if (person) return person;
  }
  const dashSuffix = folder.match(/(?:【[^】]+】|実録ガチ面接|エッチな日常|アナルを捧げる女).+?\s+-\s+([\p{L}ー・、／&＆\s]{1,35})$/u);
  if (dashSuffix) {
    const person = normalizeName(dashSuffix[1]);
    if (person) return person;
  }
  const end = folder.match(/(?:\d+|[①-⑳])\s+([\p{L}ー・、／&＆]{1,25})(?:\s*[-ー])?$/u);
  return end ? normalizeName(end[1]) : "";
}

function performerForOwnedFile(row) {
  const fromFile = filenameActor(row.file_name);
  if (fromFile) return { actorNames: fromFile, source: "file_name" };
  const fromFolder = folderActor(row.original_file_path);
  if (fromFolder) return { actorNames: fromFolder, source: "original_folder" };
  const fromTitle = titleActor(row.title);
  if (fromTitle) return { actorNames: fromTitle, source: "catalog_title" };
  return { actorNames: "", source: "unresolved" };
}

module.exports = { normalizeName, filenameActor, folderActor, titleActor, performerForOwnedFile };
