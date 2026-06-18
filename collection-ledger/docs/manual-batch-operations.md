# Manual Batch Operations

This document records reusable patterns for small-site manual operations.
Use these patterns after the site master, owned-file table, browser views, and
API source registry are ready.

The purpose is to let a human add files at any time without editing the
database directly, while keeping the browser library accurate.

## 1. Core Principle

Keep the processing logic in one job under `apps/jobs`.

Batch files placed on NAS folders must only call that shared job. Do not copy
site logic into every batch file. This keeps all NAS folders on the same
validation rules and makes later fixes apply everywhere.

Every manual batch operation must have:

- a stable input directory
- a stable destination directory
- a documented file naming rule
- a `review` or dry-run step
- a CSV result log
- an `apply` step that stops on unsafe rows
- an idempotent database update
- a recovery path for interrupted execution

Before reporting completion, verify only with command output:

- file/folder placement: `Test-Path` or `Get-ChildItem`
- batch parameters: `Select-String`
- JavaScript syntax: `node --check`
- running jobs: process check when relevant

End with a direct request checklist: each requested item is either `done` with
the verification source above, or `not done`. Do not mark inferred work as done.

Keep initial/full-crawl commands separate from manual/differential commands.
Manual batches must use the documented differential limits unless the operator
explicitly asks for a one-off rebuild.

## 2. Site Variables

Decide these values before implementing a new site:

```text
site_key
master_table
owned_table
thumbnail_output_dir
manual_thumbnail_input_dir
owned_input_dir_per_nas
owned_target_dir_per_nas
unique_key_file_name_rule
```

Example:

```text
site_key                   = heydouga_4017
master_table               = cl.heydouga_4017_m002_master
owned_table                = cl.heydouga_4017_owned_file
thumbnail_output_dir       = storage/thumbnails/heydouga_4017/master
manual_thumbnail_input_dir = P:\uncen\heydouga_4017_thumbnails
owned_input_dir_per_nas    = ?:\uncen\heydouga_4017_new_mp4
owned_target_dir_per_nas   = ?:\uncen\heydouga_4017
```

## 3. Manual Thumbnail Import

### Directory

Create one manual thumbnail input directory:

```text
P:\uncen\{site_key}_thumbnails
```

Place a double-click batch file in that directory.

### File Naming Rule

The image file stem must be the master unique key:

```text
{unique_key}.jpg
{unique_key}.png
{unique_key}.webp
```

Examples:

```text
108-14.jpg
047.png
250-a.webp
```

The final thumbnail file name must use the same unique key naming rule as
automatically collected thumbnails.

### Processing Flow

1. Scan image files under the manual input directory.
2. Read the unique key from the file stem.
3. Confirm that the key exists in the site master.
4. Stop if the key is invalid, missing from the master, duplicated, or the
   image file is empty.
5. Move the image to:

```text
storage/thumbnails/{site_key}/master
```

6. Update the master thumbnail file path.
7. Confirm that the browser thumbnail endpoint uses the updated path.
8. Write a CSV result log.

### Safety Rules

- Never create a master record from an image file.
- Never guess a unique key from a title.
- Never process duplicate image stems in one run.
- Replacing an existing thumbnail is allowed only when that is the documented
  site policy.
- The browser API must read the same master thumbnail path or thumbnail view.

### Batch Pattern

```bat
@echo off
setlocal
cd /d C:\uncen\collection-ledger
node apps\jobs\{manual_thumbnail_job}.js --step apply --input-dir P:\uncen\{site_key}_thumbnails --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
pause
```

## 4. Manual Owned-File Import Per NAS

### Directories

Create an input directory and a normal owned-file destination on every target
NAS:

```text
?:\uncen\{site_key}_new_mp4
?:\uncen\{site_key}
```

Place the same batch file in every `{site_key}_new_mp4` directory. The shared
job must derive the destination from the input drive, so files never cross NAS
boundaries.

### File Naming Rule

The file name must begin with enough information to determine the master unique
key. The rest of the file name may provide a title for missing-master
registration.

Example:

```text
252_1 Title text.wmv
```

This resolves to:

```text
base_no    = 252
branch_no  = 1
unique_key = 252-1
```

Site-specific parsing rules must be documented. For automatic missing-master
creation, use stricter validation than existing-master matching. For example,
an existing master may already contain a reviewed letter branch, while a new
master should accept only numeric branches unless a human explicitly approves
another form.

### Processing Flow

1. Recursively scan the NAS input directory.
2. Parse the unique key from the file name.
3. Check the site master.
4. If the master exists, use it.
5. If the master does not exist, require a non-empty title in the file name and
   create the minimum master record.
6. Stop the whole apply when any row is unsafe.
7. Move the file only to the same NAS destination.
8. Register the destination path in the owned-file table.
9. Run video metadata collection automatically for the source.
10. Confirm that the library view joins the owned row to the master.
11. Write a CSV result log.

### Unsafe Rows

At minimum, stop apply for:

- invalid file name
- duplicate unique key in one input run
- empty or unreadable video file
- missing title for a new master
- unapproved new-master branch format
- destination file already exists
- directory scan error
- master key conflict
- recovery file missing from the master

### Transaction and File-Move Ordering

Database transactions cannot include filesystem moves. Design for interruption
instead of pretending the operation is atomic.

Recommended order:

1. Insert or validate required master rows in a database transaction.
2. Move one file.
3. Confirm that the destination file exists and is non-empty.
4. Upsert the owned-file row using the destination path and current file stat.

Do not register an owned destination path before the move succeeds. Otherwise
the browser may show an owned item that cannot be played.

### Recovery Rule

The shared job must scan the normal owned destination for files that:

- match the strict manual file naming rule
- have a valid master
- are not yet present in the owned-file table

These files are recovery candidates. Register them as owned without moving
them. This recovers the interruption case where a file move succeeded but the
owned-file database update did not run.

Recovery candidates must still be non-empty and readable immediately before
database registration.

### Batch Pattern

The batch must run review first and apply only when review succeeds:

```bat
@echo off
setlocal
cd /d C:\uncen\collection-ledger
node apps\jobs\{owned_import_job}.js --step review --input-dir ?:\uncen\{site_key}_new_mp4 --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
node apps\jobs\{owned_import_job}.js --step apply --input-dir ?:\uncen\{site_key}_new_mp4 --env-file C:\Users\toyoaki\Desktop\filedatachange\.env
if errorlevel 1 goto :failed
echo Import completed.
pause
exit /b 0

:failed
echo Import stopped. Check the review CSV in this folder.
pause
exit /b 1
```

## 5. Browser Integration Requirements

Manual import is not complete until the browser can use the result.

Confirm all of the following:

- the owned-file table stores the final destination path
- the video metadata table stores ffprobe results for the owned files
- the library view returns one row per owned file
- the completion view aggregates owned files by unique key
- 4K/HD/LOW labels come from `collect-video-metadata.js`, not file names
- the API source registry points to the correct owned table and views
- the media path is under an allowed root
- open-file and open-folder actions resolve the owned row
- thumbnail paths resolve through the same API used by existing sites

## 6. Verification Checklist

Before declaring the batch workflow complete:

1. Run `node --check` on the shared job.
2. Run review on every target NAS with an empty input directory.
3. Confirm that every target directory stays on the same drive as its input.
4. Run apply with an empty input directory and confirm zero changes.
5. Confirm the apply output includes the automatic video metadata collection
   result.
6. Confirm the metadata status has `probe_status = 'ok'` rows and expected
   4K/HD/LOW counts.
7. Confirm that review CSV files are created.
8. Remove test-only CSV files before handoff.
9. Review interruption recovery behavior.
10. Ask a sub-agent to review file move, database ordering, scan errors, key
   validation, and browser visibility.
11. Apply review findings and request a final review.

## 7. Heydouga 4017 Reference Implementation

The first implementation of these patterns is:

```text
apps/jobs/import-heydouga-4017-manual-thumbnails.js
apps/jobs/heydouga-4017-new-mp4-import.js
apps/jobs/heydouga-4017-owned-master-sync.js
ops/sql/080_heydouga_4017_owned_file.sql
```

Operational directories:

```text
P:\uncen\heydouga_4017_thumbnails
E:\uncen\heydouga_4017_new_mp4
F:\uncen\heydouga_4017_new_mp4
H:\uncen\heydouga_4017_new_mp4
K:\uncen\heydouga_4017_new_mp4
N:\uncen\heydouga_4017_new_mp4
```

Use this implementation as a reference, but replace all site-specific table
names, unique-key parsing rules, directories, and display names for the next
site.

## 8. 1Pondo Manual Operation Values

```text
site_key                   = 1pondo
master_table               = cl.onepondo_m005_master
owned_table                = cl.onepondo_owned_file
thumbnail_output_dir       = storage/thumbnails/1pondo/master
manual_thumbnail_input_dir = P:\uncen\1pondo_thumbnails
owned_input_dir_per_nas    = ?:\uncen\1pondo_new_mp4
owned_target_dir_per_nas   = ?:\uncen\1pondo
unique_key_file_name_rule  = MMDDYY_NNN
```

Jobs:

```text
apps/jobs/1pondo-owned-operations.js
apps/jobs/import-onepondo-manual-thumbnails.js
```

Manual batch files:

```text
P:\uncen\1pondo_new_master\1pondo_master_apply.bat
?:\uncen\1pondo_new_mp4\1pondo_owned_apply.bat
P:\uncen\1pondo_thumbnails\1pondo_manual_thumbnail_apply.bat
```

The manual master batch is for differential updates. It must fetch only the
newest 3 official JSON pages by default:

```text
node apps\jobs\1pondo-pipeline.js --step master --max-pages 3
```

Do not use the initial full-crawl size such as `--max-pages 96` in the manual
batch. Full crawls are only for explicit one-off rebuild work.

The owned mp4 batch must be present under each active NAS root:

```text
D:\uncen\1pondo_new_mp4
E:\uncen\1pondo_new_mp4
F:\uncen\1pondo_new_mp4
G:\uncen\1pondo_new_mp4
H:\uncen\1pondo_new_mp4
I:\uncen\1pondo_new_mp4
J:\uncen\1pondo_new_mp4
K:\uncen\1pondo_new_mp4
L:\uncen\1pondo_new_mp4
N:\uncen\1pondo_new_mp4
P:\uncen\1pondo_new_mp4
Q:\uncen\1pondo_new_mp4
```

After `owned-apply` registers files, `1pondo-owned-operations.js` runs
`collect-video-metadata.js --source 1pondo --step collect`, so 4K/HD/LOW labels
come from ffprobe video dimensions, matching the other sources.
