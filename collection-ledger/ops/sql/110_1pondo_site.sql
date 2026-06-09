create schema if not exists cl;

insert into cl.site_master (site_code, site_name, note)
values ('1pondo', '1Pondo', '1pondo browser source')
on conflict (site_code) do update set
    site_name = excluded.site_name,
    note = excluded.note,
    updated_at = now();

create table if not exists cl.onepondo_m005_master_raw (
    id bigserial primary key,
    relation_key_mmddyy text not null,
    release_date date,
    release_date_text text,
    movie_code text not null unique,
    movie_code_suffix text not null default '',
    title text not null,
    actor_name text,
    channel_name text,
    detail_url text,
    thumbnail_url text,
    source_page_url text not null,
    page_number integer not null,
    row_index_in_page integer not null,
    raw_payload jsonb not null default '{}'::jsonb,
    last_run_id text,
    collected_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table cl.onepondo_m005_master_raw
    add column if not exists release_date_text text;

create table if not exists cl.onepondo_m005_master (
    movie_code text primary key,
    relation_key_mmddyy text not null,
    release_date date,
    release_date_text text,
    movie_code_suffix text not null default '',
    title text not null,
    actor_name text,
    channel_name text not null default '1Pondo',
    detail_url text,
    thumbnail_url text,
    thumbnail_file_path text,
    raw_id bigint references cl.onepondo_m005_master_raw(id),
    review_status text not null default 'collected',
    note text,
    last_run_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table cl.onepondo_m005_master
    add column if not exists release_date_text text;

create index if not exists onepondo_m005_master_relation_key_idx
    on cl.onepondo_m005_master (relation_key_mmddyy);

create table if not exists cl.onepondo_m005_master_collect_runs (
    run_id text primary key,
    status text not null,
    pages_requested integer not null default 0,
    pages_processed integer not null default 0,
    rows_collected integer not null default 0,
    started_at timestamptz not null default now(),
    finished_at timestamptz
);

create table if not exists cl.onepondo_m005_master_page_logs (
    page_log_id bigserial primary key,
    run_id text not null references cl.onepondo_m005_master_collect_runs(run_id) on delete cascade,
    page_number integer not null,
    page_url text not null,
    rows_found integer not null default 0,
    created_at timestamptz not null default now()
);

create table if not exists cl.onepondo_m005_thumbnail_assets (
    movie_code text primary key references cl.onepondo_m005_master(movie_code) on delete cascade,
    thumbnail_url text,
    local_thumbnail_path text,
    local_thumbnail_file_name text,
    thumbnail_status text not null default 'pending',
    bytes bigint,
    last_error text,
    last_checked_at timestamptz,
    downloaded_at timestamptz,
    updated_at timestamptz not null default now()
);

create table if not exists cl.onepondo_owned_file (
    owned_file_id bigserial primary key,
    movie_code text not null references cl.onepondo_m005_master(movie_code),
    file_path text not null unique,
    file_name text not null,
    file_ext text,
    drive_letter text,
    file_size_bytes bigint,
    file_mtime timestamptz,
    last_seen_at timestamptz not null default now(),
    note text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists onepondo_owned_file_movie_code_idx
    on cl.onepondo_owned_file (movie_code);

create table if not exists cl.onepondo_owned_file_video_metadata (
    owned_file_id bigint primary key references cl.onepondo_owned_file(owned_file_id) on delete cascade,
    movie_code text not null,
    file_path text not null,
    file_name text,
    file_size_bytes bigint,
    file_mtime timestamp with time zone,
    video_width integer,
    video_height integer,
    resolution_class text,
    probe_status text not null default 'pending',
    probe_error text,
    probed_at timestamp with time zone,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    constraint onepondo_owned_file_video_metadata_resolution_class_chk
        check (resolution_class is null or resolution_class in ('4k', 'hd', 'low')),
    constraint onepondo_owned_file_video_metadata_probe_status_chk
        check (probe_status in ('pending', 'ok', 'failed', 'file_missing', 'path_not_allowed', 'unsupported'))
);

create index if not exists onepondo_owned_file_video_metadata_movie_code_idx
    on cl.onepondo_owned_file_video_metadata (movie_code);

create index if not exists onepondo_owned_file_video_metadata_resolution_class_idx
    on cl.onepondo_owned_file_video_metadata (resolution_class);

create index if not exists onepondo_owned_file_video_metadata_probe_status_idx
    on cl.onepondo_owned_file_video_metadata (probe_status);

create table if not exists cl.onepondo_dl_reference (
    dl_reference_id bigserial primary key,
    movie_code text,
    title text,
    detail_url text,
    rapidgator_url text,
    link_href_url text,
    found_source text not null,
    has_rapidgator boolean not null default false,
    source_page_url text not null,
    page_number integer not null,
    review_status text not null default 'pending',
    raw_payload jsonb not null default '{}'::jsonb,
    last_seen_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists cl.onepondo_dl_reference_runs (
    run_id text primary key,
    status text not null,
    start_page integer not null,
    max_pages integer not null,
    pages_processed integer not null default 0,
    posts_found integer not null default 0,
    rows_written integer not null default 0,
    matched_master_count integer not null default 0,
    missing_master_count integer not null default 0,
    no_rapidgator_count integer not null default 0,
    error_count integer not null default 0,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    error_message text
);

alter table cl.onepondo_dl_reference_runs
    add column if not exists error_count integer not null default 0;

create table if not exists cl.onepondo_dl_reference_page_logs (
    page_log_id bigserial primary key,
    run_id text not null references cl.onepondo_dl_reference_runs(run_id) on delete cascade,
    page_number integer not null,
    page_url text not null,
    status text not null,
    posts_found integer not null default 0,
    rows_found integer not null default 0,
    list_rg_found integer not null default 0,
    detail_fetch_count integer not null default 0,
    detail_rg_found integer not null default 0,
    error_message text,
    created_at timestamptz not null default now()
);

create unique index if not exists onepondo_dl_reference_identity_uidx
    on cl.onepondo_dl_reference (
        coalesce(movie_code, ''),
        coalesce(detail_url, ''),
        coalesce(rapidgator_url, '')
    );

create or replace view cl.onepondo_v_thumbnail_assets as
select
    master.movie_code,
    coalesce(asset.thumbnail_url, master.thumbnail_url, '') as thumbnail_url,
    coalesce(asset.local_thumbnail_path, master.thumbnail_file_path, '') as local_thumbnail_path,
    coalesce(asset.local_thumbnail_file_name, nullif(regexp_replace(coalesce(master.thumbnail_file_path, ''), '^.*[\\/]', ''), '')) as local_thumbnail_file_name,
    coalesce(asset.thumbnail_status, case when coalesce(master.thumbnail_file_path, '') <> '' then 'collected' else 'pending' end) as thumbnail_status
from cl.onepondo_m005_master master
left join cl.onepondo_m005_thumbnail_assets asset on asset.movie_code = master.movie_code;

create or replace view cl.onepondo_v_library_items as
select
    owned.owned_file_id,
    '1pondo'::text as site_code,
    '1Pondo'::text as site_name,
    master.movie_code,
    master.release_date,
    coalesce(master.release_date_text, to_char(master.release_date, 'YYYY-MM-DD'), '') as release_date_text,
    master.relation_key_mmddyy,
    master.title,
    coalesce(master.actor_name, '') as actor_names,
    coalesce(actor.actor_name_ids, array[]::bigint[]) as actor_name_ids,
    coalesce(actor.actor_group_ids, array[]::bigint[]) as actor_group_ids,
    owned.file_path,
    owned.file_name,
    owned.file_ext,
    owned.drive_letter,
    owned.file_size_bytes,
    round((coalesce(owned.file_size_bytes, 0)::numeric / 1024 / 1024 / 1024), 2) as file_size_gb,
    owned.file_mtime,
    video_metadata.video_width,
    video_metadata.video_height,
    coalesce(video_metadata.resolution_class, 'unknown') as resolution_class,
    coalesce(video_metadata.probe_status, 'pending') as probe_status,
    thumb.local_thumbnail_path,
    thumb.local_thumbnail_file_name,
    thumb.thumbnail_url,
    thumb.thumbnail_status,
    owned.last_seen_at,
    owned.created_at,
    owned.updated_at
from cl.onepondo_owned_file owned
join cl.onepondo_m005_master master on master.movie_code = owned.movie_code
left join cl.onepondo_owned_file_video_metadata video_metadata on video_metadata.owned_file_id = owned.owned_file_id
left join cl.onepondo_v_thumbnail_assets thumb on thumb.movie_code = master.movie_code
left join lateral (
    select
        array_agg(names.actor_name_id order by names.actor_name_id) as actor_name_ids,
        array_agg(names.actor_group_id order by names.actor_group_id) as actor_group_ids
    from cl.actor_name_master names
    join cl.site_master sites on sites.site_id = names.site_id
    where sites.site_code = '1pondo'
      and names.actor_name in (
          select trim(value)
          from regexp_split_to_table(coalesce(master.actor_name, ''), '\s*[,、/]\s*') value
          where trim(value) <> ''
      )
) actor on true;

create or replace view cl.onepondo_v_completion_items as
with owned_summary as (
    select
        owned.movie_code,
        count(*)::integer as owned_count,
        string_agg(owned.file_path, ' | ' order by owned.file_path) as owned_file_paths,
        case max(
            case video_metadata.resolution_class
                when '4k' then 3
                when 'hd' then 2
                when 'low' then 1
                else 0
            end
        ) filter (where video_metadata.probe_status = 'ok')
            when 3 then '4k'
            when 2 then 'hd'
            when 1 then 'low'
            else null
        end as best_resolution_class,
        bool_or(video_metadata.resolution_class = '4k') filter (where video_metadata.probe_status = 'ok') as has_4k,
        bool_or(video_metadata.resolution_class = 'hd') filter (where video_metadata.probe_status = 'ok') as has_hd
    from cl.onepondo_owned_file owned
    left join cl.onepondo_owned_file_video_metadata video_metadata on video_metadata.owned_file_id = owned.owned_file_id
    group by owned.movie_code
),
dl as (
    select distinct on (movie_code)
        movie_code, rapidgator_url, link_href_url, detail_url, found_source, review_status, last_seen_at
    from cl.onepondo_dl_reference
    where has_rapidgator and review_status = 'matched_master' and coalesce(movie_code, '') <> ''
    order by movie_code, last_seen_at desc
)
select
    '1pondo'::text as site_code,
    '1Pondo'::text as site_name,
    master.movie_code,
    master.release_date,
    coalesce(master.release_date_text, to_char(master.release_date, 'YYYY-MM-DD'), '') as release_date_text,
    master.relation_key_mmddyy,
    master.title,
    coalesce(master.actor_name, '') as actor_names,
    coalesce(actor.actor_name_ids, array[]::bigint[]) as actor_name_ids,
    coalesce(actor.actor_group_ids, array[]::bigint[]) as actor_group_ids,
    master.detail_url,
    thumb.local_thumbnail_path,
    thumb.local_thumbnail_file_name,
    thumb.thumbnail_url,
    thumb.thumbnail_status,
    (owned.owned_count is not null) as is_owned,
    coalesce(owned.owned_count, 0) as owned_count,
    coalesce(owned.owned_file_paths, '') as owned_file_paths,
    coalesce(owned.best_resolution_class, 'unknown') as best_resolution_class,
    coalesce(owned.has_4k, false) as has_4k,
    coalesce(owned.has_hd, false) as has_hd,
    (dl.movie_code is not null) as has_dl_reference,
    coalesce(dl.rapidgator_url, '') as rapidgator_url,
    coalesce(dl.link_href_url, '') as link_href_url,
    coalesce(dl.detail_url, '') as dl_detail_url,
    coalesce(dl.found_source, '') as dl_found_source,
    coalesce(dl.review_status, '') as dl_review_status,
    dl.last_seen_at as dl_last_seen_at,
    master.updated_at as master_updated_at
from cl.onepondo_m005_master master
left join owned_summary owned on owned.movie_code = master.movie_code
left join dl on dl.movie_code = master.movie_code
left join cl.onepondo_v_thumbnail_assets thumb on thumb.movie_code = master.movie_code
left join lateral (
    select
        array_agg(names.actor_name_id order by names.actor_name_id) as actor_name_ids,
        array_agg(names.actor_group_id order by names.actor_group_id) as actor_group_ids
    from cl.actor_name_master names
    join cl.site_master sites on sites.site_id = names.site_id
    where sites.site_code = '1pondo'
      and names.actor_name in (
          select trim(value)
          from regexp_split_to_table(coalesce(master.actor_name, ''), '\s*[,、/]\s*') value
          where trim(value) <> ''
      )
) actor on true;

grant usage on schema cl to current_user;
grant select, insert, update, delete on
    cl.onepondo_m005_master_raw,
    cl.onepondo_m005_master,
    cl.onepondo_m005_master_collect_runs,
    cl.onepondo_m005_master_page_logs,
    cl.onepondo_m005_thumbnail_assets,
    cl.onepondo_owned_file,
    cl.onepondo_owned_file_video_metadata,
    cl.onepondo_dl_reference,
    cl.onepondo_dl_reference_runs,
    cl.onepondo_dl_reference_page_logs
to current_user;
grant select on
    cl.onepondo_v_thumbnail_assets,
    cl.onepondo_v_library_items,
    cl.onepondo_v_completion_items
to current_user;
grant usage, select on sequence
    cl.onepondo_m005_master_raw_id_seq,
    cl.onepondo_m005_master_page_logs_page_log_id_seq,
    cl.onepondo_owned_file_owned_file_id_seq,
    cl.onepondo_dl_reference_dl_reference_id_seq,
    cl.onepondo_dl_reference_page_logs_page_log_id_seq
to current_user;

