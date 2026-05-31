"use strict";

const express = require("express");

function createSitesRouter(db) {
  const router = express.Router();

  router.get("/", async (_req, res) => {
    try {
      const result = await db.query(
        `
          select site_id, site_code, site_name, note
          from cl.site_master
          order by site_id asc
        `
      );
      res.json({
        ok: true,
        sites: result.rows.map((row) => ({
          siteId: Number(row.site_id),
          siteCode: String(row.site_code || ""),
          siteName: String(row.site_name || ""),
          note: String(row.note || ""),
        })),
      });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  });

  return router;
}

module.exports = {
  createSitesRouter,
};
