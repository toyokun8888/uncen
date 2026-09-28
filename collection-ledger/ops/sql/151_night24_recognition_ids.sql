-- Night24 only: persistent recognition IDs used to reconcile manually renamed owned files.
-- Additive migration. Existing site master tables and internal movie_code values remain unchanged.

create table if not exists cl.night24_tm012_recognition_ids (
    recognition_id text primary key check (recognition_id ~ '^ngt[0-9]{3,}$'),
    movie_code text not null unique references cl.night24_tm001_master(movie_code) on delete restrict,
    created_at timestamptz not null default now()
);

grant select, insert on cl.night24_tm012_recognition_ids to current_user;

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
       ''::text as dl_found_source,
       recognition.recognition_id
from cl.night24_tm001_master master
join cl.site_master site on site.site_code = 'night24'
left join owned_summary owned on owned.movie_code = master.movie_code
left join cl.night24_vq003_thumbnail_assets thumb on thumb.movie_code = master.movie_code
left join cl.night24_tm012_recognition_ids recognition on recognition.movie_code = master.movie_code;

grant select on cl.night24_vq002_completion_items to current_user;