"use strict";

const crypto = require("crypto");
const path = require("path");

const SOURCES = new Set(["analers", "heydouga", "shiitake"]);
const SOURCE_PRIORITY = { analers: 0, heydouga: 1, shiitake: 2 };
const SERIES_FAMILIES = [
  { prefix: "押田伸治", key: "oshida", name: "押田伸治シリーズ" },
  { prefix: "フルロード", key: "fullroad", name: "フルロード" },
  { prefix: "アナル初め", key: "analstart", name: "アナル初め" },
  { prefix: "セーラーブルマ", key: "sailorburuma", name: "セーラーブルマ" },
];

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function getSeriesIdentity(title) {
  const normalized = String(title || "").normalize("NFKC").toLowerCase();
  for (const family of SERIES_FAMILIES) {
    const expression = new RegExp(
      family.prefix + "\\s*0*(\\d{1,4})(?=\\s|$|[^0-9])",
      "u"
    );
    const match = normalized.match(expression);
    if (match) {
      return {
        canonicalKey: "series:" + family.key + ":" + Number(match[1]),
        seriesName: family.name,
        seriesNumber: Number(match[1]),
      };
    }
  }
  return null;
}

function canonicalKeyForTitle(title) {
  const series = getSeriesIdentity(title);
  if (series) return series.canonicalKey;
  const normalized = normalizeTitle(title);
  if (!normalized) throw new Error("catalog_title_is_empty");
  return "title:" + normalized;
}

function movieCodeForCanonicalKey(canonicalKey) {
  const digest = crypto.createHash("sha256").update(canonicalKey, "utf8").digest("hex").slice(0, 20);
  return "n24-" + digest;
}

function compareCatalogRows(left, right) {
  const sourceDifference =
    (SOURCE_PRIORITY[left.source] ?? 99) - (SOURCE_PRIORITY[right.source] ?? 99);
  if (sourceDifference !== 0) return sourceDifference;
  const thumbDifference = Number(Boolean(right.thumbnailUrl)) - Number(Boolean(left.thumbnailUrl));
  if (thumbDifference !== 0) return thumbDifference;
  const titleDifference = String(right.title || "").length - String(left.title || "").length;
  if (titleDifference !== 0) return titleDifference;
  return String(left.sourceRecordId).localeCompare(String(right.sourceRecordId));
}

function buildCatalogIndex(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("catalog_rows_are_empty");
  const groups = new Map();
  const recordIndex = new Map();
  const heydougaIdIndex = new Map();

  for (const row of rows) {
    const source = String(row.source || "").toLowerCase();
    const sourceRecordId = String(row.sourceRecordId || "").trim();
    const title = String(row.title || "").trim();
    if (!SOURCES.has(source)) throw new Error("unsupported_catalog_source:" + source);
    if (!sourceRecordId) throw new Error("catalog_source_record_id_is_empty:" + source + ":" + title);
    if (!title) throw new Error("catalog_title_is_empty:" + source + ":" + sourceRecordId);
    if (!row.thumbnailUrl) throw new Error("catalog_thumbnail_url_is_empty:" + source + ":" + sourceRecordId);

    const identity = source + ":" + sourceRecordId;
    if (recordIndex.has(identity)) throw new Error("duplicate_source_record:" + identity);

    const canonicalKey = canonicalKeyForTitle(title);
    if (!groups.has(canonicalKey)) groups.set(canonicalKey, []);
    const enriched = {
      ...row,
      source,
      sourceRecordId,
      title,
      normalizedTitle: normalizeTitle(title),
      canonicalKey,
    };
    groups.get(canonicalKey).push(enriched);
    recordIndex.set(identity, enriched);
    if (source === "heydouga") {
      if (heydougaIdIndex.has(sourceRecordId)) throw new Error("duplicate_heydouga_id:" + sourceRecordId);
      heydougaIdIndex.set(sourceRecordId, enriched);
    }
  }

  const masters = [];
  const masterByCode = new Map();
  const masterByCanonicalKey = new Map();
  const recordsByMovieCode = new Map();
  const movieCodesByNormalizedTitle = new Map();

  for (const [canonicalKey, sourceRows] of groups) {
    const ordered = [...sourceRows].sort(compareCatalogRows);
    const thumbnailSource = ordered.find((row) => row.thumbnailUrl);
    if (!thumbnailSource) throw new Error("catalog_group_has_no_thumbnail:" + canonicalKey);
    const detailSource = [...sourceRows]
      .filter((row) => row.detailUrl)
      .sort((a, b) => {
        const detailPriority = { heydouga: 0, shiitake: 1, analers: 2 };
        return (detailPriority[a.source] ?? 99) - (detailPriority[b.source] ?? 99);
      })[0];
    const identity = getSeriesIdentity(thumbnailSource.title);
    const movieCode = movieCodeForCanonicalKey(canonicalKey);
    const master = {
      movieCode,
      canonicalKey,
      normalizedTitle: normalizeTitle(thumbnailSource.title),
      title: thumbnailSource.title,
      seriesName: identity?.seriesName || thumbnailSource.series || "",
      titleSourceCode: thumbnailSource.source,
      titleSourceRecordId: thumbnailSource.sourceRecordId,
      detailUrl: detailSource?.detailUrl || "",
      thumbnailUrl: thumbnailSource.thumbnailUrl,
      thumbnailSourceRecord: thumbnailSource,
      sourceRows: ordered,
    };
    masters.push(master);
    masterByCode.set(movieCode, master);
    masterByCanonicalKey.set(canonicalKey, master);
    recordsByMovieCode.set(movieCode, ordered);
    for (const row of ordered) {
      const keys = movieCodesByNormalizedTitle.get(row.normalizedTitle) || new Set();
      keys.add(movieCode);
      movieCodesByNormalizedTitle.set(row.normalizedTitle, keys);
    }
  }

  masters.sort((a, b) => a.movieCode.localeCompare(b.movieCode));
  const titleMatcher = createTitleMatcher(movieCodesByNormalizedTitle, recordIndex);
  const heydougaNumericIndex = new Map();
  for (const [id, row] of heydougaIdIndex) {
    const numeric = normalizeExternalId(id);
    if (!numeric) continue;
    if (heydougaNumericIndex.has(numeric) && heydougaNumericIndex.get(numeric) !== row) {
      heydougaNumericIndex.set(numeric, null);
    } else if (!heydougaNumericIndex.has(numeric)) {
      heydougaNumericIndex.set(numeric, row);
    }
  }

  return {
    rows: [...recordIndex.values()],
    masters,
    masterByCode,
    masterByCanonicalKey,
    recordsByMovieCode,
    recordIndex,
    heydougaIdIndex,
    heydougaNumericIndex,
    titleMatcher,
  };
}

function createTitleMatcher(movieCodesByNormalizedTitle, recordIndex) {
  const patterns = [];
  for (const [key, movieCodes] of movieCodesByNormalizedTitle) {
    const codes = [...movieCodes];
    const row = [...recordIndex.values()]
      .filter((item) => item.normalizedTitle === key)
      .sort(compareCatalogRows)[0];
    patterns.push({ key, codes, row });
  }

  const nodes = [{ next: new Map(), fail: 0, output: [] }];
  for (const pattern of patterns) {
    let state = 0;
    for (const char of pattern.key) {
      let next = nodes[state].next.get(char);
      if (next === undefined) {
        next = nodes.length;
        nodes[state].next.set(char, next);
        nodes.push({ next: new Map(), fail: 0, output: [] });
      }
      state = next;
    }
    nodes[state].output.push(pattern);
  }

  const queue = [];
  for (const next of nodes[0].next.values()) {
    nodes[next].fail = 0;
    queue.push(next);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const state = queue[index];
    for (const [char, next] of nodes[state].next) {
      queue.push(next);
      let fallback = nodes[state].fail;
      while (fallback && !nodes[fallback].next.has(char)) fallback = nodes[fallback].fail;
      nodes[next].fail = nodes[fallback].next.get(char) ?? 0;
      nodes[next].output.push(...nodes[nodes[next].fail].output);
    }
  }

  return function matchTitles(value, allowShort) {
    const text = normalizeTitle(value);
    let state = 0;
    const found = new Map();
    for (const char of text) {
      while (state && !nodes[state].next.has(char)) state = nodes[state].fail;
      state = nodes[state].next.get(char) ?? 0;
      for (const pattern of nodes[state].output) found.set(pattern.key, pattern);
    }

    const valid = [...found.values()].filter((pattern) => {
      if (pattern.key.length < 8 && !(allowShort && pattern.key.length >= 6)) return false;
      if (/\d$/.test(pattern.key)) {
        const start = text.indexOf(pattern.key);
        if (start >= 0 && /\d/.test(text[start + pattern.key.length] || "")) return false;
      }
      return true;
    }).sort((a, b) => {
      const aLength = a.key.replace(/^(?:night24|nig24)/, "").length;
      const bLength = b.key.replace(/^(?:night24|nig24)/, "").length;
      return bLength - aLength || b.key.length - a.key.length;
    });

    const maximal = [];
    for (const candidate of valid) {
      const candidateCore = candidate.key.replace(/^(?:night24|nig24)/, "");
      const covered = maximal.some((selected) => selected.key.replace(/^(?:night24|nig24)/, "").includes(candidateCore));
      if (!covered) maximal.push(candidate);
    }
    const codes = [...new Set(maximal.flatMap((item) => item.codes))];
    return { codes, patterns: maximal };
  };
}

function normalizeExternalId(value) {
  const normalized = String(value || "").replace(/^0+(?=\d)/, "");
  return /^\d+$/.test(normalized) ? normalized : "";
}

function isNight24Path(filePath) {
  const components = String(filePath || "").split(/[\\/]+/).filter(Boolean);
  return components.some((component) =>
    /^(?:night[\s._-]*24(?:[_\s-]*new)?|nig[\s._-]*24)$/i.test(component)
  );
}

function hasNight24FilenameMarker(fileName) {
  return /(^|[^a-z0-9])night[\s._-]*24($|[^0-9])|(^|[^a-z0-9])nig[\s._-]*24($|[^0-9])|(?:hey|heydouga)[-_ .]*4044/i.test(
    String(fileName || "")
  );
}

function extractExplicitHeydougaId(fileName) {
  const name = String(fileName || "");
  const patterns = [
    /(?:heydouga|hey)[-_ .]*4044[-_ .]*(?:ppv[-_ .]*)?(\d{2,6})/i,
    /nig[\s._-]*24[-_ .]*(\d{2,6})/i,
    /night[\s._-]*24[\s._-]*file[\s._-]*(\d{2,6})/i,
    /night[\s._-]*24[-_ .]*x0*(\d{1,6})/i,
  ];
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function matchOwnedFile(filePath, index) {
  const normalizedPath = String(filePath || "");
  const fileName = path.win32.basename(normalizedPath);
  const pathMarker = isNight24Path(normalizedPath);
  const filenameMarker = hasNight24FilenameMarker(fileName);
  const providerMarker = /(?:hey|heydouga)[-_ .]*4044/i.test(fileName);
  let sourceRecord = null;
  let sourceRecordId = extractExplicitHeydougaId(fileName);

  if (!sourceRecordId && pathMarker) {
    const stem = path.win32.parse(fileName).name;
    if (/^\d{2,6}$/.test(stem)) sourceRecordId = stem;
  }

  if (sourceRecordId) {
    sourceRecord =
      index.heydougaIdIndex.get(sourceRecordId) ||
      index.heydougaNumericIndex.get(normalizeExternalId(sourceRecordId)) ||
      null;
  }

  if (sourceRecord) {
    const master = index.masterByCanonicalKey.get(sourceRecord.canonicalKey);
    return {
      inScope: true,
      status: "exact_catalog_id",
      matchMethod: "heydouga_source_id",
      confidence: 1,
      pathMarker,
      filenameMarker,
      providerMarker,
      movieCode: master.movieCode,
      title: master.title,
      sourceCode: sourceRecord.source,
      sourceRecordId: sourceRecord.sourceRecordId,
      detailUrl: sourceRecord.detailUrl || "",
      thumbnailUrl: sourceRecord.thumbnailUrl || "",
      canonicalTitle: master.title,
    };
  }

  const titleResult = index.titleMatcher(fileName, pathMarker || filenameMarker || providerMarker);
  if (titleResult.codes.length === 1) {
    const master = index.masterByCode.get(titleResult.codes[0]);
    const pattern = titleResult.patterns.find((item) => item.codes.includes(master.movieCode));
    const row = pattern?.row;
    return {
      inScope: true,
      status: "catalog_title",
      matchMethod: "normalized_catalog_title",
      confidence: 0.95,
      pathMarker,
      filenameMarker,
      providerMarker,
      movieCode: master.movieCode,
      title: master.title,
      sourceCode: row?.source || master.titleSourceCode,
      sourceRecordId: row?.sourceRecordId || master.titleSourceRecordId,
      detailUrl: row?.detailUrl || master.detailUrl,
      thumbnailUrl: row?.thumbnailUrl || master.thumbnailUrl,
      canonicalTitle: master.title,
    };
  }

  if (pathMarker || filenameMarker || providerMarker) {
    return {
      inScope: true,
      status: titleResult.codes.length > 1 ? "ambiguous_catalog_title" : "marker_only",
      matchMethod: titleResult.codes.length > 1 ? "multiple_catalog_titles" : "site_marker",
      confidence: titleResult.codes.length > 1 ? 0.5 : 0,
      pathMarker,
      filenameMarker,
      providerMarker,
      candidateMatches: titleResult.codes.map((code) => {
        const candidate = index.masterByCode.get(code);
        return { movieCode: code, title: candidate.title, detailUrl: candidate.detailUrl || "" };
      }),
      movieCode: "",
      title: "",
      sourceCode: "",
      sourceRecordId: "",
      detailUrl: "",
      thumbnailUrl: "",
      canonicalTitle: "",
    };
  }

  if (titleResult.codes.length) {
    return {
      inScope: false,
      status: "title_only_review",
      matchMethod: "title_without_night24_marker",
      confidence: 0.5,
      pathMarker,
      filenameMarker,
      providerMarker,
      candidateMatches: titleResult.codes.map((code) => {
        const candidate = index.masterByCode.get(code);
        return { movieCode: code, title: candidate.title, detailUrl: candidate.detailUrl || "" };
      }),
      movieCode: "",
      title: "",
      sourceCode: "",
      sourceRecordId: "",
      detailUrl: "",
      thumbnailUrl: "",
      canonicalTitle: "",
    };
  }

  return { inScope: false, status: "not_night24", matchMethod: "none", confidence: 0, pathMarker, filenameMarker, providerMarker };
}

module.exports = {
  SOURCES,
  SERIES_FAMILIES,
  buildCatalogIndex,
  canonicalKeyForTitle,
  extractExplicitHeydougaId,
  getSeriesIdentity,
  hasNight24FilenameMarker,
  isNight24Path,
  matchOwnedFile,
  movieCodeForCanonicalKey,
  normalizeTitle,
};

