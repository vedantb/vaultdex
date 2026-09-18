-- VaultDex migration: daily collection value snapshots (2026-09-16).
--
-- Powers the "value over time" chart on the collection hub. One row per
-- owner per day (UTC); the app upserts after price refreshes and on the
-- owner's hub visits, so history builds on its own from here.
--
-- Run once in the Supabase dashboard: SQL Editor -> paste -> Run.

create table if not exists public.collection_value_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  total_value numeric not null,
  card_count integer not null default 0,
  day date not null default (now() at time zone 'utc')::date,
  recorded_at timestamptz not null default now(),
  unique (user_id, day)
);

alter table public.collection_value_snapshots enable row level security;

drop policy if exists "snapshots_owner_read" on public.collection_value_snapshots;
create policy "snapshots_owner_read"
  on public.collection_value_snapshots for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "snapshots_owner_write" on public.collection_value_snapshots;
create policy "snapshots_owner_write"
  on public.collection_value_snapshots for insert
  to authenticated
  with check (auth.uid() = user_id);

-- The same-day upsert (on-conflict-update on (user_id, day)) needs an
-- UPDATE policy: without it the conflict path fails under RLS and the
-- second snapshot of the day is dropped.
drop policy if exists "snapshots_owner_update" on public.collection_value_snapshots;
create policy "snapshots_owner_update"
  on public.collection_value_snapshots for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Visitors see the same public hub as the owner: read-only access to the
-- owner's snapshot rows (mirrors collection_items_public_owner_read).
drop policy if exists "snapshots_public_owner_read" on public.collection_value_snapshots;
create policy "snapshots_public_owner_read"
  on public.collection_value_snapshots for select
  to anon, authenticated
  using (user_id = '42853d76-0784-4539-b6b6-694e9031627b');
