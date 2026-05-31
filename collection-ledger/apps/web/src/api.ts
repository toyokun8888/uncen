import type {
  ApiCompletionResponse,
  ApiLibraryResponse,
  ApiSitesResponse,
  CompletionItem,
  LibraryItem,
  SiteItem,
} from "./types";

export const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ||
  (import.meta.env.VITE_API_BASE as string | undefined) || "http://127.0.0.1:3103";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  const body = (await response.json()) as T & { ok?: boolean; message?: string };
  if (body.ok === false) {
    throw new Error(body.message || `API failed: ${url}`);
  }
  return body;
}

export async function fetchSites(): Promise<SiteItem[]> {
  const body = await getJson<ApiSitesResponse>(`${API_BASE}/api/sites`);
  return body.sites || [];
}

export async function fetchLibraryItems(source: string): Promise<LibraryItem[]> {
  const body = await getJson<ApiLibraryResponse>(
    `${API_BASE}/api/library/items?source=${encodeURIComponent(source)}`
  );
  return body.items || [];
}

export async function fetchCompletionItems(source: string): Promise<CompletionItem[]> {
  const body = await getJson<ApiCompletionResponse>(
    `${API_BASE}/api/completion/items?source=${encodeURIComponent(source)}`
  );
  return body.items || [];
}

export async function postOpenFile(item: Pick<LibraryItem, "ownedFileId" | "source">) {
  await postOpen("/api/library/open-file", item);
}

export async function postOpenFolder(item: Pick<LibraryItem, "ownedFileId" | "source">) {
  await postOpen("/api/library/open-folder", item);
}

async function postOpen(
  endpoint: string,
  item: Pick<LibraryItem, "ownedFileId" | "source">
) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: item.source,
      ownedFileId: item.ownedFileId,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    message?: string;
  };

  if (!response.ok || !body.ok) {
    throw new Error(body.message || `HTTP ${response.status}`);
  }
}
