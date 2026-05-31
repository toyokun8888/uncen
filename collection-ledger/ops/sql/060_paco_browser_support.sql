-- Browser support tables/views for PACO library and completion pages.
-- Additive only. This file does not remove table data.

create schema if not exists cl;

create table if not exists cl.paco_owned_file_video_metadata (
    owned_file_id bigint primary key references cl.paco_owned_file(owned_file_id) on delete cascade,
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
    constraint paco_owned_file_video_metadata_resolution_class_chk
        check (resolution_class is null or resolution_class in ('4k', 'hd', 'low')),
    constraint paco_owned_file_video_metadata_probe_status_chk
        check (probe_status in ('pending', 'ok', 'failed', 'file_missing', 'path_not_allowed', 'unsupported'))
);

create index if not exists paco_owned_file_video_metadata_movie_code_idx
    on cl.paco_owned_file_video_metadata (movie_code);

create index if not exists paco_owned_file_video_metadata_resolution_class_idx
    on cl.paco_owned_file_video_metadata (resolution_class);

create index if not exists paco_owned_file_video_metadata_probe_status_idx
    on cl.paco_owned_file_video_metadata (probe_status);

create or replace view cl.paco_v_library_items as
with owned_actor as (
    select
        owned_file_actor.owned_file_id,
        string_agg(actor_name_master.actor_name, ', ' order by actor_name_master.actor_name) as actor_names,
        array_agg(distinct owned_file_actor.actor_name_id order by owned_file_actor.actor_name_id) as actor_name_ids,
        array_agg(distinct owned_file_actor.actor_group_id order by owned_file_actor.actor_group_id) as actor_group_ids
    from cl.paco_owned_file_actor owned_file_actor
    join cl.actor_name_master actor_name_master
      on actor_name_master.actor_name_id = owned_file_actor.actor_name_id
    group by owned_file_actor.owned_file_id
)
select
    owned_file.owned_file_id,
    site_master.site_code,
    site_master.site_name,
    owned_file.movie_code,
    master.release_date,
    to_char(master.release_date, 'YYYY-MM-DD') as release_date_text,
    master.relation_key_mmddyy,
    master.title,
    coalesce(owned_actor.actor_names, master.actor_name, '') as actor_names,
    coalesce(owned_actor.actor_name_ids, array[]::bigint[]) as actor_name_ids,
    coalesce(owned_actor.actor_group_ids, array[]::bigint[]) as actor_group_ids,
    owned_file.file_path,
    owned_file.file_name,
    owned_file.file_ext,
    owned_file.drive_letter,
    owned_file.file_size_bytes,
    round(owned_file.file_size_bytes::numeric / 1024 / 1024 / 1024, 2) as file_size_gb,
    owned_file.file_mtime,
    video_metadata.video_width,
    video_metadata.video_height,
    video_metadata.resolution_class,
    case video_metadata.resolution_class
        when '4k' then '4K'
        when 'hd' then 'HD'
        when 'low' then 'LOW'
        else 'UNKNOWN'
    end as resolution_label,
    coalesce(video_metadata.probe_status, 'pending') as probe_status,
    thumbnail.local_thumbnail_path,
    thumbnail.local_thumbnail_file_name,
    thumbnail.thumbnail_url,
    coalesce(thumbnail.thumbnail_status, 'unknown') as thumbnail_status,
    owned_file.last_seen_at,
    owned_file.created_at,
    owned_file.updated_at
from cl.paco_owned_file owned_file
join cl.site_master site_master
  on site_master.site_id = owned_file.source_site_id
join cl.paco_m001_master_staging master
  on master.movie_code = owned_file.movie_code
left join owned_actor
  on owned_actor.owned_file_id = owned_file.owned_file_id
left join cl.paco_owned_file_video_metadata video_metadata
  on video_metadata.owned_file_id = owned_file.owned_file_id
left join cl.paco_m001_thumbnail_assets thumbnail
  on thumbnail.movie_code = owned_file.movie_code;

create or replace view cl.paco_v_completion_items as
with master_actor as (
    select
        master.movie_code,
        string_agg(distinct btrim(actor_name_part), ', ' order by btrim(actor_name_part)) as actor_names,
        array_agg(distinct actor_name_master.actor_name_id order by actor_name_master.actor_name_id)
            filter (where actor_name_master.actor_name_id is not null) as actor_name_ids,
        array_agg(distinct actor_name_master.actor_group_id order by actor_name_master.actor_group_id)
            filter (where actor_name_master.actor_group_id is not null) as actor_group_ids
    from cl.paco_m001_master_staging master
    left join lateral regexp_split_to_table(coalesce(master.actor_name, ''), ',') as actor_name_part on true
    left join cl.site_master site_master
      on site_master.site_code = 'paco'
    left join cl.actor_name_master actor_name_master
      on actor_name_master.site_id = site_master.site_id
     and actor_name_master.actor_name = btrim(actor_name_part)
    where btrim(coalesce(actor_name_part, '')) <> ''
    group by master.movie_code
),
owned_summary as (
    select
        owned_file.movie_code,
        count(*)::integer as owned_count,
        string_agg(owned_file.file_path, ' | ' order by owned_file.file_path) as owned_file_paths,
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
        bool_or(video_metadata.resolution_class = '4k') as has_4k,
        bool_or(video_metadata.resolution_class = 'hd') as has_hd,
        max(owned_file.updated_at) as owned_updated_at
    from cl.paco_owned_file owned_file
    left join cl.paco_owned_file_video_metadata video_metadata
      on video_metadata.owned_file_id = owned_file.owned_file_id
    group by owned_file.movie_code
),
dl_best as (
    select distinct on (dl_reference.movie_code)
        dl_reference.movie_code,
        dl_reference.rapidgator_url,
        dl_reference.link_href_url,
        dl_reference.detail_url as dl_detail_url,
        dl_reference.found_source as dl_found_source,
        dl_reference.review_status as dl_review_status,
        dl_reference.last_seen_at as dl_last_seen_at
    from cl.paco_dl_reference dl_reference
    where dl_reference.movie_code is not null
      and dl_reference.has_rapidgator = true
      and dl_reference.review_status = 'matched_master'
    order by
        dl_reference.movie_code,
        dl_reference.last_seen_at desc,
        dl_reference.dl_reference_id desc
)
select
    site_master.site_code,
    site_master.site_name,
    master.movie_code,
    master.release_date,
    to_char(master.release_date, 'YYYY-MM-DD') as release_date_text,
    master.relation_key_mmddyy,
    master.title,
    coalesce(master_actor.actor_names, master.actor_name, '') as actor_names,
    coalesce(master_actor.actor_name_ids, array[]::bigint[]) as actor_name_ids,
    coalesce(master_actor.actor_group_ids, array[]::bigint[]) as actor_group_ids,
    master.detail_url,
    coalesce(thumbnail.local_thumbnail_path, '') as local_thumbnail_path,
    coalesce(thumbnail.local_thumbnail_file_name, '') as local_thumbnail_file_name,
    coalesce(thumbnail.thumbnail_url, master.thumbnail_url, '') as thumbnail_url,
    coalesce(thumbnail.thumbnail_status, 'unknown') as thumbnail_status,
    (coalesce(owned_summary.owned_count, 0) > 0) as is_owned,
    coalesce(owned_summary.owned_count, 0) as owned_count,
    coalesce(owned_summary.owned_file_paths, '') as owned_file_paths,
    owned_summary.best_resolution_class,
    owned_summary.has_4k,
    owned_summary.has_hd,
    (dl_best.movie_code is not null) as has_dl_reference,
    coalesce(dl_best.rapidgator_url, '') as rapidgator_url,
    coalesce(dl_best.link_href_url, '') as link_href_url,
    coalesce(dl_best.dl_detail_url, '') as dl_detail_url,
    coalesce(dl_best.dl_found_source, '') as dl_found_source,
    coalesce(dl_best.dl_review_status, '') as dl_review_status,
    dl_best.dl_last_seen_at,
    master.updated_at as master_updated_at
from cl.paco_m001_master_staging master
left join cl.site_master site_master
  on site_master.site_code = 'paco'
left join master_actor
  on master_actor.movie_code = master.movie_code
left join owned_summary
  on owned_summary.movie_code = master.movie_code
left join dl_best
  on dl_best.movie_code = master.movie_code
left join cl.paco_m001_thumbnail_assets thumbnail
  on thumbnail.movie_code = master.movie_code;

grant select, insert, update, delete on cl.paco_owned_file_video_metadata to current_user;
grant select on cl.paco_v_library_items to current_user;
grant select on cl.paco_v_completion_items to current_user;
