# VaultDex — Pokémon TCG Collection Manager

A standalone web app for tracking your Pokémon TCG collection, with live market values. Vanilla HTML/CSS/JS — no build step, no framework. Deploy it by dragging the folder onto Netlify or Vercel.

## Features

- **Google sign-in** via Supabase Auth — your collection is private to your account
- **Card search** across the full Pokémon TCG catalog: by name, artist, set, rarity, type, and market-value range
- **Set browser** — preview every card in a set, tap to multi-select, bulk-add to your collection
- **Collection manager** — quantity steppers, remove, sort (name / value / set / recently added), and filters for name, artist, set, and value range
- **Live market values** — TCGPlayer prices per print variant, with a one-click price refresh
- **Card detail modal** — large artwork, variant picker with per-variant prices, flavor text
- **Light/dark mode**, responsive mobile layout, loading skeletons and friendly empty states throughout
- **Phase-2 ready schema** — `trade_listings` table with Row Level Security already in place for future trading features

## Tech

| Piece | Choice |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (hash-routed SPA) |
| Auth + database | Supabase (Google OAuth, Postgres + RLS) |
| Card data + prices | [Pokémon TCG API](https://pokemontcg.io) (live, no key required) |
| Hosting | Any static host (Netlify / Vercel / GitHub Pages) |

All card data — names, artwork, sets, artists, prices — comes live from the Pokémon TCG API. Nothing is invented or hard-coded.

## Run locally

```bash
cd pokemon-tcg-app
python3 -m http.server 8000
# open http://localhost:8000
```

(Or `npx serve .` — any static file server works.)

## Deploy

**Netlify:** drag the `pokemon-tcg-app` folder onto [Netlify Drop](https://app.netlify.com/drop).
**Vercel:** run `vercel` inside the folder, or import it as a static project — no build command needed.

## Setup

You need a Supabase project + Google OAuth credentials before sign-in and saving work (browsing cards works without them). Follow the exact steps in **[SETUP.md](SETUP.md)**.

## Project layout

```
pokemon-tcg-app/
├── index.html              # SPA shell, header, footer, script tags
├── css/styles.css          # Design system (light/dark, responsive)
├── js/
│   ├── config.js           # Supabase URL + anon key (placeholders — fill in yours)
│   ├── supabase-client.js  # Supabase client singleton
│   ├── tcg-api.js          # Pokémon TCG API client (search, sets, prices)
│   ├── ui.js               # Icons, toasts, modals, skeletons, formatting
│   ├── auth.js             # Google OAuth sign-in/out, profile upsert
│   ├── collection.js       # Collection CRUD + price refresh (auth-gated)
│   ├── app.js              # Theme, header, hash router (#/browse, #/set/:id, #/collection)
│   ├── views/
│   │   ├── browse.js       # Search tab + set browser tab
│   │   ├── set-view.js     # Set detail: paginated grid, multi-select, bulk add
│   │   └── collection-view.js  # Stats, filters, steppers, price refresh
│   └── components/
│       └── card-modal.js   # Card detail modal with variant picker
├── supabase/
│   └── schema.sql          # Tables, RLS policies, new-user trigger (idempotent)
├── SETUP.md                # Step-by-step setup guide
└── README.md               # This file
```

## Notes

- Prices shown are TCGPlayer **market** values in USD, cached on your collection rows and refreshable on demand.
- The optional Pokémon TCG API key (Settings → gear icon) is stored only in the browser's localStorage and sent as an `X-Api-Key` header.
- Fan project — not affiliated with Nintendo, Creatures Inc., or GAME FREAK inc.
