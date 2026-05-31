export type SiteItem = {
  siteId: number;
  siteCode: string;
  siteName: string;
  note: string;
};

export type LibraryItem = {
  ownedFileId: number;
  source: string;
  siteName: string;
  movieCode: string;
  releaseDate: string;
  title: string;
  actorNames: string;
  filePath: string;
  fileName: string;
  fileExt: string;
  driveLetter: string;
  fileSizeBytes: number;
  fileSizeGb: number;
  fileMtime: string | null;
  videoWidth: number;
  videoHeight: number;
  resolutionClass: string;
  resolutionLabel: string;
  probeStatus: string;
  thumbnailPath: string;
  thumbnailStatus: string;
};

export type CompletionItem = {
  source: string;
  siteName: string;
  movieCode: string;
  releaseDate: string;
  title: string;
  actorNames: string;
  detailUrl: string;
  thumbnailPath: string;
  thumbnailStatus: string;
  isOwned: boolean;
  ownedCount: number;
  ownedFilePaths: string[];
  bestResolutionClass: string;
  bestResolutionLabel: string;
  has4k: boolean;
  hasHd: boolean;
  hasDlReference: boolean;
  rapidgatorUrl: string;
  linkHrefUrl: string;
  dlDetailUrl: string;
  dlFoundSource: string;
};

export type ApiSitesResponse = {
  ok: boolean;
  sites: SiteItem[];
  message?: string;
};

export type ApiLibraryResponse = {
  ok: boolean;
  source: string;
  items: LibraryItem[];
  message?: string;
};

export type ApiCompletionResponse = {
  ok: boolean;
  source: string;
  items: CompletionItem[];
  message?: string;
};

export type LibrarySortKey =
  | "release_desc"
  | "release_asc"
  | "size_desc"
  | "size_asc"
  | "code_asc"
  | "code_desc";
