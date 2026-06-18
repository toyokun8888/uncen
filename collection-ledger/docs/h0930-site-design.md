# H0930 Site Design

## Identifiers

```text
source / site_key = h0930
site_name         = H0930
master_no        = m006
db_prefix        = h0930
search_keyword   = h0930
```

## Master Source

Use the official H0930 AJAX endpoint, not D2PASS:

```text
https://www.h0930.com/app/searchresult?site_id=4002&page={page}
```

The list page wrapper is:

```text
https://www.h0930.com/list.html?site_id=4002&page=1
```

The collector parses official movie links under `/moviepages/{code}/index.html`.
These code families are in scope:

```text
ori[0-9]+
gol[0-9]+
ki[0-9]+
pla[0-9]+
tk[0-9]+
orimrs[0-9]+
orijuku[0-9]+
```

Earlier investigation treated `ki[0-9]+` as separate, but the accepted H0930
scope includes it. Do not exclude `ki` from master or owned registration.

The official endpoint reports `全1817件` and `全61ページ` as of 2026-06-13.
Observed prefix totals are `ori=844`, `ki=6`, `gol=195`, `pla=104`,
`tk=56`, `orimrs=238`, and `orijuku=374`.
Full master collection must cover all 61 pages. Manual/differential collection
remains newest 3 pages.

## Thumbnails

Official list thumbnails are protocol-relative URLs such as:

```text
//www.h0930.com/moviepages/{code}/images/thumb_s.jpg
```

The fallback thumbnail URL is:

```text
https://www.h0930.com/moviepages/{code}/images/thumb_s.jpg
```

## Owned File Matching

Owned file collection searches NAS roots for file names containing `h0930`.
Manual import accepts the same official code extraction:

```text
better_h0930-ori1331_1.wmv -> ori1331
H0930-ori1696-1080p.mp4   -> ori1696
H0930-ori1687.mp4         -> ori1687
H0930-ki240718.mp4        -> ki240718
```

## Directories

```text
storage/thumbnails/h0930/master
?:\uncen\h0930
?:\uncen\h0930_new_mp4
?:\uncen\h0930_trash
P:\uncen\h0930_thumbnails
P:\uncen\h0930_new_master
```

Files never move across NAS drives.

## DL Reference

```text
https://hijav.net/category/jav-uncensored/h0930/page/{page}/
```

Pages `1..117` are in scope. List pages are the primary extraction source;
detail-page fallback remains disabled unless a one-off investigation needs it.

## Manual Operations

```text
P:\uncen\h0930_new_master\h0930_master_apply.bat
?:\uncen\h0930_new_mp4\h0930_owned_apply.bat
P:\uncen\h0930_thumbnails\h0930_manual_thumbnail_apply.bat
```

The manual master batch is differential and must fetch only the newest 3
official AJAX pages by default:

```text
node apps\jobs\h0930-pipeline.js --step master --max-pages 3
```

After `owned-apply` registers files, `h0930-owned-operations.js` runs:

```text
node apps\jobs\collect-video-metadata.js --source h0930 --step collect
```

The browser 4K/HD/LOW labels therefore come from ffprobe video dimensions, not
from file names.
