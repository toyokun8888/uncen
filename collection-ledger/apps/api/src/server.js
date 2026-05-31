"use strict";

const express = require("express");
const cors = require("cors");
const { createPool } = require("./db/pool");
const { getPort, loadEnvFile, parseArgs } = require("./config/env");
const { createCompletionRouter } = require("./routes/completion");
const { createHealthRouter } = require("./routes/health");
const { createLibraryRouter } = require("./routes/library");
const { createSitesRouter } = require("./routes/sites");

async function main() {
  const args = parseArgs(process.argv);
  const envFileLoaded = loadEnvFile(args.envFile);
  const db = createPool();
  await db.query("select 1");

  const app = express();
  app.use(
    cors({
      origin: [
        "http://localhost",
        "http://127.0.0.1",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
      ],
    })
  );
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/health", createHealthRouter(db, envFileLoaded));
  app.use("/api/sites", createSitesRouter(db));
  app.use("/api/library", createLibraryRouter(db));
  app.use("/api/completion", createCompletionRouter(db));

  app.use((_req, res) => {
    res.status(404).json({ ok: false, message: "not_found" });
  });

  const port = getPort();
  app.listen(port, "127.0.0.1", () => {
    console.log(`collection-ledger API started: http://127.0.0.1:${port}`);
    console.log(`env file: ${envFileLoaded || "(none)"}`);
  });
}

main().catch((error) => {
  console.error("collection-ledger API failed");
  console.error(error);
  process.exitCode = 1;
});
