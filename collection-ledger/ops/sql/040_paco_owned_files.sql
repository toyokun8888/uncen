-- paco owned file tables.
-- This file is idempotent and does not remove table data.

create schema if not exists cl;

create table if not exists cl.paco_owned_file (
    owned_file_id bigserial primary key,
    source_site_id bigint not null references cl.site_master(site_id),
    movie_code text not null references cl.paco_m001_master_staging(movie_code),
    file_path text not null,
    file_name text not null,
    file_ext text,
    drive_letter text,
    file_size_bytes bigint,
    file_mtime timestamp with time zone,
    last_seen_at timestamp with time zone not null default now(),
    note text,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    constraint paco_owned_file_file_path_key unique (file_path)
);

create table if not exists cl.paco_owned_file_actor (
    owned_file_actor_id bigserial primary key,
    owned_file_id bigint not null references cl.paco_owned_file(owned_file_id) on delete cascade,
    actor_name_id bigint not null references cl.actor_name_master(actor_name_id),
    actor_group_id bigint not null references cl.actor_group_master(actor_group_id),
    created_at timestamp with time zone not null default now(),
    constraint paco_owned_file_actor_owned_actor_key unique (owned_file_id, actor_name_id)
);

create index if not exists paco_owned_file_source_site_id_idx
    on cl.paco_owned_file (source_site_id);

create index if not exists paco_owned_file_movie_code_idx
    on cl.paco_owned_file (movie_code);

create index if not exists paco_owned_file_drive_letter_idx
    on cl.paco_owned_file (drive_letter);

create index if not exists paco_owned_file_actor_owned_file_id_idx
    on cl.paco_owned_file_actor (owned_file_id);

create index if not exists paco_owned_file_actor_actor_name_id_idx
    on cl.paco_owned_file_actor (actor_name_id);

create index if not exists paco_owned_file_actor_actor_group_id_idx
    on cl.paco_owned_file_actor (actor_group_id);

grant select, insert, update, delete on cl.paco_owned_file to current_user;
grant select, insert, update, delete on cl.paco_owned_file_actor to current_user;

grant usage, select, update on sequence cl.paco_owned_file_owned_file_id_seq to current_user;
grant usage, select, update on sequence cl.paco_owned_file_actor_owned_file_actor_id_seq to current_user;
