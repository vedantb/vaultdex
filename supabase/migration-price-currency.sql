-- VaultDex migration: price currency on collection_items (2026-09-23).
--
-- Adds:
--   price_currency  text  — ISO currency of market_price/prev_price
--                          ("USD", "EUR", …). PkmnPrices returns the price
--                          currency with every lookup (nearMintPrice and
--                          gradedPrice), but the collection rows only stored
--                          the number — Japanese rows priced in EUR rendered
--                          as "$" on movers and collection tiles.
--
-- Run this once in the Supabase dashboard: SQL Editor → paste → Run.
--
-- The app probes for this column at runtime and works both before and
-- after the migration: before, it omits price_currency from writes and
-- treats every stored price as USD; after, it writes and reads the real
-- currency.

alter table public.collection_items
  add column if not exists price_currency text not null default 'USD';
