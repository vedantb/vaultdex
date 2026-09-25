-- VaultDex migration: plausibility-quarantine columns on collection_items (2026-09-25).
--
-- Adds:
--   price_pending     numeric      — a candidate price parked by the
--                                    plausibility gate (see pricePlausibility
--                                    in js/collection.js). When a refresh
--                                    computes a price >=10x (or <=0.1x) the
--                                    stored price for a $5+ row, the
--                                    displayed price is NOT overwritten;
--                                    the candidate waits here instead.
--   price_pending_at  timestamptz  — when the candidate was parked.
--
-- Only when the NEXT refresh computes the same extreme value is it
-- confirmed and written — a one-off bad lookup (wrong printing, bad
-- comps, provider glitch) can never move the collection total or carve a
-- fake spike/cliff into the value graph again. Legitimate spikes land
-- 24h later; the graph stays honest.
--
-- Run this once in the Supabase dashboard: SQL Editor → paste → Run.
--
-- The app probes for these columns at runtime and works both before and
-- after the migration: before, the gate is inactive and extreme prices
-- are written with a loud console warning (today's behavior); after, the
-- two-confirmation quarantine is enforced.

alter table public.collection_items
  add column if not exists price_pending numeric null,
  add column if not exists price_pending_at timestamptz null;
