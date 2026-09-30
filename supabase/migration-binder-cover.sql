-- Persist each binder's cover art so its color never changes, no matter how
-- many covers are added to the rotation later. Run in the Supabase dashboard
-- SQL editor (project: vaultdex).

alter table public.binders
  add column if not exists cover text;

-- Backfill the covers currently assigned by the app's deterministic picker
-- (8-color rotation), so nothing visually changes for existing binders.
update public.binders set cover = 'binder-teal'
  where id = '3f2647ef-fdc0-42b5-9d3a-78bf1d4230e0' and cover is null; -- 30th Japanese binder
update public.binders set cover = 'binder-blue'
  where id = '845ec22e-17c7-45e0-ba08-9f15b1a43bdb' and cover is null; -- 30th anniversary - English
update public.binders set cover = 'binder-teal'
  where id = 'd4b483f9-fc3d-4016-be81-1f3c254d5529' and cover is null; -- Toploader binder
