"use strict";

const fs = require("fs");
const path = require("path");
const { getSourceConfig } = require("./source-registry");

const THUMBNAIL_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const STORAGE_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "storage");

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeResolutionLabel(value) {
  if (value === "4k") return "4K";
  if (value === "hd") return "HD";
  if (value === "low") return "LOW";
  return "UNKNOWN";
}

function splitPipeList(value) {
  return String(value || "")
    .split(" | ")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapLibraryRow(row) {
  const resolutionClass = String(row.resolution_class || "");
  const source = String(row.site_code || "paco");
  const movieCode = String(row.movie_code || "");
  return {
    ownedFileId: toNumber(row.owned_file_id),
    source,
    siteName: String(row.site_name || ""),
    movieCode,
    releaseDate: String(row.release_date_text || ""),
    title: String(row.title || ""),
    actorNames: String(row.actor_names || ""),
    filePath: String(row.file_path || ""),
    fileName: String(row.file_name || ""),
    fileExt: String(row.file_ext || ""),
    driveLetter: String(row.drive_letter || ""),
    fileSizeBytes: toNumber(row.file_size_bytes),
    fileSizeGb: Number(row.file_size_gb || 0),
    fileMtime: row.file_mtime || null,
    videoWidth: toNumber(row.video_width),
    videoHeight: toNumber(row.video_height),
    resolutionClass,
    resolutionLabel: normalizeResolutionLabel(resolutionClass),
    probeStatus: String(row.probe_status || "pending"),
    thumbnailPath: hasThumbnail(source, movieCode, row.local_thumbnail_path)
      ? `/api/library/thumbnail/${source}/${movieCode}`
      : "",
    thumbnailStatus: String(row.thumbnail_status || "unknown"),
  };
}

function mapCompletionRow(row) {
  const bestResolutionClass = String(row.best_resolution_class || "");
  const source = String(row.site_code || "paco");
  const movieCode = String(row.movie_code || "");
  return {
    source,
    siteName: String(row.site_name || ""),
    movieCode,
    releaseDate: String(row.release_date_text || ""),
    title: String(row.title || ""),
    actorNames: String(row.actor_names || ""),
    detailUrl: String(row.detail_url || ""),
    thumbnailPath: hasThumbnail(source, movieCode, row.local_thumbnail_path)
      ? `/api/library/thumbnail/${source}/${movieCode}`
      : "",
    thumbnailStatus: String(row.thumbnail_status || "unknown"),
    isOwned: Boolean(row.is_owned),
    ownedCount: toNumber(row.owned_count),
    ownedFilePaths: splitPipeList(row.owned_file_paths),
    bestResolutionClass,
    bestResolutionLabel: normalizeResolutionLabel(bestResolutionClass),
    has4k: Boolean(row.has_4k),
    hasHd: Boolean(row.has_hd),
    hasDlReference: Boolean(row.has_dl_reference),
    rapidgatorUrl: String(row.rapidgator_url || ""),
    linkHrefUrl: String(row.link_href_url || ""),
    dlDetailUrl: String(row.dl_detail_url || ""),
    dlFoundSource: String(row.dl_found_source || ""),
  };
}

async function listLibraryItems(db, source) {
  const config = getSourceConfig(source);
  const result = await db.query(
    `
      select *
      from ${config.libraryView}
      order by release_date desc, movie_code desc, owned_file_id desc
    `
  );
  return result.rows.map(mapLibraryRow);
}

async function listCompletionItems(db, source) {
  const config = getSourceConfig(source);
  const result = await db.query(
    `
      select *
      from ${config.completionView}
      order by release_date desc, movie_code desc
    `
  );
  return result.rows.map(mapCompletionRow);
}

async function resolveThumbnailPath(db, source, movieCode) {
  const config = getSourceConfig(source);
  const result = await db.query(
    `
      select local_thumbnail_path
      from ${config.thumbnailTable}
      where movie_code = $1
        and coalesce(local_thumbnail_path, '') <> ''
        and thumbnail_status = 'collected'
      limit 1
    `,
    [movieCode]
  );
  return result.rows[0]?.local_thumbnail_path || findThumbnailFile(source, movieCode);
}

function hasThumbnail(source, movieCode, dbPath) {
  if (dbPath) return true;
  return Boolean(findThumbnailFile(source, movieCode));
}

function findThumbnailFile(source, movieCode) {
  const safeSource = String(source || "").replace(/[^a-z0-9_-]/gi, "");
  const safeMovieCode = String(movieCode || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safeSource || !safeMovieCode) return "";

  const directory = path.join(STORAGE_ROOT, "thumbnails", safeSource, "master");
  for (const extension of THUMBNAIL_EXTENSIONS) {
    const candidate = path.join(directory, `${safeMovieCode}${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

async function resolveOwnedFilePath(db, source, ownedFileId, fallbackPath) {
  const config = getSourceConfig(source);
  if (fallbackPath) {
    const result = await db.query(
      `
        select file_path
        from ${config.ownedTable}
        where file_path = $1
        limit 1
      `,
      [String(fallbackPath)]
    );
    return result.rows[0]?.file_path || "";
  }

  const result = await db.query(
    `
      select file_path
      from ${config.ownedTable}
      where owned_file_id = $1
      limit 1
    `,
    [ownedFileId]
  );
  return result.rows[0]?.file_path || "";
}

module.exports = {
  listCompletionItems,
  listLibraryItems,
  resolveOwnedFilePath,
  resolveThumbnailPath,
};
