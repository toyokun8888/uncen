create schema if not exists cl;

insert into cl.site_master (site_code, site_name, note)
values ('night24', 'night24', 'Night24 owned-file library and full catalog')
on conflict (site_code) do nothing;

create table if not exists cl.night24_tl001_file_process_logs (
    id bigserial primary key,
    run_id text not null,
    owned_file_id bigint,
    movie_code text,
    old_path text,
    new_path text,
    old_file_name text,
    new_file_name text,
    action text not null,
    status text not null,
    source text not null default 'night24_manual',
    matched_by text,
    note text,
    created_at timestamptz not null default now()
);
create index if not exists night24_tl001_file_process_logs_run_id_idx on cl.night24_tl001_file_process_logs (run_id);
create index if not exists night24_tl001_file_process_logs_status_idx on cl.night24_tl001_file_process_logs (status);

create table if not exists cl.night24_tl002_master_collect_runs (
    run_id text primary key,
    status text not null,
    pages_requested integer not null default 0,
    pages_processed integer not null default 0,
    rows_collected integer not null default 0,
    masters_written integer not null default 0,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    error_message text
);

create table if not exists cl.night24_tl003_master_page_logs (
    page_log_id bigserial primary key,
    run_id text not null references cl.night24_tl002_master_collect_runs(run_id),
    source_code text not null check (source_code in ('analers', 'heydouga', 'shiitake')),
    page_number integer not null,
    page_url text not null,
    rows_found integer not null default 0,
    created_at timestamptz not null default now(),
    unique (run_id, source_code, page_number)
);

create table if not exists cl.night24_tm001_master (
    movie_code text primary key,
    canonical_key text not null unique,
    normalized_title text not null,
    title text not null,
    series_name text,
    title_source_code text not null check (title_source_code in ('analers', 'heydouga', 'shiitake')),
    title_source_record_id text not null,
    detail_url text,
    thumbnail_url text not null,
    thumbnail_file_path text,
    review_status text not null default 'collected',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists night24_tm001_master_normalized_title_idx on cl.night24_tm001_master (normalized_title);
create index if not exists night24_tm001_master_series_name_idx on cl.night24_tm001_master (series_name);

create table if not exists cl.night24_tm003_master_source_records (
    id bigserial primary key,
    run_id text not null references cl.night24_tl002_master_collect_runs(run_id),
    source_code text not null check (source_code in ('analers', 'heydouga', 'shiitake')),
    source_record_id text not null,
    movie_code text not null references cl.night24_tm001_master(movie_code),
    canonical_key text not null,
    source_title text not null,
    normalized_title text not null,
    series_name text,
    detail_url text,
    thumbnail_url text not null,
    source_page_url text not null,
    page_number integer not null,
    row_index integer not null,
    raw_payload jsonb not null default '{}'::jsonb,
    last_seen_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (source_code, source_record_id)
);
create index if not exists night24_tm003_source_records_movie_idx on cl.night24_tm003_master_source_records (movie_code);
create index if not exists night24_tm003_source_records_title_idx on cl.night24_tm003_master_source_records (normalized_title);

create table if not exists cl.night24_tm002_owned_files (
    owned_file_id bigserial primary key,
    movie_code text not null references cl.night24_tm001_master(movie_code),
    file_path text not null unique,
    original_file_path text not null,
    file_name text not null,
    file_ext text,
    drive_letter text not null check (drive_letter in ('D','E','F','G','H','I','J','K','L','N','P','Q','R','T')),
    file_size_bytes bigint,
    file_mtime timestamptz,
    source_type text not null default 'normal' check (source_type in ('normal','recovery')),
    match_method text not null,
    match_score numeric(6,4) not null,
    original_file_name text not null,
    last_seen_at timestamptz not null default now(),
    note text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists night24_tm002_owned_files_movie_idx on cl.night24_tm002_owned_files (movie_code);
create index if not exists night24_tm002_owned_files_drive_idx on cl.night24_tm002_owned_files (drive_letter);

create table if not exists cl.night24_tm005_unmatched_files (
    unmatched_file_id bigserial primary key,
    run_id text not null,
    detected_path text not null,
    current_path text not null unique,
    detected_file_name text not null,
    current_file_name text not null,
    extracted_source_record_id text,
    reason text not null,
    status text not null default 'review_required' check (status in ('review_required','resolved','excluded')),
    source text not null default 'night24_manual',
    file_size_bytes bigint,
    file_mtime timestamptz,
    note text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists night24_tm005_unmatched_files_status_idx on cl.night24_tm005_unmatched_files (status);

create table if not exists cl.night24_tm007_thumbnail_assets (
    movie_code text primary key references cl.night24_tm001_master(movie_code),
    thumbnail_url text,
    local_thumbnail_path text,
    local_thumbnail_file_name text,
    thumbnail_status text not null default 'pending' check (thumbnail_status in ('pending','collected','failed')),
    attempt_count integer not null default 0,
    bytes bigint,
    last_error text,
    last_checked_at timestamptz,
    downloaded_at timestamptz,
    updated_at timestamptz not null default now()
);

create table if not exists cl.night24_tm011_owned_file_video_metadata (
    owned_file_id bigint primary key references cl.night24_tm002_owned_files(owned_file_id) on delete cascade,
    movie_code text not null references cl.night24_tm001_master(movie_code),
    file_path text not null,
    file_name text,
    file_size_bytes bigint,
    file_mtime timestamptz,
    video_width integer,
    video_height integer,
    resolution_class text check (resolution_class is null or resolution_class in ('4k','hd','low')),
    probe_status text not null default 'pending' check (probe_status in ('pending','ok','failed','file_missing','path_not_allowed','unsupported')),
    probe_error text,
    probed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists night24_tm011_video_metadata_movie_idx on cl.night24_tm011_owned_file_video_metadata (movie_code);
create index if not exists night24_tm011_video_metadata_status_idx on cl.night24_tm011_owned_file_video_metadata (probe_status);

create or replace view cl.night24_vq003_thumbnail_assets as
select master.movie_code,
       coalesce(asset.thumbnail_url, master.thumbnail_url, '') as thumbnail_url,
       coalesce(asset.local_thumbnail_path, master.thumbnail_file_path, '') as local_thumbnail_path,
       coalesce(asset.local_thumbnail_file_name,
         nullif(regexp_replace(coalesce(master.thumbnail_file_path, ''), '^.*[\\/]', ''), '')) as local_thumbnail_file_name,
       coalesce(asset.thumbnail_status, case when coalesce(master.thumbnail_file_path, '') <> '' then 'collected' else 'pending' end) as thumbnail_status
from cl.night24_tm001_master master
left join cl.night24_tm007_thumbnail_assets asset on asset.movie_code = master.movie_code;

create or replace view cl.night24_vq001_library_items as
select owned.owned_file_id,
       site.site_code,
       site.site_name,
       master.movie_code,
       null::date as release_date,
       ''::text as release_date_text,
       master.title,
       ''::text as actor_names,
       array[]::bigint[] as actor_name_ids,
       array[]::bigint[] as actor_group_ids,
       owned.file_path,
       owned.file_name,
       owned.file_ext,
       owned.drive_letter,
       owned.file_size_bytes,
       round(coalesce(owned.file_size_bytes, 0)::numeric / 1024 / 1024 / 1024, 2) as file_size_gb,
       owned.file_mtime,
       video.video_width,
       video.video_height,
       coalesce(video.resolution_class, 'unknown') as resolution_class,
       coalesce(video.probe_status, 'pending') as probe_status,
       thumb.local_thumbnail_path,
       thumb.local_thumbnail_file_name,
       thumb.thumbnail_url,
       thumb.thumbnail_status,
       owned.last_seen_at,
       owned.created_at,
       owned.updated_at
from cl.night24_tm002_owned_files owned
join cl.night24_tm001_master master on master.movie_code = owned.movie_code
join cl.site_master site on site.site_code = 'night24'
left join cl.night24_tm011_owned_file_video_metadata video on video.owned_file_id = owned.owned_file_id
left join cl.night24_vq003_thumbnail_assets thumb on thumb.movie_code = master.movie_code;

create or replace view cl.night24_vq002_completion_items as
with owned_summary as (
    select owned.movie_code,
           count(*)::integer as owned_count,
           string_agg(distinct owned.file_path, ' | ' order by owned.file_path) as owned_file_paths,
           bool_or(video.resolution_class = '4k') as has_4k,
           bool_or(video.resolution_class in ('4k','hd')) as has_hd,
           case when bool_or(video.resolution_class = '4k') then '4k'
                when bool_or(video.resolution_class = 'hd') then 'hd'
                when bool_or(video.resolution_class = 'low') then 'low'
                else 'unknown' end as best_resolution_class
    from cl.night24_tm002_owned_files owned
    left join cl.night24_tm011_owned_file_video_metadata video on video.owned_file_id = owned.owned_file_id
    group by owned.movie_code
)
select site.site_code,
       site.site_name,
       master.movie_code,
       null::date as release_date,
       ''::text as release_date_text,
       master.title,
       ''::text as actor_names,
       master.detail_url,
       thumb.local_thumbnail_path,
       thumb.local_thumbnail_file_name,
       thumb.thumbnail_url,
       thumb.thumbnail_status,
       coalesce(owned.owned_count > 0, false) as is_owned,
       coalesce(owned.owned_count, 0) as owned_count,
       coalesce(owned.owned_file_paths, '') as owned_file_paths,
       coalesce(owned.best_resolution_class, 'unknown') as best_resolution_class,
       coalesce(owned.has_4k, false) as has_4k,
       coalesce(owned.has_hd, false) as has_hd,
       false as has_dl_reference,
       ''::text as rapidgator_url,
       ''::text as link_href_url,
       ''::text as dl_detail_url,
       ''::text as dl_found_source
from cl.night24_tm001_master master
join cl.site_master site on site.site_code = 'night24'
left join owned_summary owned on owned.movie_code = master.movie_code
left join cl.night24_vq003_thumbnail_assets thumb on thumb.movie_code = master.movie_code;

grant usage on schema cl to current_user;
grant select, insert, update, delete on
    cl.night24_tl001_file_process_logs,
    cl.night24_tl002_master_collect_runs,
    cl.night24_tl003_master_page_logs,
    cl.night24_tm001_master,
    cl.night24_tm002_owned_files,
    cl.night24_tm003_master_source_records,
    cl.night24_tm005_unmatched_files,
    cl.night24_tm007_thumbnail_assets,
    cl.night24_tm011_owned_file_video_metadata
to current_user;
grant select on cl.night24_vq001_library_items, cl.night24_vq002_completion_items, cl.night24_vq003_thumbnail_assets to current_user;
grant usage, select on sequence
    cl.night24_tl001_file_process_logs_id_seq,
    cl.night24_tl003_master_page_logs_page_log_id_seq,
    cl.night24_tm003_master_source_records_id_seq,
    cl.night24_tm002_owned_files_owned_file_id_seq,
    cl.night24_tm005_unmatched_files_unmatched_file_id_seq
to current_user;
