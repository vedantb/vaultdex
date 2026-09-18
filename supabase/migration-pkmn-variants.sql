-- VaultDex migration: per-variant collection tracking (2026-09-15).
--
-- Adds:
--   pkmn_id  integer — the exact PkmnPrices card record for this row's print
--                      variant (e.g. base vs "Energy Symbol Pattern" vs
--                      "Poke Ball", which share one set + card number).
--                      Null for rows added before per-variant checkboxes;
--                      those are backfilled lazily by the app.
--
-- Run this once in the Supabase dashboard: SQL Editor → paste → Run.

alter table public.collection_items
  add column if not exists pkmn_id integer;
