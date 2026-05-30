-- paco master raw/staging tables for collection-ledger.
-- This file does not remove table data. Constraint updates may be applied when
-- source evidence changes a key decision.

create schema if not exists cl;

create table if not exists cl.paco_m001_master_collect_runs (
    run_id text primary key,
    source_name text not null default 'paco',
    mode text not null,
    started_at timestamp with time zone not null default now(),
    finished_at timestamp with time zone,
    status text not null default 'running',
    pages_requested integer not null default 0,
    pages_processed integer not null default 0,
    rows_collected integer not null default 0,
    rows_inserted integer not null default 0,
    rows_updated integer not null default 0,
    error_message text,
    note text
);

create table if not exists cl.paco_m001_master_page_logs (
    id bigserial primary key,
    run_id text not null,
    page_number integer not null,
    page_url text not null,
    fetched_at timestamp with time zone not null default now(),
    status text not null,
    rows_found integer not null default 0,
    rows_written integer not null default 0,
    error_message text,
    note text
);

create table if not exists cl.paco_m001_master_raw (
    id bigserial primary key,
    relation_key_mmddyy text not null,
    release_date date not null,
    movie_code text not null unique,
    movie_code_suffix text,
    title text not null,
    actor_name text,
    channel_name text,
    detail_path text not null,
    detail_url text not null,
    thumbnail_url text,
    source_page_url text not null,
    page_number integer not null,
    row_index_in_page integer not null,
    raw_payload jsonb not null,
    last_run_id text not null,
    collected_at timestamp with time zone not null default now(),
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now()
);

create table if not exists cl.paco_m001_master_staging (
    relation_key_mmddyy text not null,
    release_date date not null,
    movie_code text primary key,
    movie_code_suffix text,
    title text not null,
    actor_name text,
    channel_name text,
    detail_url text not null,
    thumbnail_url text,
    raw_id bigint references cl.paco_m001_master_raw(id),
    review_status text not null default 'pending',
    approved boolean not null default false,
    note text,
    last_run_id text not null,
    staged_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now()
);

alter table cl.paco_m001_master_raw
    drop constraint if exists paco_m001_master_raw_relation_key_mmddyy_key;

alter table cl.paco_m001_master_staging
    drop constraint if exists paco_m001_master_staging_pkey;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'cl.paco_m001_master_staging'::regclass
          and contype = 'p'
    ) then
        alter table cl.paco_m001_master_staging
            add constraint paco_m001_master_staging_pkey primary key (movie_code);
    end if;
end $$;

create index if not exists paco_m001_master_raw_release_date_idx
    on cl.paco_m001_master_raw (release_date);

create index if not exists paco_m001_master_raw_relation_key_mmddyy_idx
    on cl.paco_m001_master_raw (relation_key_mmddyy);

create index if not exists paco_m001_master_raw_last_run_id_idx
    on cl.paco_m001_master_raw (last_run_id);

create index if not exists paco_m001_master_staging_release_date_idx
    on cl.paco_m001_master_staging (release_date);

create index if not exists paco_m001_master_staging_relation_key_mmddyy_idx
    on cl.paco_m001_master_staging (relation_key_mmddyy);

create index if not exists paco_m001_master_page_logs_run_id_idx
    on cl.paco_m001_master_page_logs (run_id);
