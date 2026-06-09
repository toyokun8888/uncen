# HEYZO Site Design

## Identifiers

```text
source / site_key = heyzo
site_name         = HEYZO
master_no        = m004
db_prefix        = heyzo
search_keyword   = heyzo
```

## Master Source

```text
https://www.heyzo.com/listpages/all_{page}.html
```

The official list page exposes stable `data-movie-id` values and detail links
such as `/moviepages/3401/index.html`. The collector reads the static list HTML
with Cheerio; Puppeteer is not required.

`movie_code` is normalized as `heyzo-{numeric_id}` for browser display and file
names. The old compatibility column `relation_key_mmddyy` stores the numeric
HEYZO id without zero padding, and is used only as a secondary match key.

## Directories

```text
storage/thumbnails/heyzo/master
?:\uncen\heyzo
?:\uncen\heyzo_new_mp4
?:\uncen\heyzo_trash
P:\uncen\heyzo_thumbnails
```

Files never move across NAS drives.

## Owned File Matching

Owned file names vary, including examples such as:

```text
heyzo-3401-1080p
heyzo-1717-vol-11_720p
heyzo-26452_1080p
```

Matching extracts `heyzo` plus a numeric id, ignores resolution and volume
tokens, normalizes the id to `heyzo-{number}`, and compares against the official
master table. Review CSV output is required before collection, rename, move, or
DB update. Master complement is intentionally a no-op for HEYZO because the
official list is the source of truth.

## DL Reference

```text
https://hijav.net/category/jav-uncensored/heyzo/page/{page}/
```

Rapidgator display URLs and href URLs are both retained. List pages are used
first, with detail page fallback when a list entry has no Rapidgator link. Only
a single resolved master candidate is marked as `matched_master`. A full run
probes the page after `--max-pages` and commits only when that page is HTTP 404.

## Browser

The browser source code is `heyzo`, with display name `HEYZO`. It uses the
common library and completion API through:

```text
cl.heyzo_v_library_items
cl.heyzo_v_completion_items
```

## Manual Operations

```text
P:\uncen\heyzo_new_master\heyzo_master_apply.bat
?:\uncen\heyzo_new_mp4\heyzo_owned_apply.bat
P:\uncen\heyzo_thumbnails\heyzo_manual_thumbnail_apply.bat
```

Manual thumbnail import accepts names such as `heyzo-3401.jpg`,
`heyzo_3401.png`, or `3401.webp`, validates the image signature, and restores
the previous thumbnail if the DB update fails.

## Production Browser Verification

After changing the API source registry or Web UI, restart both production PM2
processes and run the Chromium smoke test.

```text
pm2.cmd restart always-collection-ledger-api
pm2.cmd restart always-collection-ledger-web
npm.cmd run smoke:browser:heyzo
```

The smoke test opens `http://127.0.0.1:5173/`, selects `heyzo`, verifies Local
Library and Completion cards, and fails on browser console errors or HTTP
responses with status 400 or higher.
