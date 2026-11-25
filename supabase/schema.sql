-- TeamPick storage: one row per trip (plus one for learned department fixes).
-- Run this once in the Supabase SQL editor.

create table if not exists public.tp_docs (
  key        text primary key,          -- e.g. trips__tabc123
  data       jsonb not null,            -- the whole trip: customers, lines, assignments, checkout ticks
  v          text  not null,            -- changes on every write; used to detect simultaneous edits
  updated_at timestamptz not null default now()
);

create index if not exists tp_docs_updated_at on public.tp_docs (updated_at desc);

-- Row level security ON with no policies: the public (anon) key can read and write nothing.
-- Only the server routes, which hold the service key, can touch this table.
alter table public.tp_docs enable row level security;

-- Optional housekeeping: delete trips older than 30 days.
-- delete from public.tp_docs where key like 'trips\_\_%' and updated_at < now() - interval '30 days';
