# Caribbeancom Site Design

## Identifiers

```text
source / site_key = carib
site_name         = カリビアンコム
official_name     = Caribbeancom
master_no         = m007
db_prefix         = carib
search_keyword    = carib
```

## Master Source

```text
https://www.caribbeancom.com/listpages/all{page}.htm
```

Pages `1..208` are in scope. `all208.htm` returns HTTP 200 and `all209.htm`
returns HTTP 404 as checked on 2026-06-15.

The source HTML is EUC-JP. The collector must decode it before parsing.

The official list page exposes movie links in this form:

```text
/moviepages/061426-001/index.html
/moviepages/112615_429/index.html
```

`movie_code` is normalized to a hyphen separator for DB and file matching:

```text
061426-001
112615-429
```

The original code and official detail URL are kept in raw payload and
`detail_url`. The UI does not need to expose the official detail URL, but DB
keeps it for traceability.

The list page provides title, release date, actor, thumbnail URL, and detail
URL, so detail-page fetch is not required for master collection.

## Thumbnails

List thumbnails are available from the official list page. Store collected
thumbnails under:

```text
storage/thumbnails/carib/master
```

Manual thumbnails use:

```text
P:\uncen\carib_thumbnails
```

The file stem must be the normalized `movie_code`.

## Owned File Matching

Normal owned file examples:

```text
Carib-040225-001-.mp4
041525-001-carib.mp4
Carib-091225-001-nyap2p.com.mp4
hhd800.com@070925-001-CARIB.mp4
```

Normal matching extracts `MMDDYY-NNN`, normalizes to `movie_code`, and compares
against the official master. Matched normal files may be renamed to:

```text
{movie_code}_{title}_{actor}.{ext}
```

## Exception Folder

Exception folder:

```text
H:\all\保存\2020.01.06\月極\カリビアン
```

This folder contains only Caribbeancom files and should be treated as owned,
but file names do not contain official movie codes. File names generally begin
with a date and title:

```text
2020.12.10 あばずれサンタアンソロジー 千野くるみ 杏 つくし 鈴木茶織 楠カリン.mp4
```

Exception folder files must keep their original file names. Matching uses:

1. date prefix to restrict master candidates
2. title similarity against master title and actor text
3. CSV review for uncertain rows

Only confirmed matches are inserted into `cl.carib_owned_file`. Uncertain rows
must not be renamed or moved.

For uncertain rows, the review CSV exposes:

```text
manual_movie_code
review_status
```

Human-approved rows must set `manual_movie_code` to a normalized or
underscore-separated code such as `061426-001` or `061426_001`, and
`review_status` to `approved`. The ready/apply steps verify that the master
exists and that the file path, size, mtime, and exception-folder scope still
match the review CSV.

## DL Reference

```text
https://hijav.net/category/jav-uncensored/caribbeancom/page/{page}/
```

Pages `1..222` are in scope. `page/222/` returns HTTP 200 and `page/223/`
returns HTTP 404 as checked on 2026-06-15.

Recent pages expose Rapidgator links on list pages. Older pages may require
detail-page fallback. Therefore DL reference collection uses list extraction
first and detail fallback only when no Rapidgator link is found in the list
entry.

## Browser

The browser source code is `carib`, with display name `カリビアンコム`. It uses:

```text
cl.carib_v_library_items
cl.carib_v_completion_items
cl.carib_v_thumbnail_assets
```

## Manual Operations

```text
P:\uncen\carib_new_master\carib_master_apply.bat
?:\uncen\carib_new_mp4\carib_owned_apply.bat
ops\batches\carib_exception_apply.bat
P:\uncen\carib_thumbnails\carib_manual_thumbnail_apply.bat
```

The manual master batch is differential and should fetch only the newest 3
official list pages by default:

```text
node apps\jobs\carib-pipeline.js --step master --max-pages 3
```

After `owned-apply` or `exception-apply` registers files,
`carib-owned-operations.js` runs:

```text
node apps\jobs\collect-video-metadata.js --source carib --step collect
```

Browser 4K/HD/LOW labels must come from ffprobe video dimensions, not file
names.
