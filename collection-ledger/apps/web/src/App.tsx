import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  API_BASE,
  fetchCompletionItems,
  fetchLibraryItems,
  fetchSites,
  postOpenFile,
  postOpenFolder,
} from "./api";
import type { CompletionItem, LibraryItem, LibrarySortKey, SiteItem } from "./types";

type TabKey = "library" | "completion";

const PAGE_SIZE = 36;

function App() {
  const [tab, setTab] = useState<TabKey>("library");
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [source, setSource] = useState("paco");
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [completionItems, setCompletionItems] = useState<CompletionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    void loadAll(source);
  }, [source]);

  async function loadAll(nextSource: string) {
    setLoading(true);
    setErrorMessage("");
    try {
      const [nextSites, nextLibrary, nextCompletion] = await Promise.all([
        fetchSites(),
        fetchLibraryItems(nextSource),
        fetchCompletionItems(nextSource),
      ]);
      setSites(nextSites);
      setLibraryItems(nextLibrary);
      setCompletionItems(nextCompletion);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "load failed");
      setLibraryItems([]);
      setCompletionItems([]);
    } finally {
      setLoading(false);
    }
  }

  const selectedSite = sites.find((site) => site.siteCode === source);

  return (
    <div className="ledger-shell">
      <header className="ledger-tabs">
        <div className="ledger-brand">
          <strong>Collection Ledger</strong>
          <span>{selectedSite?.siteName || "pacopacomama"}</span>
        </div>

        <nav>
          <button
            type="button"
            className={tab === "library" ? "active" : ""}
            onClick={() => setTab("library")}
          >
            Local Library
          </button>
          <button
            type="button"
            className={tab === "completion" ? "active" : ""}
            onClick={() => setTab("completion")}
          >
            Completion
          </button>
        </nav>
      </header>

      {errorMessage && <div className="app-error">{errorMessage}</div>}

      {tab === "library" ? (
        <LocalLibraryPage
          source={source}
          sites={sites}
          items={libraryItems}
          loading={loading}
          onReload={() => void loadAll(source)}
          onSourceChange={setSource}
        />
      ) : (
        <CompletionPage
          source={source}
          sites={sites}
          items={completionItems}
          loading={loading}
          onReload={() => void loadAll(source)}
          onSourceChange={setSource}
        />
      )}
    </div>
  );
}

function LocalLibraryPage({
  source,
  sites,
  items,
  loading,
  onReload,
  onSourceChange,
}: {
  source: string;
  sites: SiteItem[];
  items: LibraryItem[];
  loading: boolean;
  onReload: () => void;
  onSourceChange: (source: string) => void;
}) {
  const [idInput, setIdInput] = useState("");
  const [titleInput, setTitleInput] = useState("");
  const [actorInput, setActorInput] = useState("");
  const [idQuery, setIdQuery] = useState("");
  const [titleQuery, setTitleQuery] = useState("");
  const [actorQuery, setActorQuery] = useState("");
  const [resolutionFilter, setResolutionFilter] = useState("all");
  const [sortKey, setSortKey] = useState<LibrarySortKey>("release_desc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [actionMessage, setActionMessage] = useState("");

  const filteredItems = useMemo(() => {
    const id = idQuery.trim().toLowerCase();
    const title = titleQuery.trim().toLowerCase();
    const actor = actorQuery.trim().toLowerCase();

    return [...items]
      .filter((item) => {
        if (resolutionFilter !== "all" && item.resolutionClass !== resolutionFilter) {
          return false;
        }
        if (id && !item.movieCode.toLowerCase().includes(id)) {
          return false;
        }
        if (title && !item.title.toLowerCase().includes(title)) {
          return false;
        }
        if (actor && !item.actorNames.toLowerCase().includes(actor)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => sortLibraryItems(a, b, sortKey));
  }, [actorQuery, idQuery, items, resolutionFilter, sortKey, titleQuery]);

  const stats = useMemo(() => {
    return {
      total: items.length,
      hd: items.filter((item) => item.resolutionClass === "hd").length,
      fourK: items.filter((item) => item.resolutionClass === "4k").length,
      low: items.filter((item) => item.resolutionClass === "low").length,
      sizeGb: items.reduce((sum, item) => sum + item.fileSizeGb, 0),
    };
  }, [items]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const pagedItems = filteredItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [actorQuery, idQuery, resolutionFilter, sortKey, titleQuery]);

  useEffect(() => {
    setPage((currentPage) => Math.min(Math.max(1, currentPage), totalPages));
  }, [totalPages]);

  function applySearch() {
    setIdQuery(idInput);
    setTitleQuery(titleInput);
    setActorQuery(actorInput);
  }

  function runSearchOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      applySearch();
    }
  }

  async function runOpen(action: "file" | "folder", item: LibraryItem) {
    setActionMessage("");
    try {
      if (action === "file") {
        await postOpenFile(item);
      } else {
        await postOpenFolder(item);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "open failed";
      setActionMessage(message);
      alert(message);
    }
  }

  return (
    <div className="library-page">
      <header className="page-topbar">
        <div>
          <h1>Local Library</h1>
          <p>所持ファイルをサムネイル、解像度、ファイルサイズ付きで確認します。</p>
        </div>
        <button type="button" className="icon-button" onClick={onReload} title="Reload">
          R
        </button>
      </header>

      <section className="library-controls">
        <select value={source} onChange={(event) => onSourceChange(event.target.value)}>
          {sites.map((site) => (
            <option key={site.siteCode} value={site.siteCode}>
              {site.siteName}
            </option>
          ))}
          {sites.length === 0 && <option value="paco">pacopacomama</option>}
        </select>
        <input
          value={idInput}
          onChange={(event) => setIdInput(event.target.value)}
          onKeyDown={runSearchOnEnter}
          placeholder="ID検索"
        />
        <input
          value={titleInput}
          onChange={(event) => setTitleInput(event.target.value)}
          onKeyDown={runSearchOnEnter}
          placeholder="タイトル検索"
        />
        <input
          value={actorInput}
          onChange={(event) => setActorInput(event.target.value)}
          onKeyDown={runSearchOnEnter}
          placeholder="出演者検索"
        />
        <select value={resolutionFilter} onChange={(event) => setResolutionFilter(event.target.value)}>
          <option value="all">All resolution</option>
          <option value="4k">4K</option>
          <option value="hd">HD</option>
          <option value="low">LOW</option>
        </select>
        <select value={sortKey} onChange={(event) => setSortKey(event.target.value as LibrarySortKey)}>
          <option value="release_desc">日付 降順</option>
          <option value="release_asc">日付 昇順</option>
          <option value="size_desc">サイズ 大きい順</option>
          <option value="size_asc">サイズ 小さい順</option>
          <option value="code_desc">ID 降順</option>
          <option value="code_asc">ID 昇順</option>
        </select>
      </section>

      <section className="summary-strip">
        <span>Total {filteredItems.length} / {stats.total}</span>
        <span>HD {stats.hd}</span>
        <span>4K {stats.fourK}</span>
        <span>LOW {stats.low}</span>
        <span>{stats.sizeGb.toFixed(1)} GB</span>
        <Pager page={page} totalPages={totalPages} onPage={setPage} />
      </section>

      {actionMessage && <div className="app-error compact">{actionMessage}</div>}

      {loading ? (
        <div className="loading-panel">Loading...</div>
      ) : (
        <main className="library-grid">
          {pagedItems.map((item) => (
            <article key={item.ownedFileId} className="library-card">
              <button type="button" className="thumb-button" onClick={() => setSelected(item)}>
                {item.thumbnailPath ? (
                  <img src={`${API_BASE}${item.thumbnailPath}`} alt="" loading="lazy" />
                ) : (
                  <span>No Thumb</span>
                )}
              </button>
              <div className="card-meta">
                <div className="card-id">{item.movieCode}</div>
                <div className="card-date">{item.releaseDate}</div>
                <div className="card-title" title={item.title}>{item.title}</div>
                <div className="card-actor" title={item.actorNames}>{item.actorNames || "出演者未設定"}</div>
                <div className="card-badges">
                  <span>{item.resolutionLabel}</span>
                  <span>{formatDimensions(item)}</span>
                  <span>{formatFileSize(item.fileSizeBytes)}</span>
                  <span>{item.driveLetter}:</span>
                </div>
              </div>
            </article>
          ))}
        </main>
      )}

      {selected && (
        <ItemDialog
          item={selected}
          onClose={() => setSelected(null)}
          onOpenFile={() => void runOpen("file", selected)}
          onOpenFolder={() => void runOpen("folder", selected)}
        />
      )}
    </div>
  );
}

function CompletionPage({
  source,
  sites,
  items,
  loading,
  onReload,
  onSourceChange,
}: {
  source: string;
  sites: SiteItem[];
  items: CompletionItem[];
  loading: boolean;
  onReload: () => void;
  onSourceChange: (source: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hideOwned, setHideOwned] = useState(false);
  const [page, setPage] = useState(1);

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return [...items]
      .filter((item) => (hideOwned ? !item.isOwned : true))
      .filter((item) => {
        if (!keyword) return true;
        return (
          item.movieCode.toLowerCase().includes(keyword) ||
          item.title.toLowerCase().includes(keyword) ||
          item.actorNames.toLowerCase().includes(keyword)
        );
      })
      .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || b.movieCode.localeCompare(a.movieCode));
  }, [hideOwned, items, query]);

  const stats = useMemo(() => {
    return {
      total: items.length,
      owned: items.filter((item) => item.isOwned).length,
      dl: items.filter((item) => !item.isOwned && item.hasDlReference).length,
      noDl: items.filter((item) => !item.isOwned && !item.hasDlReference).length,
    };
  }, [items]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const pagedItems = filteredItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [hideOwned, query, source]);

  useEffect(() => {
    setPage((currentPage) => Math.min(Math.max(1, currentPage), totalPages));
  }, [totalPages]);

  return (
    <div className="completion-page">
      <aside className="completion-sidebar">
        <div className="completion-header">
          <div>
            <h1>Completion</h1>
            <p>HPごとの全件一覧</p>
          </div>
          <button type="button" onClick={onReload}>Reload</button>
        </div>

        <div className="site-list">
          {(sites.length > 0 ? sites : [{ siteCode: "paco", siteName: "pacopacomama", siteId: 1, note: "" }]).map((site) => (
            <button
              key={site.siteCode}
              type="button"
              className={site.siteCode === source ? "site-row selected" : "site-row"}
              onClick={() => onSourceChange(site.siteCode)}
            >
              <span>{site.siteName}</span>
              <small>{site.siteCode}</small>
            </button>
          ))}
        </div>

        <div className="completion-side-stats">
          <div><span>Total</span><strong>{stats.total}</strong></div>
          <div><span>Owned</span><strong>{stats.owned}</strong></div>
          <div><span>DL</span><strong>{stats.dl}</strong></div>
          <div><span>No DL</span><strong>{stats.noDl}</strong></div>
        </div>
      </aside>

      <main className="completion-main">
        <section className="selected-panel">
          <div>
            <h2>{sites.find((site) => site.siteCode === source)?.siteName || "pacopacomama"}</h2>
            <p>所持済み、未所持DL可能、未所持DL不可を色分け表示します。</p>
          </div>
          <div className="selected-actions">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ID / タイトル / 出演者"
            />
            <button type="button" onClick={() => setHideOwned((value) => !value)}>
              {hideOwned ? "所持も表示" : `所持を除外 (${stats.owned})`}
            </button>
          </div>
        </section>

        <section className="summary-strip">
          <span>items {filteredItems.length} / {items.length}</span>
          <span>owned {stats.owned}</span>
          <span>downloadable {stats.dl}</span>
          <span>not available {stats.noDl}</span>
          <Pager page={page} totalPages={totalPages} onPage={setPage} />
        </section>

        {loading ? (
          <div className="loading-panel">Loading...</div>
        ) : (
          <div className="completion-list">
            {pagedItems.map((item) => (
              <CompletionCard key={item.movieCode} item={item} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function CompletionCard({ item }: { item: CompletionItem }) {
  const statusClass = item.isOwned
    ? "owned"
    : item.hasDlReference
      ? "downloadable"
      : "unavailable";
  const statusLabel = item.isOwned ? "所持済み" : item.hasDlReference ? "DL可能" : "DL不可";

  return (
    <article className={`completion-card ${statusClass}`}>
      <div className="completion-thumb">
        {item.thumbnailPath ? (
          <img src={`${API_BASE}${item.thumbnailPath}`} alt="" loading="lazy" />
        ) : (
          <span>No Thumb</span>
        )}
      </div>
      <div className="completion-text">
        <div className="completion-title-row">
          <span className={`completion-code ${statusClass}`}>{item.movieCode}</span>
          <span>{item.releaseDate}</span>
          <strong>{statusLabel}</strong>
        </div>
        <div className="completion-title" title={item.title}>{item.title}</div>
        <div className="completion-actors">{item.actorNames || "出演者未設定"}</div>
        <div className="completion-badges">
          {item.isOwned && <span>owned {item.ownedCount}</span>}
          {item.bestResolutionClass && <span>{item.bestResolutionLabel}</span>}
          {item.hasDlReference && <span>{item.dlFoundSource}</span>}
        </div>
      </div>
      <div className="completion-actions">
        <button
          type="button"
          disabled={!item.rapidgatorUrl}
          onClick={() => item.rapidgatorUrl && window.open(item.rapidgatorUrl, "_blank")}
        >
          RG
        </button>
        <button
          type="button"
          disabled={!item.linkHrefUrl}
          onClick={() => item.linkHrefUrl && window.open(item.linkHrefUrl, "_blank")}
        >
          LINK
        </button>
        <button
          type="button"
          disabled={!item.dlDetailUrl}
          onClick={() => item.dlDetailUrl && window.open(item.dlDetailUrl, "_blank")}
        >
          PAGE
        </button>
      </div>
    </article>
  );
}

function ItemDialog({
  item,
  onClose,
  onOpenFile,
  onOpenFolder,
}: {
  item: LibraryItem;
  onClose: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
}) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h2>{item.movieCode}</h2>
        <p>{item.releaseDate}</p>
        <p>{item.title}</p>
        <p>{item.actorNames || "出演者未設定"}</p>
        <p className="path">{item.filePath}</p>
        <div className="dialog-stats">
          <span>{item.resolutionLabel}</span>
          <span>{formatDimensions(item)}</span>
          <span>{formatFileSize(item.fileSizeBytes)}</span>
          <span>{item.probeStatus}</span>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onOpenFile}>Open file</button>
          <button type="button" onClick={onOpenFolder}>Open folder</button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function Pager({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="pager">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Prev
      </button>
      <span>{page} / {totalPages}</span>
      <button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}

function sortLibraryItems(a: LibraryItem, b: LibraryItem, sortKey: LibrarySortKey) {
  if (sortKey === "release_asc") return a.releaseDate.localeCompare(b.releaseDate);
  if (sortKey === "size_desc") return b.fileSizeBytes - a.fileSizeBytes;
  if (sortKey === "size_asc") return a.fileSizeBytes - b.fileSizeBytes;
  if (sortKey === "code_asc") return a.movieCode.localeCompare(b.movieCode);
  if (sortKey === "code_desc") return b.movieCode.localeCompare(a.movieCode);
  return b.releaseDate.localeCompare(a.releaseDate) || b.movieCode.localeCompare(a.movieCode);
}

function formatDimensions(item: LibraryItem) {
  if (!item.videoWidth || !item.videoHeight) return "-";
  return `${item.videoWidth}x${item.videoHeight}`;
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export default App;
