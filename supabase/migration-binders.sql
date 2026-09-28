-- VaultDex: physical binder tracking.
-- Run once in the Supabase dashboard: SQL Editor → paste → Run.
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
-- (NULL binder_ids never conflict in Postgres, and every existing row is
-- NULL here, so this loosens — never tightens — and always applies cleanly.)
alter table public.collection_items
  drop constraint if exists collection_items_user_card_variant_grade_key;
alter table public.collection_items
  drop constraint if exists collection_items_user_id_card_id_variant_key;
alter table public.collection_items
  add constraint collection_items_user_card_variant_grade_binder_key
  unique (user_id, card_id, variant, grading_company, grade, binder_id);
