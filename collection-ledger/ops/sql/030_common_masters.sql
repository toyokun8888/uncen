-- Common master tables shared by source-specific collectors.
-- This file is idempotent and does not remove table data.

create schema if not exists cl;

create table if not exists cl.site_master (
    site_id bigserial primary key,
    site_code text not null,
    site_name text not null,
    note text,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    constraint site_master_site_code_key unique (site_code)
);

create table if not exists cl.actor_group_master (
    actor_group_id bigserial primary key,
    group_code text not null,
    representative_actor_name text not null,
    note text,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    constraint actor_group_master_group_code_key unique (group_code)
);

create table if not exists cl.actor_name_master (
    actor_name_id bigserial primary key,
    actor_name text not null,
    site_id bigint not null references cl.site_master(site_id),
    actor_group_id bigint not null references cl.actor_group_master(actor_group_id),
    note text,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    constraint actor_name_master_site_actor_name_key unique (site_id, actor_name)
);

create index if not exists actor_name_master_site_id_idx
    on cl.actor_name_master (site_id);

create index if not exists actor_name_master_actor_group_id_idx
    on cl.actor_name_master (actor_group_id);

grant select, insert, update, delete on cl.site_master to current_user;
grant select, insert, update, delete on cl.actor_group_master to current_user;
grant select, insert, update, delete on cl.actor_name_master to current_user;

grant usage, select, update on sequence cl.site_master_site_id_seq to current_user;
grant usage, select, update on sequence cl.actor_group_master_actor_group_id_seq to current_user;
grant usage, select, update on sequence cl.actor_name_master_actor_name_id_seq to current_user;
