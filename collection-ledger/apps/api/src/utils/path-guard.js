"use strict";

const path = require("path");

function normalizeWindowsPath(targetPath) {
  const raw = String(targetPath || "").trim().replace(/\//g, "\\");
  const withoutLeadingSlash = raw.replace(/^[\\]+([A-Za-z]:)/, "$1");
  const fixedDrive = withoutLeadingSlash.replace(/^([A-Za-z]):(?![\\])/, "$1:\\");
  return path.normalize(fixedDrive).replace(/\//g, "\\");
}

function resolveAllowedMediaRoots() {
  const raw = String(process.env.MEDIA_ALLOWED_ROOTS || "").trim();
  const defaultRoots = [
    ...["D", "E", "F", "G", "H", "I", "J", "K", "L", "N", "P", "Q"].map((drive) => `${drive}:\\uncen`),
    "G:\\all\\お気に入りD(F)\\新規DL\\月極\\東熱",
    "N:\\NEWRG\\4K_TokyoHot",
    "L:\\all\\LONG\\Tokyo-Hot-n0001-500",
    "N:\\25.12\\newtokyohot\\N",
    "H:\\all\\保存\\2020.01.06\\月極\\カリビアン",
    "H:\\all\\保存\\2020.01.06\\月極\\マンコ図鑑",
  ];
  if (raw) {
    const configuredRoots = raw
      .split(";")
      .map((value) => normalizeWindowsPath(value.trim()))
      .filter(Boolean);
    return [...new Set([...configuredRoots, ...defaultRoots])];
  }

  return defaultRoots;
}

function resolveThumbnailRoots() {
  const raw = String(process.env.THUMBNAIL_ALLOWED_ROOTS || "").trim();
  const defaultRoots = [normalizeWindowsPath(path.resolve(__dirname, "..", "..", "..", "..", "storage", "thumbnails"))];
  if (raw) {
    const configuredRoots = raw
      .split(";")
      .map((value) => normalizeWindowsPath(value.trim()))
      .filter(Boolean);
    return [...new Set([...configuredRoots, ...defaultRoots])];
  }

  return defaultRoots;
}

function isPathUnderRoots(targetPath, roots) {
  const normalized = normalizeWindowsPath(targetPath).toLowerCase();
  return roots.some((root) => {
    const rootLower = normalizeWindowsPath(root).toLowerCase().replace(/[\\]+$/, "");
    return normalized === rootLower || normalized.startsWith(`${rootLower}\\`);
  });
}

module.exports = {
  isPathUnderRoots,
  normalizeWindowsPath,
  resolveAllowedMediaRoots,
  resolveThumbnailRoots,
};
