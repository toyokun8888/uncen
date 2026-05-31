-- paco download reference tables collected from external search pages.
-- This file is idempotent and does not remove table data.

create schema if not exists cl;

create table if not exists cl.paco_dl_reference_runs (
    run_id text primary key,
    search_site_code text not null,
    search_keyword text not null,
    mode text not null,
    started_at timestamp with time zone not null default now(),
    finished_at timestamp with time zone,
    status text not null default 'running',
    start_page integer not null,
    max_pages integer not null,
    pages_processed integer not null default 0,
    posts_found integer not null default 0,
    rows_written integer not null default 0,
    list_rg_found integer not null default 0,
    detail_rg_found integer not null default 0,
    no_rapidgator_count integer not null default 0,
    missing_master_count integer not null default 0,
    error_message text,
    note text
);

create table if not exists cl.paco_dl_reference_page_logs (
    id bigserial primary key,
    run_id text not null references cl.paco_dl_reference_runs(run_id) on delete cascade,
    page_number integer not null,
    page_url text not null,
    fetched_at timestamp with time zone not null default now(),
    status text not null,
    posts_found integer not null default 0,
    list_rg_found integer not null default 0,
    detail_fetch_count integer not null default 0,
    detail_rg_found integer not null default 0,
    no_rapidgator_count integer not null default 0,
    error_message text,
    note text
);

create table if not exists cl.paco_dl_reference (
    dl_reference_id bigserial primary key,
    search_site_code text not null,
    search_keyword text not null,
    movie_code text,
    title text,
    detail_url text,
    rapidgator_url text,
    link_href_url text,
    found_source text not null,
    has_rapidgator boolean not null default false,
    http_status integer,
    error_message text,
    source_page_url text not null,
    page_number integer not null,
    post_index_in_page integer not null,
    review_status text not null default 'pending',
    raw_payload jsonb not null default '{}'::jsonb,
    last_run_id text not null,
    first_seen_at timestamp with time zone not null default now(),
    last_seen_at timestamp with time zone not null default now(),
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now()
);

create unique index if not exists paco_dl_reference_source_keyword_movie_detail_uidx
    on cl.paco_dl_reference (
        search_site_code,
        search_keyword,
        coalesce(movie_code, ''),
        coalesce(detail_url, ''),
        coalesce(rapidgator_url, '')
    );

create index if not exists paco_dl_reference_movie_code_idx
    on cl.paco_dl_reference (movie_code);

create index if not exists paco_dl_reference_review_status_idx
    on cl.paco_dl_reference (review_status);

create index if not exists paco_dl_reference_has_rapidgator_idx
    on cl.paco_dl_reference (has_rapidgator);

create index if not exists paco_dl_reference_page_logs_run_id_idx
    on cl.paco_dl_reference_page_logs (run_id);

grant select, insert, update, delete on cl.paco_dl_reference_runs to current_user;
grant select, insert, update, delete on cl.paco_dl_reference_page_logs to current_user;
grant select, insert, update, delete on cl.paco_dl_reference to current_user;

grant usage, select, update on sequence cl.paco_dl_reference_page_logs_id_seq to current_user;
grant usage, select, update on sequence cl.paco_dl_reference_dl_reference_id_seq to current_user;
