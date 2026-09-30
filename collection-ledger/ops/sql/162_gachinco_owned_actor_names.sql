-- File-level performer names take priority over catalog-level cast metadata.
alter table cl.gachinco_tm002_owned_files
  add column if not exists actor_names text not null default '';

create or replace view cl.gachinco_vq001_library_items as
select owned.owned_file_id,
       site.site_code,
       site.site_name,
       master.movie_code,
       null::date as release_date,
       ''::text as release_date_text,
       master.title,
       coalesce(owned.actor_names, '') as actor_names,
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
from cl.gachinco_tm002_owned_files owned
join cl.gachinco_tm001_master master on master.movie_code = owned.movie_code
join cl.site_master site on site.site_code = 'gachinco'
left join cl.gachinco_tm011_owned_file_video_metadata video on video.owned_file_id = owned.owned_file_id
left join cl.gachinco_vq003_thumbnail_assets thumb on thumb.movie_code = master.movie_code;

create or replace view cl.gachinco_vq002_completion_items as
with owned_summary as (
    select owned.movie_code,
           count(*)::integer as owned_count,
           string_agg(distinct owned.file_path, ' | ' order by owned.file_path) as owned_file_paths,
           string_agg(distinct nullif(owned.actor_names, ''), '、' order by nullif(owned.actor_names, '')) as actor_names,
           bool_or(video.resolution_class = '4k') as has_4k,
           bool_or(video.resolution_class in ('4k','hd')) as has_hd,
           case when bool_or(video.resolution_class = '4k') then '4k'
                when bool_or(video.resolution_class = 'hd') then 'hd'
                when bool_or(video.resolution_class = 'low') then 'low'
                else 'unknown' end as best_resolution_class
    from cl.gachinco_tm002_owned_files owned
    left join cl.gachinco_tm011_owned_file_video_metadata video on video.owned_file_id = owned.owned_file_id
    group by owned.movie_code
)
select site.site_code,
       site.site_name,
       master.movie_code,
       null::date as release_date,
       ''::text as release_date_text,
       master.title,
       coalesce(owned.actor_names, '') as actor_names,
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
       ''::text as dl_found_source,
       recognition.recognition_id
from cl.gachinco_tm001_master master
join cl.site_master site on site.site_code = 'gachinco'
left join owned_summary owned on owned.movie_code = master.movie_code
left join cl.gachinco_vq003_thumbnail_assets thumb on thumb.movie_code = master.movie_code
left join cl.gachinco_tm012_recognition_ids recognition on recognition.movie_code = master.movie_code;
