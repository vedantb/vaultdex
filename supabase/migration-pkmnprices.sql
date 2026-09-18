-- VaultDex migration: PkmnPrices pricing support (2026-09-14).
--
-- Adds:
--   number        text  — the card's number within its set ("276"), used to map
--                         each collection row to its exact PkmnPrices printing
--                         by set + number (never by name alone).
--   price_source  text  — which feed set market_price ("pkmnprices" or null
--                         for the legacy Pokémon TCG API path).
--
-- Run this once in the Supabase dashboard: SQL Editor → paste → Run.

alter table public.collection_items
  add column if not exists number text,
  add column if not exists price_source text;

-- Backfill `number` from the Pokémon TCG API card id ("me2pt5-276" → "276").
update public.collection_items
set number = substring(card_id from '-([A-Za-z0-9]+)$')
where number is null
  and card_id ~ '-([A-Za-z0-9]+)$';
