-- VaultDex migration bundle: six-feature release (2026-09-16).
-- Run once in the Supabase dashboard: SQL Editor → paste → Run.
-- Idempotent: every statement uses IF NOT EXISTS / DROP IF EXISTS.
--
-- APPLY THIS BEFORE DEPLOYING. The app code references the new columns
-- (graded cards in particular); PostgREST 400s on unknown columns, so the
-- collection add flow breaks until this migration has run.

-- ============ Feature 2: Wishlist (private, owner-only) ============
create table if not exists public.wishlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  card_id text not null,
  card_name text,
  set_id text,
  set_name text,
  number text,
  variant text,
  image_small text,
  market_price numeric,
  price_currency text not null default 'USD',
  added_at timestamptz not null default now(),
  unique (user_id, card_id)
);
alter table public.wishlist enable row level security;
drop policy if exists "wishlist_owner_all" on public.wishlist;
create policy "wishlist_owner_all" on public.wishlist for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No public/anon read policy: the wishlist stays private to the owner.

-- ============ Feature 3: value graph (owner update on snapshots) ============
drop policy if exists "snapshots_owner_update" on public.collection_value_snapshots;
create policy "snapshots_owner_update"
  on public.collection_value_snapshots for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============ Feature 4: price movers ============
alter table public.collection_items add column if not exists prev_price numeric;
alter table public.collection_items add column if not exists prev_price_at timestamptz;

-- ============ Feature 5: graded cards ============
alter table public.collection_items add column if not exists grading_company text;
alter table public.collection_items add column if not exists grade text;
-- Widen the dedupe key so a graded and an ungraded copy of the same
-- card+variant are distinct rows. Postgres treats NULLs as distinct in
-- unique constraints, so existing (NULL grading) rows are unaffected.
alter table public.collection_items
  drop constraint if exists collection_items_user_id_card_id_variant_key;
alter table public.collection_items
  add constraint collection_items_user_card_variant_grade_key
  unique (user_id, card_id, variant, grading_company, grade);

-- ============ Feature 6: trade binder ============
alter table public.collection_items
  add column if not exists trade_qty integer check (trade_qty >= 0);
-- No new RLS policies: the existing owner-all / public-read policies on
-- collection_items are row-level, so SELECT * picks up trade_qty
-- automatically under the same owner-write/public-read split.
