# 1Pondo Site Design

## Identifiers

```text
source / site_key = 1pondo
site_name         = 1Pondo
master_no        = m005
db_prefix        = onepondo
search_keyword   = 1pon
```

PostgreSQL unquoted identifiers cannot begin with a digit, so browser/API
source code remains `1pondo` while database objects use `onepondo`.

## Master Source

```text
https://www.1pondo.tv/dyn/phpauto/movie_lists/list_newest_{offset}.json
```

Offsets are `0, 50, 100 ... 4750`. The official JSON reports
`TotalRows = 4785` and `SplitSize = 50`; the final offset `4750` contains
35 rows. The collector reads `Rows` directly and does not render HTML.

The unique key is official `MovieID`, normally `MMDDYY_NNN`, for example
`060726_001`. One official legacy row uses an alphanumeric branch
(`081007_00a`), so implementation accepts `MMDDYY_XXX` for official keys while
the normal owned-file pattern remains numeric. `relation_key_mmddyy` keeps the
first six digits for secondary review only; exact `movie_code` matching is
preferred.

## JSON Fields

The master collector keeps the source row in `raw_payload` and maps:

```text
MovieID       -> movie_code
Title/TitleEn -> title
Release       -> release_date / release_date_text
Actor/ActressesJa/ActressesEn -> actor_name
UCNAME        -> channel_name
ThumbHigh/ThumbMed/MovieThumb/ThumbLow -> thumbnail_url
```

When needed, detail URL is derived as:

```text
https://www.1pondo.tv/movies/{MovieID}/
```

Thumbnail fallback is:

```text
https://www.1pondo.tv/moviepages/{MovieID}/images/str.jpg
```

## Directories

```text
storage/thumbnails/1pondo/master
?:\uncen\1pondo
?:\uncen\1pondo_new_mp4
?:\uncen\1pondo_trash
P:\uncen\1pondo_thumbnails
```

Files never move across NAS drives.

## Owned File Matching

Owned file collection searches NAS roots for file names containing `1pon`.
Matching extracts:

```text
([0-9]{6})[_-]([0-9]{3}) -> MMDDYY_NNN
```

Examples include `hhd800.com@051525_001-1PON`,
`1pondo-040525_001`, and `1pondo-090225_001-nyap2p.com`.
Files with only `MMDDYY` are treated as ambiguous unless a unique master match
already exists. Review CSV output is required before collect, complement,
rename, move, or owned DB registration.

## DL Reference

```text
https://hijav.net/category/jav-uncensored/1pondo/page/{page}/
```

Pages `1..117` are in scope. `page/118/` was confirmed as 404. HIJAV list
pages generally include Rapidgator and related links in the post body, so list
extraction is primary; detail-page fallback remains available when a list post
has no Rapidgator link.

## Browser

The browser source code is `1pondo`, with display name `1Pondo`. It uses:

```text
cl.onepondo_v_library_items
cl.onepondo_v_completion_items
cl.onepondo_v_thumbnail_assets
```

## Manual Operations

```text
P:\uncen\1pondo_new_master\1pondo_master_apply.bat
?:\uncen\1pondo_new_mp4\1pondo_owned_apply.bat
P:\uncen\1pondo_thumbnails\1pondo_manual_thumbnail_apply.bat
```

Manual thumbnail import accepts only `MMDDYY_NNN` image stems and validates the
image signature before replacing or adding the local thumbnail.

## Production Verification

```text
node --check apps/jobs/1pondo-pipeline.js
node --check apps/jobs/1pondo-owned-operations.js
node --check apps/jobs/import-onepondo-manual-thumbnails.js
node apps/jobs/1pondo-pipeline.js --step status
npm.cmd run smoke:browser:1pondo
```
