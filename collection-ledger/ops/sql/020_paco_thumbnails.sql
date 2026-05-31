-- paco thumbnail asset/run tables for collection-ledger.
-- Additive only. This file does not remove existing data.

create schema if not exists cl;

create table if not exists cl.paco_m001_thumbnail_assets (
    movie_code text primary key,
    thumbnail_url text not null,
    local_thumbnail_path text not null default '',
    local_thumbnail_file_name text not null default '',
    thumbnail_status text not null default 'pending'
        check (thumbnail_status in ('pending', 'collected', 'failed', 'missing_url')),
    bytes bigint,
    sha256 text,
    content_type text,
    attempt_count integer not null default 0,
    last_error text,
    last_checked_at timestamp with time zone,
    downloaded_at timestamp with time zone,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now()
);

create table if not exists cl.paco_m001_thumbnail_runs (
    run_id text primary key,
    run_status text not null default 'running',
    target_scope text not null default 'paco_m001_master',
    max_downloads integer not null default 0,
    min_delay_ms integer not null default 0,
    max_delay_ms integer not null default 0,
    targets_found integer not null default 0,
    success_count integer not null default 0,
    failed_count integer not null default 0,
    existing_file_count integer not null default 0,
    run_started_at timestamp with time zone not null default now(),
    run_finished_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone not null default now()
);

create table if not exists cl.paco_m001_thumbnail_run_items (
    id bigserial primary key,
    run_id text not null references cl.paco_m001_thumbnail_runs(run_id),
    movie_code text not null,
    thumbnail_url text not null,
    local_thumbnail_path text not null default '',
    local_thumbnail_file_name text not null default '',
    item_status text not null,
    bytes bigint,
    sha256 text,
    content_type text,
    delay_ms integer,
    error_message text,
    attempt_count integer not null default 0,
    created_at timestamp with time zone not null default now()
);

create index if not exists paco_m001_thumbnail_assets_status_idx
    on cl.paco_m001_thumbnail_assets (thumbnail_status);

create index if not exists paco_m001_thumbnail_assets_downloaded_at_idx
    on cl.paco_m001_thumbnail_assets (downloaded_at);

create index if not exists paco_m001_thumbnail_run_items_run_id_idx
    on cl.paco_m001_thumbnail_run_items (run_id);

create index if not exists paco_m001_thumbnail_run_items_movie_code_idx
    on cl.paco_m001_thumbnail_run_items (movie_code);
