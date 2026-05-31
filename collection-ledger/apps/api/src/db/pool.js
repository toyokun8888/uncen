"use strict";

const { Pool } = require("pg");

function requireDbValue(primaryName, fallbackName) {
  const value = process.env[primaryName] || process.env[fallbackName];
  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${primaryName}/${fallbackName} is not configured`);
  }
  return value;
}

function createPool() {
  return new Pool({
    host: process.env.PGHOST || process.env.DB_HOST || "localhost",
    port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
    database: requireDbValue("PGDATABASE", "DB_NAME"),
    user: requireDbValue("PGUSER", "DB_USER"),
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD,
  });
}

module.exports = {
  createPool,
};
