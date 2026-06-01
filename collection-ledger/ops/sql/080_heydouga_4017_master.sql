-- Heydouga 4017 master raw/staging/final tables.
-- This file is idempotent and does not remove table data.

create schema if not exists cl;

create table if not exists cl.heydouga_4017_m002_master_collect_runs (
    run_id text primary key,
    source_name text not null default 'heydouga_4017',
    mode text not null,
    params jsonb not null default '{}'::jsonb,
    started_at timestamp with time zone not null default now(),
    finished_at timestamp with time zone,
    status text not null default 'running',
    rows_collected integer not null default 0,
    rows_inserted integer not null default 0,
    rows_updated integer not null default 0,
    error_message text,
    note text
);

create table if not exists cl.heydouga_4017_m002_master_page_logs (
    id bigserial primary key,
    run_id text not null references cl.heydouga_4017_m002_master_collect_runs(run_id),
    source_site text not null,
    page_number integer not null,
    fetched_url text not null,
    fetched_at timestamp with time zone not null default now(),
    http_status integer,
    content_hash text,
    row_count integer not null default 0,
    selected_count integer not null default 0,
    status text not null,
    error_message text,
    note text
);

create table if not exists cl.heydouga_4017_m002_master_raw (
    raw_id bigserial primary key,
    source_site text not null,
    source_priority integer not null,
    source_page_url text not null,
    page_number integer not null,
    row_index_in_page integer not null,
    raw_title text not null,
    raw_detail_url text not null,
    raw_thumb_url text,
    candidate_unique_key text,
    candidate_base_no text,
    candidate_branch_no text,
    extraction_status text not null,
    extraction_note text,
    raw_payload jsonb not null,
    last_run_id text not null references cl.heydouga_4017_m002_master_collect_runs(run_id),
    collected_at timestamp with time zone not null default now(),
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    constraint heydouga_4017_m002_master_raw_source_url_key
        unique (source_site, raw_detail_url)
);

create table if not exists cl.heydouga_4017_m002_master_staging (
    staging_id bigserial primary key,
    raw_id bigint not null references cl.heydouga_4017_m002_master_raw(raw_id),
    candidate_unique_key text,
    candidate_base_no text,
    candidate_branch_no text,
    confirmed_unique_key text,
    confirmed_base_no text,
    confirmed_branch_no text,
    title text,
    detail_url text,
    thumbnail_url text,
    source_site text not null,
    source_priority integer not null,
    review_status text not null default 'pending',
    note text,
    last_run_id text not null references cl.heydouga_4017_m002_master_collect_runs(run_id),
    staged_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    constraint heydouga_4017_m002_master_staging_raw_id_key unique (raw_id),
    constraint heydouga_4017_m002_master_staging_review_status_chk
        check (review_status in ('pending', 'approved', 'rejected', 'needs_review'))
);

create table if not exists cl.heydouga_4017_m002_master (
    unique_key text primary key,
    base_no text not null,
    branch_no text not null,
    title text not null,
    detail_url text,
    thumbnail_url text,
    thumbnail_file_path text,
    primary_source_site text not null,
    primary_staging_id bigint references cl.heydouga_4017_m002_master_staging(staging_id),
    review_status text not null default 'approved',
    note text,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    constraint heydouga_4017_m002_master_review_status_chk
        check (review_status in ('approved', 'manual_added', 'deprecated'))
);

create index if not exists heydouga_4017_m002_master_raw_last_run_id_idx
    on cl.heydouga_4017_m002_master_raw (last_run_id);

create index if not exists heydouga_4017_m002_master_raw_candidate_unique_key_idx
    on cl.heydouga_4017_m002_master_raw (candidate_unique_key);

create index if not exists heydouga_4017_m002_master_raw_source_site_idx
    on cl.heydouga_4017_m002_master_raw (source_site);

create index if not exists heydouga_4017_m002_master_staging_candidate_unique_key_idx
    on cl.heydouga_4017_m002_master_staging (candidate_unique_key);

create index if not exists heydouga_4017_m002_master_staging_confirmed_unique_key_idx
    on cl.heydouga_4017_m002_master_staging (confirmed_unique_key);

create index if not exists heydouga_4017_m002_master_staging_review_status_idx
    on cl.heydouga_4017_m002_master_staging (review_status);

create index if not exists heydouga_4017_m002_master_base_no_idx
    on cl.heydouga_4017_m002_master (base_no);

create index if not exists heydouga_4017_m002_master_page_logs_run_id_idx
    on cl.heydouga_4017_m002_master_page_logs (run_id);

grant select, insert, update on cl.heydouga_4017_m002_master_collect_runs to current_user;
grant select, insert, update on cl.heydouga_4017_m002_master_page_logs to current_user;
grant select, insert, update on cl.heydouga_4017_m002_master_raw to current_user;
grant select, insert, update on cl.heydouga_4017_m002_master_staging to current_user;
grant select, insert, update on cl.heydouga_4017_m002_master to current_user;

grant usage, select, update on sequence cl.heydouga_4017_m002_master_page_logs_id_seq to current_user;
grant usage, select, update on sequence cl.heydouga_4017_m002_master_raw_raw_id_seq to current_user;
grant usage, select, update on sequence cl.heydouga_4017_m002_master_staging_staging_id_seq to current_user;
