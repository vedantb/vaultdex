-- VaultDex migration: public read-only binders (2026-09-29).
--
-- Lets anyone (signed-out visitors AND signed-in non-owners) SELECT the
-- owner's binder rows (id, name, position, slot_order, ...) so the
-- /binders hub and /binder/<id> flip-through are public and view-only.
-- All writes stay behind the existing owner-only policies
-- (user_id = auth.uid()). Editing affordances (new/manage/add cards,
-- drag-and-drop) are gated by the owner check (App.auth.isOwner()) in
-- the app itself.
--
-- Run this once in the Supabase dashboard: SQL Editor -> paste -> Run.

drop policy if exists "binders_public_owner_read" on public.binders;

create policy "binders_public_owner_read"
  on public.binders for select
  to anon, authenticated
  using (user_id = '42853d76-0784-4539-b6b6-694e9031627b');
