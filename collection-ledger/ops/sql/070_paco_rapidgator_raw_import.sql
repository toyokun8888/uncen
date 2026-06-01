-- Extract PACO Rapidgator references from the legacy public raw table.
-- Additive only. This file does not remove table data.

create schema if not exists cl;

create or replace view cl.paco_v_rapidgator_raw_candidates as
with raw_paco as (
    select
        raw.id as raw_id,
        replace(substring(raw.file_title from '([0-9]{6}[_-][0-9]{3})'), '-', '_') as movie_code,
        raw.global_seq,
        raw.csv_part_no,
        raw.file_seq,
        raw.source_page_url,
        raw.folder_id,
        raw.folder_name,
        raw.page_number,
        raw.row_index_in_page,
        raw.file_title,
        raw.file_url,
        raw.file_size,
        raw.file_ext,
        raw.group_key,
        raw.group_rule,
        raw.fc2_product_id,
        raw.part_no,
        raw.part_label,
        raw.part_type,
        raw.base_title_without_part,
        raw.collected_at,
        raw.inserted_at,
        case when lower(raw.file_title) like '%.mp4%' then 1 else 0 end as is_mp4,
        case when lower(raw.file_title) like '%.rar%' then 1 else 0 end as is_rar,
        coalesce(nullif(regexp_replace(coalesce(raw.part_no, ''), '[^0-9]', '', 'g'), '')::integer,
                 nullif(substring(raw.file_title from '(?i)part[._-]?([0-9]+)'), '')::integer,
                 9999) as part_number
    from public.xxx_tl002_rapidgator_raw raw
    where concat_ws(' ', raw.file_title, raw.folder_name, raw.source_page_url, raw.file_url, raw.base_title_without_part) ilike '%paco%'
      and raw.file_url ilike 'https://rapidgator.net/file/%'
      and substring(raw.file_title from '([0-9]{6}[_-][0-9]{3})') is not null
),
ranked as (
    select
        raw_paco.*,
        count(*) over (partition by raw_paco.movie_code) as raw_row_count,
        count(*) filter (where raw_paco.is_mp4 = 1) over (partition by raw_paco.movie_code) as mp4_row_count,
        count(*) filter (where raw_paco.is_rar = 1) over (partition by raw_paco.movie_code) as rar_row_count,
        row_number() over (
            partition by raw_paco.movie_code
            order by
                raw_paco.is_mp4 desc,
                case when raw_paco.part_number = 1 then 1 else 0 end desc,
                raw_paco.part_number asc,
                raw_paco.raw_id desc
        ) as candidate_rank
    from raw_paco
)
select
    ranked.movie_code,
    ranked.file_title as title,
    ranked.file_url as rapidgator_url,
    ranked.file_url as link_href_url,
    ranked.source_page_url as detail_url,
    ranked.folder_name,
    ranked.file_size,
    ranked.file_ext,
    ranked.raw_row_count,
    ranked.mp4_row_count,
    ranked.rar_row_count,
    ranked.raw_id,
    ranked.global_seq,
    ranked.csv_part_no,
    ranked.file_seq,
    ranked.source_page_url,
    ranked.page_number,
    ranked.row_index_in_page,
    ranked.collected_at,
    ranked.inserted_at
from ranked
where ranked.candidate_rank = 1;

insert into cl.paco_dl_reference (
    search_site_code,
    search_keyword,
    movie_code,
    title,
    detail_url,
    rapidgator_url,
    link_href_url,
    found_source,
    has_rapidgator,
    http_status,
    error_message,
    source_page_url,
    page_number,
    post_index_in_page,
    review_status,
    raw_payload,
    last_run_id,
    first_seen_at,
    last_seen_at,
    created_at,
    updated_at
)
select
    'rapidgator_raw' as search_site_code,
    'paco' as search_keyword,
    candidate.movie_code,
    coalesce(master.title, candidate.title) as title,
    coalesce(candidate.detail_url, candidate.rapidgator_url) as detail_url,
    candidate.rapidgator_url,
    candidate.link_href_url,
    'rapidgator_raw' as found_source,
    true as has_rapidgator,
    null as http_status,
    null as error_message,
    coalesce(candidate.source_page_url, candidate.rapidgator_url) as source_page_url,
    coalesce(nullif(candidate.page_number, '')::integer, 0) as page_number,
    coalesce(nullif(candidate.row_index_in_page, '')::integer, 0) as post_index_in_page,
    'matched_master' as review_status,
    jsonb_build_object(
        'source_table', 'public.xxx_tl002_rapidgator_raw',
        'source_view', 'cl.paco_v_rapidgator_raw_candidates',
        'raw_id', candidate.raw_id,
        'file_title', candidate.title,
        'file_size', candidate.file_size,
        'file_ext', candidate.file_ext,
        'folder_name', candidate.folder_name,
        'raw_row_count', candidate.raw_row_count,
        'mp4_row_count', candidate.mp4_row_count,
        'rar_row_count', candidate.rar_row_count,
        'global_seq', candidate.global_seq,
        'csv_part_no', candidate.csv_part_no,
        'file_seq', candidate.file_seq
    ) as raw_payload,
    'rapidgator_raw_paco_import' as last_run_id,
    now() as first_seen_at,
    now() as last_seen_at,
    now() as created_at,
    now() as updated_at
from cl.paco_v_rapidgator_raw_candidates candidate
join cl.paco_m001_master_staging master
  on master.movie_code = candidate.movie_code
where not exists (
    select 1
    from cl.paco_dl_reference existing
    where existing.movie_code = candidate.movie_code
      and existing.has_rapidgator = true
      and existing.review_status = 'matched_master'
);

grant select on cl.paco_v_rapidgator_raw_candidates to current_user;
