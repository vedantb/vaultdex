-- VaultDex — condition column for collection_items.
--
-- The /scan confirm sheet (js/views/scan-view.js) was spec'd with a
-- condition selector. collection_items currently has NO condition column,
-- so the sheet renders a fixed "Near Mint" (the condition every price is
-- computed at). This migration adds the column and a default constraint.
--
-- STATUS: NOT APPLIED. The scanner UI is fully built and honest without
-- it — the sheet says "Near Mint" and never claims condition is persisted.
-- Apply this only after explicit owner approval (it touches the live DB).
--
-- Applying (Supabase SQL editor or psql):
--   1. ALTER TABLE public.collection_items
--        ADD COLUMN IF NOT EXISTS condition text
--        DEFAULT 'Near Mint'
--        CHECK (condition IN ('Near Mint','Lightly Played','Moderately Played','Heavily Played','Damaged'));
--   2. UPDATE public.collection_items SET condition = 'Near Mint' WHERE condition IS NULL;
--   3. Enable RLS for the new column — RLS is table-level and already
--      covers collection_items, so no new policy is needed.
--
-- After applying:
--   - backfill the ~thousands of existing rows: their prices are Near Mint
--     market, so defaulting them to 'Near Mint' is the honest choice;
--   - swap the sheet's fixed label for a real <select> in scan-view.js
--     (search for the scan-condition marker);
--   - thread `condition` through App.collection.addItem() like the
--     existing grading param (collection.js, graded.js).

ALTER TABLE public.collection_items
  ADD COLUMN IF NOT EXISTS condition text
  DEFAULT 'Near Mint'
  CHECK (condition IN ('Near Mint','Lightly Played','Moderately Played','Heavily Played','Damaged'));
