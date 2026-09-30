"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const SOURCES = new Set(["shiitake", "a_up", "neo", "heydouga", "gallery"]);
const SOURCE_PRIORITY = { shiitake: 0, a_up: 1, neo: 2, heydouga: 3, gallery: 4 };

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function normalizeRow(row, index) {
  const source = String(row.source || "").toLowerCase();
  const sourceRecordId = String(row.sourceRecordId || "").trim();
  const title = String(row.title || "").replace(/\s+/g, " ").trim();
  if (!SOURCES.has(source)) throw new Error("unsupported_gachinco_source:" + source);
  if (!sourceRecordId) throw new Error("gachinco_source_record_id_empty:" + source + ":" + title);
  if (!title) throw new Error("gachinco_source_title_empty:" + source + ":" + sourceRecordId);
  const rawPayload = row.rawPayload && typeof row.rawPayload === "object" ? row.rawPayload : {};
  const inputCandidates = Array.isArray(rawPayload.constituentCandidates)
    ? rawPayload.constituentCandidates
    : row.constituentCandidates;
  const derivedCandidates = extractGachincoBundleCandidates(title, source, row.detailUrl, row.thumbnailUrl, sourceRecordId);
  const constituentCandidates = Array.isArray(inputCandidates)
    ? [...inputCandidates, ...derivedCandidates].map((candidate) => {
      const candidateTitle = String(candidate.title || "").replace(/\s+/g, " ").trim();
      return {
        title: candidateTitle,
        normalizedTitle: normalizeTitle(candidateTitle),
        aliasKind: String(candidate.aliasKind || "bundle_constituent"),
        sourceRecordId,
        detailUrl: String(row.detailUrl || ""),
        thumbnailUrl: String(row.thumbnailUrl || ""),
      };
    }).filter((candidate, candidateIndex, candidates) => candidate.title && candidate.normalizedTitle &&
      candidates.findIndex((item) => item.normalizedTitle === candidate.normalizedTitle) === candidateIndex)
    : derivedCandidates;
  const reviewedTitleAliases = [];
  for (const match of title.matchAll(/実録\s*ガチ面接\s*([0-9０-９]+)/gu)) {
    const number = match[1];
    const aliasTitle = "ガチ面接" + number;
    const normalizedAlias = normalizeTitle(aliasTitle);
    if (normalizedAlias && !reviewedTitleAliases.some((alias) => alias.normalizedTitle === normalizedAlias)) {
      reviewedTitleAliases.push({ title: aliasTitle, normalizedTitle: normalizedAlias, aliasKind: "reviewed_prefix_variant" });
    }
  }
  // A-up wraps some Gachinco episode titles in a long series/streaming prefix,
  // while owned filenames retain only the numbered episode title. Index that
  // distinctive numbered title separately. If multiple masters use the same
  // episode number, the catalog index keeps the alias ambiguous and won't pick
  // one arbitrarily.
  for (const match of title.matchAll(/今日のガチん娘ちゃん[。．.]?\s*([0-9０-９]+)(前編|後編)?/gu)) {
    const qualifier = match[2] || "";
    const aliasTitle = "今日のガチん娘ちゃん。" + match[1] + qualifier;
    const normalizedAlias = normalizeTitle(aliasTitle);
    if (normalizedAlias && !reviewedTitleAliases.some((alias) => alias.normalizedTitle === normalizedAlias)) {
      reviewedTitleAliases.push({ title: aliasTitle, normalizedTitle: normalizedAlias,
        aliasKind: qualifier ? "reviewed_episode_qualified" : "reviewed_episode_number" });
    }
  }
  for (const match of title.matchAll(/ガチンコロードムービー\s*[〜～~\-]*\s*ME[・･.]?\s*GU/giu)) {
    const aliasTitle = "ガチンコロードムービー MEGU";
    const normalizedAlias = normalizeTitle(aliasTitle);
    if (normalizedAlias && !reviewedTitleAliases.some((alias) => alias.normalizedTitle === normalizedAlias)) {
      reviewedTitleAliases.push({ title: aliasTitle, normalizedTitle: normalizedAlias, aliasKind: "reviewed_title_core" });
    }
  }
  if (source === "a_up") {
    for (const match of title.matchAll(/THE\s+KANCHOOOOOO!+\s*スペシャルエディション\s*([0-9０-９]+)/giu)) {
      const aliasTitle = "THE KANCHOOOOOO!!!!!! スペシャルエディション " + match[1];
      const normalizedAlias = normalizeTitle(aliasTitle);
      if (!reviewedTitleAliases.some((alias) => alias.normalizedTitle === normalizedAlias)) {
        reviewedTitleAliases.push({ title: aliasTitle, normalizedTitle: normalizedAlias, aliasKind: "reviewed_title_core" });
      }
    }
  }
  if (normalizeTitle(title) === normalizeTitle("アナルを捧げる女 20 美奈子28歳")) {
    reviewedTitleAliases.push({ title: "アナルを捧げる女 20 美奈子", normalizedTitle: normalizeTitle("アナルを捧げる女 20 美奈子"), aliasKind: "reviewed_title_core" });
  }
  if (normalizeTitle(title) === normalizeTitle("せきらら女優 9")) {
    reviewedTitleAliases.push({ title: "せきらら女優 09", normalizedTitle: normalizeTitle("せきらら女優 09"), aliasKind: "reviewed_zero_padded_number" });
  }
  return {
    ...row,
    source,
    sourceRecordId,
    title,
    normalizedTitle: normalizeTitle(title),
    thumbnailUrl: String(row.thumbnailUrl || ""),
    detailUrl: String(row.detailUrl || ""),
    sourcePage: String(row.sourcePage || ""),
    pageNumber: Number(row.pageNumber || 0),
    rowIndex: Number(row.rowIndex || index + 1),
    constituentCandidates,
    reviewedTitleAliases,
    rawPayload,
  };
}

function stableMovieCode(canonicalKey) {
  const digest = crypto.createHash("sha256").update(canonicalKey, "utf8").digest("hex").slice(0, 24);
  return "gch-" + digest;
}

function makeMaster(row) {
  const canonicalKey = row.source + ":" + row.sourceRecordId;
  return {
    movieCode: stableMovieCode(canonicalKey),
    canonicalKey,
    normalizedTitle: row.normalizedTitle,
    title: row.title,
    seriesName: "ガチん娘",
    titleSourceCode: row.source,
    titleSourceRecordId: row.sourceRecordId,
    detailUrl: row.detailUrl,
    thumbnailUrl: row.thumbnailUrl,
    thumbnailSourceRecord: row,
    sourceRows: [],
    titleAliases: [],
    bundleAliases: [],
  };
}

function addSourceToMaster(master, row) {
  row.movieCode = master.movieCode;
  row.canonicalKey = master.canonicalKey;
  master.sourceRows.push(row);
  if (row.normalizedTitle && !master.titleAliases.some((item) => item.normalizedTitle === row.normalizedTitle)) {
    master.titleAliases.push({ title: row.title, normalizedTitle: row.normalizedTitle, aliasKind: "source_title", sourceRecord: row });
  }
  for (const alias of row.reviewedTitleAliases || []) {
    if (!master.titleAliases.some((item) => item.normalizedTitle === alias.normalizedTitle)) {
      master.titleAliases.push({ ...alias, sourceRecord: row });
    }
  }
  for (const alias of row.constituentCandidates) {
    const duplicate = master.bundleAliases.some((item) => item.normalizedTitle === alias.normalizedTitle);
    if (!duplicate) master.bundleAliases.push({ ...alias, sourceRecord: row });
  }
  if (!master.detailUrl && row.detailUrl) master.detailUrl = row.detailUrl;
  if (!master.thumbnailUrl && row.thumbnailUrl) {
    master.thumbnailUrl = row.thumbnailUrl;
    master.thumbnailSourceRecord = row;
  }
  if (SOURCE_PRIORITY[row.source] < SOURCE_PRIORITY[master.titleSourceCode]) {
    master.title = row.title;
    master.normalizedTitle = row.normalizedTitle;
    master.titleSourceCode = row.source;
    master.titleSourceRecordId = row.sourceRecordId;
    master.detailUrl = row.detailUrl || master.detailUrl;
    master.thumbnailUrl = row.thumbnailUrl || master.thumbnailUrl;
    if (row.thumbnailUrl) master.thumbnailSourceRecord = row;
  }
}

function compareMaster(left, right) {
  return new Intl.Collator("ja", { numeric: true, sensitivity: "base" }).compare(left.title, right.title) ||
    left.canonicalKey.localeCompare(right.canonicalKey);
}

function buildCatalogIndex(inputRows) {
  if (!Array.isArray(inputRows) || inputRows.length === 0) throw new Error("gachinco_catalog_rows_empty");
  const rows = inputRows.map(normalizeRow);
  const recordIndex = new Map();
  for (const row of rows) {
    const key = row.source + ":" + row.sourceRecordId;
    if (recordIndex.has(key)) throw new Error("duplicate_gachinco_source_record:" + key);
    if (!row.sourcePage || !Number.isInteger(row.pageNumber) || row.pageNumber < 1) {
      throw new Error("gachinco_source_record_page_missing:" + key);
    }
    if (row.source === "shiitake" && !row.thumbnailUrl) throw new Error("shiitake_thumbnail_missing:" + key);
    recordIndex.set(key, row);
  }

  const masters = [];
  const masterByCode = new Map();
  const masterByCanonicalKey = new Map();
  const recordsByMovieCode = new Map();
  const mastersByExactTitle = new Map();
  const addMaster = (row) => {
    const master = makeMaster(row);
    addSourceToMaster(master, row);
    masters.push(master);
    masterByCode.set(master.movieCode, master);
    masterByCanonicalKey.set(master.canonicalKey, master);
    recordsByMovieCode.set(master.movieCode, master.sourceRows);
    return master;
  };
  const trackTitle = (master, row) => {
    const key = row.normalizedTitle;
    if (!key) return;
    const values = mastersByExactTitle.get(key) || [];
    if (!values.includes(master)) values.push(master);
    mastersByExactTitle.set(key, values);
  };

  // Shiitake source IDs are the primary identity. Same-title distinct records stay distinct.
  for (const row of rows.filter((item) => item.source === "shiitake")) {
    const master = addMaster(row);
    trackTitle(master, row);
  }

  // A-up listings are individual works or explicitly titled sets. The set is one master;
  // its numbered constituent titles are aliases, never separate masters.
  for (const row of rows.filter((item) => item.source === "a_up")) {
    const candidates = mastersByExactTitle.get(row.normalizedTitle) || [];
    if (candidates.length === 1) {
      addSourceToMaster(candidates[0], row);
      trackTitle(candidates[0], row);
    } else if (candidates.length > 1) {
      row.movieCode = null;
      row.canonicalKey = "unresolved:" + row.source + ":" + row.sourceRecordId;
      row.rawPayload = { ...row.rawPayload, candidateMovieCodes: candidates.map((master) => master.movieCode) };
    } else {
      const master = addMaster(row);
      trackTitle(master, row);
    }
  }

  // Neo has no individual product ID or work thumbnail. Keep every listing record;
  // link only when the title uniquely identifies a Shiitake or A-up master. A title
  // appearing only once in Neo can seed a no-thumbnail master; repeated titles stay
  // unlinked for title-only review rather than using performer names to decide.
  const neoRows = rows.filter((item) => item.source === "neo");
  const neoTitleCounts = new Map();
  for (const row of neoRows) neoTitleCounts.set(row.normalizedTitle, (neoTitleCounts.get(row.normalizedTitle) || 0) + 1);
  for (const row of neoRows) {
    const candidates = mastersByExactTitle.get(row.normalizedTitle) || [];
    if (candidates.length === 1) {
      addSourceToMaster(candidates[0], row);
      trackTitle(candidates[0], row);
    } else if (candidates.length > 1 || neoTitleCounts.get(row.normalizedTitle) > 1) {
      row.movieCode = null;
      row.canonicalKey = "unresolved:" + row.source + ":" + row.sourceRecordId;
      row.rawPayload = { ...row.rawPayload, candidateMovieCodes: candidates.map((master) => master.movieCode) };
    } else {
      const master = addMaster(row);
      trackTitle(master, row);
    }
  }

  const movieCodesByNormalizedTitle = new Map();
  const bundleAliasIndex = new Map();
  const episodeQualifierPatterns = [];
  const separatedPartTitleKeys = new Set();
  const reviewedPartSuffixKeys = new Set();
  const pushCode = (key, master) => {
    if (!key) return;
    const codes = movieCodesByNormalizedTitle.get(key) || new Set();
    codes.add(master.movieCode);
    movieCodesByNormalizedTitle.set(key, codes);
  };
  for (const master of masters) {
    for (const alias of master.titleAliases) {
      pushCode(alias.normalizedTitle, master);
      if (/\d$/u.test(alias.normalizedTitle)) {
        separatedPartTitleKeys.add(alias.normalizedTitle);
      }
      if (alias.aliasKind === "reviewed_title_core") reviewedPartSuffixKeys.add(alias.normalizedTitle);
    }
    for (const alias of master.bundleAliases) {
      pushCode(alias.normalizedTitle, master);
      const matches = bundleAliasIndex.get(alias.normalizedTitle) || [];
      if (!matches.some((match) => match.movieCode === master.movieCode)) {
        matches.push({ movieCode: master.movieCode, title: master.title, aliasTitle: alias.title, sourceRecord: alias.sourceRecord });
      }
      bundleAliasIndex.set(alias.normalizedTitle, matches);
    }
    for (const alias of master.titleAliases.filter((item) => item.aliasKind === "reviewed_episode_qualified")) {
      const match = alias.title.match(/^今日のガチん娘ちゃん[。．.]?\s*([0-9０-９]+)(前編|後編)$/u);
      if (match) episodeQualifierPatterns.push({
        baseKey: normalizeTitle("今日のガチん娘ちゃん。" + match[1]),
        qualifier: normalizeTitle(match[2]),
        codes: [master.movieCode],
      });
    }
  }
  const groupedEpisodeQualifierPatterns = new Map();
  for (const pattern of episodeQualifierPatterns) {
    const key = pattern.baseKey + ":" + pattern.qualifier;
    const group = groupedEpisodeQualifierPatterns.get(key) || { ...pattern, codes: [] };
    group.codes.push(...pattern.codes);
    groupedEpisodeQualifierPatterns.set(key, group);
  }
  masters.sort(compareMaster);
  return {
    rows,
    masters,
    masterByCode,
    masterByCanonicalKey,
    recordsByMovieCode,
    recordIndex,
    mastersByExactTitle,
    movieCodesByNormalizedTitle,
    bundleAliasIndex,
    titleMatcher: createTitleMatcher(movieCodesByNormalizedTitle,
      [...groupedEpisodeQualifierPatterns.values()].map((pattern) => ({
        ...pattern, codes: [...new Set(pattern.codes)],
      })), separatedPartTitleKeys, reviewedPartSuffixKeys),
  };
}

function createTitleMatcher(movieCodesByNormalizedTitle, episodeQualifierPatterns = [], separatedPartTitleKeys = new Set(), reviewedPartSuffixKeys = new Set()) {
  const patterns = [];
  for (const [key, codes] of movieCodesByNormalizedTitle) {
    if (key.length < 4) continue;
    patterns.push({ key, codes: [...codes], allowSeparatedPartSuffix: separatedPartTitleKeys.has(key), allowPartDigitSuffix: reviewedPartSuffixKeys.has(key) });
  }
  patterns.sort((a, b) => b.key.length - a.key.length || a.key.localeCompare(b.key));
  return function matchTitles(value) {
    const normalized = normalizeWithBoundaries(value);
    const text = normalized.text;
    const found = [];
    for (const pattern of patterns) {
      let from = 0;
      while (from <= text.length - pattern.key.length) {
        const start = text.indexOf(pattern.key, from);
        if (start < 0) break;
        const end = start + pattern.key.length;
        const numericSuffix = pattern.key.match(/\d+$/u)?.[0] || "";
        const numericStart = end - numericSuffix.length;
        const hasSplitNumber = numericSuffix.length > 1 &&
          [...normalized.separatorOffsets].some((offset) => offset > numericStart && offset < end);
        const partNumber = text[end] || "";
        const separatedPart = pattern.allowSeparatedPartSuffix && normalized.separatorOffsets.has(end) &&
          /^[1-9]$/u.test(partNumber) &&
          (!text[end + 1] || (!/\d/u.test(text[end + 1]) && normalized.separatorOffsets.has(end + 1)));
        // A numbered work must not match a longer number. A separator inside
        // a Neo title's numeric ending marks a distinct one-digit file part
        // (89 + " 1"), never the concatenated title number 891.
        if (!hasSplitNumber && (!/\d/.test(text[end] || "") || separatedPart || (!numericSuffix && pattern.allowPartDigitSuffix))) {
          found.push({ ...pattern, start, end });
        }
        from = start + 1;
      }
    }
    // A filename can place the performer between the numbered episode and its
    // 前編/後編 marker. Require the exact numbered episode, then the known
    // qualifier within a short gap so episode 4 cannot collapse into 4後編.
    for (const pattern of episodeQualifierPatterns) {
      let from = 0;
      while (from <= text.length - pattern.baseKey.length) {
        const start = text.indexOf(pattern.baseKey, from);
        if (start < 0) break;
        const baseEnd = start + pattern.baseKey.length;
        if (!/\d/.test(text[baseEnd] || "")) {
          const gap = text.slice(baseEnd, baseEnd + 9);
          const qualifierAt = gap.indexOf(pattern.qualifier);
          if (qualifierAt >= 0) {
            const end = baseEnd + qualifierAt + pattern.qualifier.length;
            found.push({ key: pattern.baseKey + pattern.qualifier, codes: pattern.codes, start, end });
          }
        }
        from = start + 1;
      }
    }
    found.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const selected = [];
    for (const candidate of found) {
      if (selected.some((item) => item.start <= candidate.start && item.end >= candidate.end)) continue;
      selected.push(candidate);
    }
    const codes = [...new Set(selected.flatMap((item) => item.codes))];
    return { codes, patterns: selected };
  };
}

function normalizeWithBoundaries(value) {
  let text = "";
  let pendingSeparator = false;
  const separatorOffsets = new Set();
  // A circled episode number is a complete token even when the file's part
  // number follows without a space (for example, edition ⑤ part 1).
  const withCircledBoundaries = String(value || "").replace(/[①-⑳]/gu, (character) => character + " ");
  for (const character of withCircledBoundaries.normalize("NFKC").toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      if (pendingSeparator && text) separatorOffsets.add(text.length);
      text += character;
      pendingSeparator = false;
    } else if (text) {
      pendingSeparator = true;
    }
  }
  if (pendingSeparator && text) separatorOffsets.add(text.length);
  return { text, separatorOffsets };
}

function extractGachincoBundleCandidates(title, source, detailUrl, thumbnailUrl, sourceRecordId) {
  if (source !== "a_up") return [];
  const found = new Map();
  // Only the user-reviewed series pattern is decomposed. General punctuation/comma
  // splitting could incorrectly turn actors, subtitles, or unrelated works into aliases.
  for (const match of String(title || "").matchAll(/実録\s*ガチ面接\s*[0-9０-９]+(?:\s*[、,]\s*[0-9０-９]+)*/gu)) {
    for (const number of match[0].match(/[0-9０-９]+/gu) || []) {
      const aliasTitle = "実録ガチ面接" + number;
      const normalized = normalizeTitle(aliasTitle);
      if (normalized) found.set(normalized, {
        title: aliasTitle,
        normalizedTitle: normalized,
        aliasKind: "bundle_constituent",
        sourceRecordId: String(sourceRecordId || ""),
        detailUrl: String(detailUrl || ""),
        thumbnailUrl: String(thumbnailUrl || ""),
      });
      const shortAlias = "ガチ面接" + number;
      const shortNormalized = normalizeTitle(shortAlias);
      if (shortNormalized) found.set(shortNormalized, {
        title: shortAlias,
        normalizedTitle: shortNormalized,
        aliasKind: "reviewed_prefix_variant",
        sourceRecordId: String(sourceRecordId || ""),
        detailUrl: String(detailUrl || ""),
        thumbnailUrl: String(thumbnailUrl || ""),
      });
    }
  }
  return [...found.values()];
}

function matchOwnedFile(filePath, index, contextTexts = []) {
  const fileName = path.win32.basename(String(filePath || ""));
  const components = String(filePath || "").split(/[\\/]+/).filter(Boolean);
  const pathMarker = components.some((part) => /^gachinco$/i.test(part));
  const filenameMarker = /gachi(?:nco)?/i.test(fileName);
  const providerMarker = /(?:hey|heydouga)[\s._-]*4037(?:$|[\s._-])/i.test(fileName);
  // The user explicitly approved this shortened title as the Shiitake work
  // "実録ガチ面接 40 [美菜19歳]". Both words must be present in the video name.
  const normalizedFileName = normalizeTitle(fileName);
  if (normalizedFileName.includes(normalizeTitle("ガチ面接40")) && normalizedFileName.includes(normalizeTitle("美菜"))) {
    const primary = index.masters.filter((master) => master.titleSourceCode === "shiitake" &&
      master.normalizedTitle === normalizeTitle("実録ガチ面接 40 [美菜19歳]"));
    if (primary.length === 1) {
      const master = primary[0];
      return {
        inScope: true, status: "catalog_title", matchMethod: "explicit_user_title_equivalence",
        confidence: 0.95, pathMarker, filenameMarker, providerMarker,
        movieCode: master.movieCode, title: master.title,
        sourceCode: master.titleSourceCode, sourceRecordId: master.titleSourceRecordId,
        detailUrl: master.detailUrl || "", thumbnailUrl: master.thumbnailUrl || "",
      };
    }
  }
  const edition = fileName.match(/THE\s+KANCHOOOOOO!*[\s._-]*スペシャルエディション[\s._-]*([④⑦])(?:[1-9])?/iu);
  if (edition) {
    const number = edition[1] === "④" ? "4" : "7";
    const primary = index.masters.filter((master) => master.titleSourceCode === "shiitake" &&
      master.normalizedTitle === normalizeTitle("THE KANCHOOOOOO!!!!!! スペシャルエディション " + number));
    if (primary.length === 1) {
      const master = primary[0];
      return {
        inScope: true, status: "catalog_title", matchMethod: "reviewed_primary_edition_branch",
        confidence: 0.95, pathMarker, filenameMarker, providerMarker,
        movieCode: master.movieCode, title: master.title,
        sourceCode: master.titleSourceCode, sourceRecordId: master.titleSourceRecordId,
        detailUrl: master.detailUrl || "", thumbnailUrl: master.thumbnailUrl || "",
      };
    }
  }
  const fileMatches = index.titleMatcher(fileName);
  let result = fileMatches;
  let matchMethod = "normalized_catalog_title";

  // Parent folder matching is caller-controlled and should only pass a folder that
  // unambiguously names one work. It is consulted only when the video basename has
  // no title candidates.
  if (!result.codes.length) {
    const contextual = [];
    for (const value of contextTexts) {
      const candidate = index.titleMatcher(value);
      if (candidate.codes.length) contextual.push(candidate);
    }
    const codes = [...new Set(contextual.flatMap((item) => item.codes))];
    result = { codes, patterns: contextual.flatMap((item) => item.patterns) };
    if (codes.length) matchMethod = "parent_folder_title";
  }

  if (result.codes.length === 1) {
    const movieCode = result.codes[0];
    const master = index.masterByCode.get(movieCode);
    const matchedAlias = result.patterns.find((item) => item.codes.includes(movieCode) &&
      (index.bundleAliasIndex.get(item.key) || []).some((alias) => alias.movieCode === movieCode));
    const bundle = matchedAlias ? (index.bundleAliasIndex.get(matchedAlias.key) || [])
      .find((alias) => alias.movieCode === movieCode) : null;
    return {
      inScope: true,
      status: bundle ? "bundle_constituent_title" : "catalog_title",
      matchMethod: bundle ? "bundle_constituent_title" : matchMethod,
      confidence: bundle ? 0.9 : 0.95,
      pathMarker,
      filenameMarker,
      providerMarker,
      movieCode,
      title: master.title,
      sourceCode: bundle?.sourceRecord?.source || master.titleSourceCode,
      sourceRecordId: bundle?.sourceRecord?.sourceRecordId || master.titleSourceRecordId,
      detailUrl: bundle?.sourceRecord?.detailUrl || master.detailUrl || "",
      thumbnailUrl: master.thumbnailUrl || "",
      matchedAlias: bundle?.aliasTitle || "",
      canonicalTitle: master.title,
    };
  }

  if (result.codes.length > 1) {
    return {
      inScope: true,
      status: "ambiguous_catalog_title",
      matchMethod: "multiple_catalog_titles",
      confidence: 0.5,
      pathMarker,
      filenameMarker,
      providerMarker,
      movieCode: "",
      title: "",
      sourceCode: "",
      sourceRecordId: "",
      detailUrl: "",
      thumbnailUrl: "",
      candidateMatches: result.codes.map((movieCode) => {
        const master = index.masterByCode.get(movieCode);
        return { movieCode, title: master.title, detailUrl: master.detailUrl || "" };
      }),
    };
  }

  if (pathMarker || filenameMarker || providerMarker) {
    return {
      inScope: true,
      status: "marker_only",
      matchMethod: "site_marker",
      confidence: 0,
      pathMarker,
      filenameMarker,
      providerMarker,
      movieCode: "",
      title: "",
      sourceCode: "",
      sourceRecordId: "",
      detailUrl: "",
      thumbnailUrl: "",
    };
  }
  return { inScope: false, status: "not_gachinco", matchMethod: "none", confidence: 0, pathMarker, filenameMarker, providerMarker };
}

module.exports = {
  SOURCES,
  buildCatalogIndex,
  extractGachincoBundleCandidates,
  matchOwnedFile,
  normalizeTitle,
  stableMovieCode,
};
