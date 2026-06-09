"use strict";

const SOURCE_CONFIGS = {
  paco: {
    source: "paco",
    siteCode: "paco",
    libraryView: "cl.paco_v_library_items",
    completionView: "cl.paco_v_completion_items",
    thumbnailTable: "cl.paco_m001_thumbnail_assets",
    ownedTable: "cl.paco_owned_file",
    videoMetadataTable: "cl.paco_owned_file_video_metadata",
  },
  heydouga_4017: {
    source: "heydouga_4017",
    siteCode: "heydouga_4017",
    libraryView: "cl.heydouga_4017_v_library_items",
    completionView: "cl.heydouga_4017_v_completion_items",
    thumbnailTable: "cl.heydouga_4017_v_thumbnail_assets",
    ownedTable: "cl.heydouga_4017_owned_file",
    videoMetadataTable: "cl.heydouga_4017_owned_file_video_metadata",
  },
  "10musume": {
    source: "10musume",
    siteCode: "10musume",
    libraryView: "cl.tenmusume_v_library_items",
    completionView: "cl.tenmusume_v_completion_items",
    thumbnailTable: "cl.tenmusume_v_thumbnail_assets",
    ownedTable: "cl.tenmusume_owned_file",
    videoMetadataTable: "cl.tenmusume_owned_file_video_metadata",
  },
  heyzo: {
    source: "heyzo",
    siteCode: "heyzo",
    libraryView: "cl.heyzo_v_library_items",
    completionView: "cl.heyzo_v_completion_items",
    thumbnailTable: "cl.heyzo_v_thumbnail_assets",
    ownedTable: "cl.heyzo_owned_file",
    videoMetadataTable: "cl.heyzo_owned_file_video_metadata",
  },
  "1pondo": {
    source: "1pondo",
    siteCode: "1pondo",
    libraryView: "cl.onepondo_v_library_items",
    completionView: "cl.onepondo_v_completion_items",
    thumbnailTable: "cl.onepondo_v_thumbnail_assets",
    ownedTable: "cl.onepondo_owned_file",
    videoMetadataTable: "cl.onepondo_owned_file_video_metadata",
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
