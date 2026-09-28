-- VaultDex: transactional move-copies between binders.
-- Run once in the Supabase dashboard: SQL Editor → paste → Run.
-- Idempotent: CREATE OR REPLACE + REVOKE/GRANT are safe to re-run.
--
-- Why an RPC: moving copies used to be 2–3 separate client writes
-- (insert the moved row, then decrement the source). If the second write
-- failed, quantities duplicated or vanished. This function does the whole
-- move in one transaction, and merges into an identical target row when
-- one already exists (the old client code would have hit the
-- user_id/card_id/variant/grading_company/grade/binder_id uniqueness
-- constraint instead).
--
-- SECURITY DEFINER: the function runs as the owner so it can lock and
-- rewrite the user's rows atomically. Ownership is enforced manually
-- inside (auth.uid() must own the source row and the target binder),
-- and EXECUTE is granted only to `authenticated`.

create or replace function public.move_binder_copies(
  p_row_id uuid,
  p_move_qty int,
  p_target_binder_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  src collection_items%rowtype;
  tgt collection_items%rowtype;
  new_row collection_items%rowtype;
begin
  -- Lock the source row and prove ownership.
  select * into src
  from public.collection_items
  where id = p_row_id
  for update;

  if not found then
    raise exception 'Card row not found.';
  end if;
  if src.user_id is distinct from auth.uid() then
    raise exception 'Not your collection.';
  end if;

  if p_move_qty is null or p_move_qty < 1 or p_move_qty > src.quantity then
    raise exception 'Move between 1 and % copies.', src.quantity;
  end if;

  -- The target binder must belong to the caller (NULL = unshelved).
  if p_target_binder_id is not null then
    perform 1 from public.binders
    where id = p_target_binder_id and user_id = auth.uid();
    if not found then
      raise exception 'Binder not found.';
    end if;
  end if;

  if src.binder_id is not distinct from p_target_binder_id then
    raise exception 'Those copies are already in that binder.';
  end if;

  -- An identical row may already sit in the target binder (same
  -- card+variant+grading). The uniqueness constraint is on
  -- (user_id, card_id, variant, grading_company, grade, binder_id)
  -- NULLS NOT DISTINCT, so match it exactly — a blind insert would
  -- collide here.
  select * into tgt
  from public.collection_items
  where id <> src.id
    and user_id = src.user_id
    and card_id = src.card_id
    and variant = src.variant
    and grading_company is not distinct from src.grading_company
    and grade is not distinct from src.grade
    and binder_id is not distinct from p_target_binder_id
  for update;

  if p_move_qty = src.quantity then
    -- Whole row moves: re-shelve, merging when a twin exists.
    if tgt.id is not null then
      update public.collection_items
         set quantity = tgt.quantity + src.quantity
       where id = tgt.id;
      delete from public.collection_items where id = src.id;
    else
      update public.collection_items
         set binder_id = p_target_binder_id
       where id = src.id;
    end if;
  else
    -- Partial move: split. Pricing, variant, grading and every other
    -- column travel with the copies; only quantity and binder change.
    if tgt.id is not null then
      update public.collection_items
         set quantity = tgt.quantity + p_move_qty
       where id = tgt.id;
    else
      new_row := src;
      new_row.id := gen_random_uuid();
      new_row.quantity := p_move_qty;
      new_row.binder_id := p_target_binder_id;
      new_row.added_at := now();
      insert into public.collection_items select new_row.*;
    end if;
    update public.collection_items
       set quantity = src.quantity - p_move_qty
     where id = src.id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.move_binder_copies(uuid, int, uuid) from public;
grant execute on function public.move_binder_copies(uuid, int, uuid) to authenticated;
