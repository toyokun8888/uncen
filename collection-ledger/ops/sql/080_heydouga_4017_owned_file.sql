create schema if not exists cl;

insert into cl.site_master (site_code, site_name, note)
values ('heydouga_4017', 'しろハメ', 'Heydouga 4017 browser source')
on conflict (site_code) do update set
    site_name = excluded.site_name,
    note = excluded.note,
    updated_at = now();

create table if not exists cl.heydouga_4017_owned_file (
    owned_file_id bigserial primary key,
    movie_code text not null,
    base_no text not null,
    branch_no text not null default '',
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

create index if not exists heydouga_4017_owned_file_movie_code_idx
    on cl.heydouga_4017_owned_file (movie_code);

create index if not exists heydouga_4017_owned_file_drive_letter_idx
    on cl.heydouga_4017_owned_file (drive_letter);

create or replace view cl.heydouga_4017_v_thumbnail_assets as
select
    master.unique_key as movie_code,
    coalesce(master.thumbnail_url, '') as thumbnail_url,
    coalesce(master.thumbnail_file_path, '') as local_thumbnail_path,
    nullif(regexp_replace(coalesce(master.thumbnail_file_path, ''), '^.*[\\/]', ''), '') as local_thumbnail_file_name,
    case when coalesce(master.thumbnail_file_path, '') <> '' then 'collected' else 'unknown' end as thumbnail_status
from cl.heydouga_4017_m002_master master;

create or replace view cl.heydouga_4017_v_library_items as
select
    owned.owned_file_id,
    'heydouga_4017'::text as site_code,
    'しろハメ'::text as site_name,
    master.unique_key as movie_code,
    null::date as release_date,
    ''::text as release_date_text,
    master.base_no as relation_key_mmddyy,
    master.title,
    ''::text as actor_names,
    array[]::bigint[] as actor_name_ids,
    array[]::bigint[] as actor_group_ids,
    owned.file_path,
    owned.file_name,
    owned.file_ext,
    owned.drive_letter,
    owned.file_size_bytes,
    round((coalesce(owned.file_size_bytes, 0)::numeric / 1024 / 1024 / 1024), 2) as file_size_gb,
    owned.file_mtime,
    null::integer as video_width,
    null::integer as video_height,
    case
        when owned.file_name ~* '(^|[^a-z0-9])4k([^a-z0-9]|$)' then '4k'
        when owned.file_name ~* '(^|[^a-z0-9])(fhd|1080p|720p|hd)([^a-z0-9]|$)' then 'hd'
        else 'unknown'
    end as resolution_class,
    case
        when owned.file_name ~* '(^|[^a-z0-9])4k([^a-z0-9]|$)' then '4K'
        when owned.file_name ~* '(^|[^a-z0-9])(fhd|1080p|720p|hd)([^a-z0-9]|$)' then 'HD'
        else 'UNKNOWN'
    end as resolution_label,
    'pending'::text as probe_status,
    master.thumbnail_file_path as local_thumbnail_path,
    nullif(regexp_replace(coalesce(master.thumbnail_file_path, ''), '^.*[\\/]', ''), '') as local_thumbnail_file_name,
    master.thumbnail_url,
    case when coalesce(master.thumbnail_file_path, '') <> '' then 'collected' else 'unknown' end as thumbnail_status,
    owned.last_seen_at,
    owned.created_at,
    owned.updated_at
from cl.heydouga_4017_owned_file owned
join cl.heydouga_4017_m002_master master
  on master.unique_key = owned.movie_code;

create or replace view cl.heydouga_4017_v_completion_items as
with owned_summary as (
    select
        owned.movie_code,
        count(*)::integer as owned_count,
        string_agg(owned.file_path, ' | ' order by owned.file_path) as owned_file_paths,
        bool_or(owned.file_name ~* '(^|[^a-z0-9])4k([^a-z0-9]|$)') as has_4k,
        bool_or(owned.file_name ~* '(^|[^a-z0-9])(fhd|1080p|720p|hd)([^a-z0-9]|$)') as has_hd,
        case
            when bool_or(owned.file_name ~* '(^|[^a-z0-9])4k([^a-z0-9]|$)') then '4k'
            when bool_or(owned.file_name ~* '(^|[^a-z0-9])(fhd|1080p|720p|hd)([^a-z0-9]|$)') then 'hd'
            else 'unknown'
        end as best_resolution_class
    from cl.heydouga_4017_owned_file owned
    group by owned.movie_code
)
select
    'heydouga_4017'::text as site_code,
    'しろハメ'::text as site_name,
    master.unique_key as movie_code,
    null::date as release_date,
    ''::text as release_date_text,
    master.base_no as relation_key_mmddyy,
    master.title,
    ''::text as actor_names,
    array[]::bigint[] as actor_name_ids,
    array[]::bigint[] as actor_group_ids,
    master.detail_url,
    master.thumbnail_file_path as local_thumbnail_path,
    nullif(regexp_replace(coalesce(master.thumbnail_file_path, ''), '^.*[\\/]', ''), '') as local_thumbnail_file_name,
    master.thumbnail_url,
    case when coalesce(master.thumbnail_file_path, '') <> '' then 'collected' else 'unknown' end as thumbnail_status,
    (owned_summary.owned_count is not null) as is_owned,
    coalesce(owned_summary.owned_count, 0) as owned_count,
    coalesce(owned_summary.owned_file_paths, '') as owned_file_paths,
    coalesce(owned_summary.best_resolution_class, 'unknown') as best_resolution_class,
    coalesce(owned_summary.has_4k, false) as has_4k,
    coalesce(owned_summary.has_hd, false) as has_hd,
    false as has_dl_reference,
    ''::text as rapidgator_url,
    ''::text as link_href_url,
    ''::text as dl_detail_url,
    ''::text as dl_found_source,
    ''::text as dl_review_status,
    null::timestamptz as dl_last_seen_at,
    master.updated_at as master_updated_at
from cl.heydouga_4017_m002_master master
left join owned_summary
  on owned_summary.movie_code = master.unique_key;
