-- collection-ledger initial schema
-- Run with psql variable app_role set to the existing DB role.
-- Example:
--   psql -v app_role=your_existing_role -f ops/sql/001_init_schema.sql

create schema if not exists cl;

grant usage, create on schema cl to :app_role;

alter default privileges in schema cl
  grant select, insert, update, delete on tables to :app_role;

alter default privileges in schema cl
  grant usage, select, update on sequences to :app_role;

grant select, insert, update, delete on all tables in schema cl to :app_role;
grant usage, select, update on all sequences in schema cl to :app_role;
