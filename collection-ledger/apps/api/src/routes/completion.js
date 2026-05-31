"use strict";

const express = require("express");
const { listCompletionItems } = require("../services/library-service");

function createCompletionRouter(db) {
  const router = express.Router();

  router.get("/items", async (req, res) => {
    try {
      const source = String(req.query.source || "paco");
      const items = await listCompletionItems(db, source);
      res.json({ ok: true, source, items });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message, items: [] });
    }
  });

  return router;
}

module.exports = {
  createCompletionRouter,
};
