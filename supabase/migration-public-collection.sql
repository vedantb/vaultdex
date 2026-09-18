-- VaultDex migration: public read-only collection (2026-09-15).
--
-- Lets anyone (signed-out visitors AND signed-in non-owners) SELECT the
-- owner's collection rows so the collection page (stats, search, total
-- value) is public. All writes stay behind the existing owner-only
-- policies (user_id = auth.uid()). Browsing the catalog and editing are
-- gated by owner check (App.auth.isOwner()) in the app itself.
--
-- Run this once in the Supabase dashboard: SQL Editor -> paste -> Run.

drop policy if exists "collection_items_public_owner_read" on public.collection_items;

create policy "collection_items_public_owner_read"
  on public.collection_items for select
  to anon, authenticated
  using (user_id = '42853d76-0784-4539-b6b6-694e9031627b');
