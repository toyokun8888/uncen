"use strict";

const express = require("express");

function createHealthRouter(db, envFileLoaded) {
  const router = express.Router();

  router.get("/", async (_req, res) => {
    try {
      await db.query("select 1");
      res.json({
        ok: true,
        app: "collection-ledger-api",
        envFileLoaded: Boolean(envFileLoaded),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error.message,
      });
    }
  });

  return router;
}

module.exports = {
  createHealthRouter,
};
