# 10musume Site Design

## Identifiers

```text
source / site_key = 10musume
site_name         = 天然むすめ
master_no        = m003
db_prefix        = tenmusume
search_keyword   = 10mu
```

PostgreSQL unquoted identifiers cannot begin with a digit, so the external
source remains `10musume` while the database prefix is `tenmusume`.

## Master Source

```text
https://www.10musume.com/list/?page={page}&o=newest
```

The site is a JavaScript application. The master collector renders the list
page with Puppeteer and reads the visible movie cards.

The six digit date-like value is retained as `relation_key_mmddyy`. It is not
assumed to be unique. The movie ID exposed by the site is the formal
`movie_code` and is used as the master unique key.

## Directories

```text
storage/thumbnails/10musume/master
?:\uncen\10musume
?:\uncen\10musume_new_mp4
?:\uncen\10musume_trash
P:\uncen\10musume_thumbnails
```

Files never move across NAS drives.

## Owned File Matching

Owned file names vary, including examples such as:

```text
111924_01-10mu-1080p
112021_01-10mu
10musume-010219_1080p
manami-sasaki-010316-01-10mu-1080p_1080p
```

Matching extracts a six digit date plus an optional numeric branch, normalizes
`-` and `_`, and compares candidates against the formal master movie code.
Review CSV output is required before collection, rename, move, or DB update.
Apply commands regenerate the current plan and compare important CSV columns
before making changes. Files are renamed only within the same drive. Owned DB
registration uses a transaction, and moved files are returned to their source
path when registration fails.

## DL Reference

```text
https://hijav.net/category/jav-uncensored/10musume/page/{page}/
```

Rapidgator display URLs and href URLs are both retained. List pages are used
first, with detail page fallback when a list entry has no Rapidgator link.
Only a single resolved master candidate is marked as `matched_master`. A full
run also probes the page after `--max-pages` and commits only when that page is
HTTP 404.

## Browser

The browser source code is `10musume`, with display name `天然むすめ`. It uses
the common library and completion API through:

```text
cl.tenmusume_v_library_items
cl.tenmusume_v_completion_items
```

## Manual Operations

```text
P:\uncen\10musume_new_master\10musume_master_apply.bat
?:\uncen\10musume_new_mp4\10musume_owned_apply.bat
P:\uncen\10musume_thumbnails\10musume_manual_thumbnail_apply.bat
```

Manual thumbnail import requires a review CSV, validates the image signature,
and restores the previous thumbnail if the DB update fails.

## Production Browser Verification

After changing the API source registry or Web UI, restart both production PM2
processes and run the Chromium smoke test.

```text
pm2.cmd restart always-collection-ledger-api
pm2.cmd restart always-collection-ledger-web
npm.cmd run smoke:browser:10musume
```

The smoke test opens `http://127.0.0.1:5173/`, selects `10musume`, verifies
Local Library and Completion cards, and fails on browser console errors or HTTP
responses with status 400 or higher.

## Initial Execution Result

As of 2026-06-04:

```text
official master rows       = 3305
owned-file master additions = 16
total master rows          = 3321
owned files registered     = 253
unmatched owned files held = 3
thumbnail rows collected   = 3306
thumbnail rows failed      = 15
DL reference rows          = 2252
DL matched master rows     = 2099
DL missing master rows held = 153
```

The three held files are intentionally not registered because their movie code
cannot be resolved safely from the filename.

The 15 thumbnail failures have no remaining pending rows and can be supplied
through the manual thumbnail folder. DL rows marked `missing_master` are kept
for review and are not exposed as matched download links.

After deploying the API source registry change, restart any already-running API
process. An old process continues to return `unsupported_source:10musume` even
though the database site row and views are present.

## Initial Production Run

The initial production run on 2026-06-04 produced:

```text
master rows        = 3321
raw official rows  = 3305
owned files        = 253
collected files    = 256
manual review      = 3
```

The 16 master rows beyond the official raw count were reviewed additions from
explicit owned-file codes. The three files left for manual review do not have a
safe unique master match:

```text
F:\uncen\10musume\10musume-010319_1080p.mp4
H:\uncen\10musume\10musume-the-structure-of-woman_1080p.mp4
H:\uncen\10musume\10musume1080p 素人のお仕事 〜先生や患者とやりまくってる超ナイスボディの歯科助手〜橋本知世.mp4
```

Do not rename or register these files until a formal `movie_code` is confirmed.
