"use strict";

const SOURCE_CONFIGS = {
  paco: {
    source: "paco",
    siteCode: "paco",
    libraryView: "cl.paco_v_library_items",
    completionView: "cl.paco_v_completion_items",
    thumbnailTable: "cl.paco_m001_thumbnail_assets",
    ownedTable: "cl.paco_owned_file",
  },
};

function getSourceConfig(source) {
  const key = String(source || "paco").trim().toLowerCase();
  const config = SOURCE_CONFIGS[key];
  if (!config) {
    throw new Error(`unsupported_source:${key}`);
  }
  return config;
}

module.exports = {
  getSourceConfig,
  SOURCE_CONFIGS,
};
