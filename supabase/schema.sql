-- VaultDex — Supabase schema (idempotent; safe to run multiple times)
-- Run this in the Supabase dashboard: SQL Editor -> New query -> paste -> Run

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, created on first sign-in
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- collection_items: the user's personal card collection
-- ---------------------------------------------------------------------------
create table if not exists public.collection_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  card_id text not null,          -- Pokémon TCG API card id, e.g. "sv3pt5-1"
  card_name text not null,
  set_id text,
  set_name text,
  image_small text,
  image_large text,
  artist text,
  rarity text,
  variant text not null default 'normal',  -- normal | holofoil | reverseHolofoil
  quantity int not null default 1 check (quantity > 0),
  market_price numeric,            -- cached TCGPlayer market price (USD)
  price_updated_at timestamptz,
  added_at timestamptz not null default now(),
  unique (user_id, card_id, variant)
);

alter table public.collection_items enable row level security;

drop policy if exists "collection_items_owner_all" on public.collection_items;
create policy "collection_items_owner_all"
  on public.collection_items for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- trade_listings: phase-2 ready (no UI yet). Open listings are visible to
-- all signed-in users; users fully manage only their own listings.
-- ---------------------------------------------------------------------------
create table if not exists public.trade_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  collection_item_id uuid not null references public.collection_items(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'traded', 'cancelled')),
  notes text,
  created_at timestamptz not null default now()
);

alter table public.trade_listings enable row level security;

drop policy if exists "trade_listings_select_open" on public.trade_listings;
create policy "trade_listings_select_open"
  on public.trade_listings for select
  to authenticated
  using (status = 'open');

drop policy if exists "trade_listings_owner_all" on public.trade_listings;
create policy "trade_listings_owner_all"
  on public.trade_listings for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Trigger: create a profiles row automatically when a new auth user signs up
-- (the app also upserts the profile on login as a fallback)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
