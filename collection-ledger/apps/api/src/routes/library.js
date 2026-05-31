"use strict";

const fs = require("fs");
const express = require("express");
const {
  isPathUnderRoots,
  normalizeWindowsPath,
  resolveThumbnailRoots,
} = require("../utils/path-guard");
const {
  listLibraryItems,
  resolveOwnedFilePath,
  resolveThumbnailPath,
} = require("../services/library-service");
const { openFile, openFolder } = require("../services/media-open-service");

function createLibraryRouter(db) {
  const router = express.Router();

  router.get("/items", async (req, res) => {
    try {
      const source = String(req.query.source || "paco");
      const items = await listLibraryItems(db, source);
      res.json({ ok: true, source, items });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message, items: [] });
    }
  });

  router.get("/thumbnail/:source/:movieCode", async (req, res) => {
    try {
      const thumbnailPath = await resolveThumbnailPath(db, req.params.source, req.params.movieCode);
      if (!thumbnailPath) {
        res.status(404).json({ ok: false, message: "thumbnail_not_found" });
        return;
      }

      const normalized = normalizeWindowsPath(thumbnailPath);
      if (!isPathUnderRoots(normalized, resolveThumbnailRoots())) {
        res.status(403).json({ ok: false, message: "thumbnail_path_not_allowed" });
        return;
      }

      if (!fs.existsSync(normalized)) {
        res.status(404).json({ ok: false, message: "thumbnail_file_not_exists" });
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeForImage(normalized));
      fs.createReadStream(normalized).pipe(res);
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  });

  router.post("/open-file", async (req, res) => {
    try {
      const source = String(req.body.source || "paco");
      const filePath = await resolveOwnedFilePath(db, source, req.body.ownedFileId, req.body.filePath);
      if (!filePath) {
        res.status(404).json({ ok: false, message: "file_path_not_found" });
        return;
      }
      await openFile(filePath);
      res.json({ ok: true, mode: "file" });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  });

  router.post("/open-folder", async (req, res) => {
    try {
      const source = String(req.body.source || "paco");
      const filePath = await resolveOwnedFilePath(db, source, req.body.ownedFileId, req.body.filePath);
      if (!filePath) {
        res.status(404).json({ ok: false, message: "file_path_not_found" });
        return;
      }
      await openFolder(filePath);
      res.json({ ok: true, mode: "folder" });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  });

  return router;
}

function contentTypeForImage(filePath) {
  const ext = String(filePath).split(".").pop().toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

module.exports = {
  createLibraryRouter,
};
