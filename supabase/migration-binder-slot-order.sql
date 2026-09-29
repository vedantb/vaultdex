-- VaultDex: manual binder slot order (drag-and-drop arranging).
-- Run once in the Supabase dashboard: SQL Editor → paste → Run.
-- Idempotent: uses IF NOT EXISTS.
--
-- slot_order is a JSONB array of collection_items ids (uuid strings) or
-- nulls, where the array index IS the pocket index on the binder pages
-- (page = floor(index / 9), pocket = index % 9). A collection row with
-- quantity N occupies N entries. Null entries are empty sleeves.
-- The app seeds it from the default binder order on first view and keeps
-- it reconciled as cards are shelved, moved, or unshelved; every drag
-- writes it back. Until this migration is applied the app keeps the
-- arrangement in memory for the session.

alter table public.binders
  add column if not exists slot_order jsonb;
