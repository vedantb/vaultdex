-- VaultDex: physical binder tracking.
-- Run once in the Supabase dashboard: SQL Editor → paste → Run.
-- Requires Postgres 15+ (Supabase default) for UNIQUE NULLS NOT DISTINCT.
-- Idempotent: every statement uses IF NOT EXISTS / drop-if-exists.
--
-- APPLY THIS BEFORE the binder UI can save anything. The app code is
-- written to tolerate the table/column being absent (binder saves show a
-- friendly error until this has run); PostgREST 400s on unknown columns
-- in writes, so the picker will fail until this migration is applied.

create table if not exists public.binders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.binders enable row level security;

drop policy if exists "binders_owner_all" on public.binders;
create policy "binders_owner_all"
  on public.binders for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- One binder per collection row. Deleting a binder unassigns its cards
-- (SET NULL) rather than blocking the delete or dropping rows.
alter table public.collection_items
  add column if not exists binder_id uuid references public.binders(id) on delete set null;

create index if not exists collection_items_binder_id_idx
  on public.collection_items (binder_id);

-- Split copies: the same card+variant+grade can live in two binders as
-- two rows, so binder_id joins the row-identity unique constraint.
--
-- NULL-SAFETY: grading_company, grade, and binder_id are all nullable, and
-- plain UNIQUE treats NULLs as never-equal — so two unshelved ungraded
-- rows for the same card would NOT conflict. NULLS NOT DISTINCT (PG 15+)
-- makes NULL = NULL for the constraint, which is what the app's row
-- identity actually means.
--
-- DEDUPE FIRST: a past UI bug (2026-09-17) could insert duplicate rows, and
-- the old non-null-safe constraint never caught them. Merge exact-identity
-- duplicates now (GROUP BY already treats NULLs as equal) by summing
-- quantities into the earliest row, so the new constraint applies cleanly.
-- These statements are no-ops when no duplicates exist.
with dupes as (
  select min(id::text)::uuid as keep_id,
         sum(quantity) as total_qty
  from public.collection_items
  group by user_id, card_id, variant, grading_company, grade, binder_id
  having count(*) > 1
)
update public.collection_items ci
set quantity = d.total_qty
from dupes d
where ci.id = d.keep_id;

with dupes as (
  select min(id::text)::uuid as keep_id,
         array_agg(id) as ids
  from public.collection_items
  group by user_id, card_id, variant, grading_company, grade, binder_id
  having count(*) > 1
)
delete from public.collection_items ci
using dupes d
where ci.id = any(d.ids) and ci.id <> d.keep_id;

-- Replace the old row-identity constraints with the binder-aware,
-- null-safe one.
alter table public.collection_items
  drop constraint if exists collection_items_user_card_variant_grade_key;
alter table public.collection_items
  drop constraint if exists collection_items_user_id_card_id_variant_key;
alter table public.collection_items
  drop constraint if exists collection_items_user_card_variant_grade_binder_key;
alter table public.collection_items
  add constraint collection_items_user_card_variant_grade_binder_key
  unique nulls not distinct (user_id, card_id, variant, grading_company, grade, binder_id);
