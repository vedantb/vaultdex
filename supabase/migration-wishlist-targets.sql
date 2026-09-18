-- VaultDex: wishlist target prices (in-app deals).
-- Run once in the Supabase dashboard: SQL Editor → paste → Run.
-- Idempotent: every statement uses IF NOT EXISTS.
--
-- APPLY THIS BEFORE the deals UI can save targets. The app code is written
-- to tolerate the columns being absent (target saves show a friendly error
-- until this has run); PostgREST 400s on unknown columns in writes, so the
-- editor will fail until this migration is applied.

alter table public.wishlist
  add column if not exists target_price numeric;
alter table public.wishlist
  add column if not exists target_currency text not null default 'USD';
alter table public.wishlist
  add column if not exists target_hit_at timestamptz;

-- No RLS changes: the new columns inherit the table's owner-only policy.
