# VaultDex — Setup Guide

Follow these steps in order. Takes about 10 minutes, most of it clicking through consoles.

## 1. Create a free Supabase project

1. Go to [supabase.com](https://supabase.com) and sign up / log in.
2. Click **New project**, pick a name (e.g. `vaultdex`), set a database password, choose a region near you.
3. Wait for the project to finish provisioning, then note your **project ref** — it's the subdomain in your project URL, e.g. `xyzcompany` in `https://xyzcompany.supabase.co`.

## 2. Create Google OAuth credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services** → **Credentials**.
2. If prompted, **configure the OAuth consent screen** first (External user type, fill in app name + your email — that's all that's needed for testing).
3. Click **Create Credentials** → **OAuth client ID** → application type **Web application**.
4. Under **Authorized redirect URIs**, add exactly:
   ```
   https://<PROJECT_REF>.supabase.co/auth/v1/callback
   ```
   replacing `<PROJECT_REF>` with the ref from step 1.
5. Click **Create**, then copy the **Client ID** and **Client Secret**.

## 3. Enable Google sign-in in Supabase

1. In the Supabase dashboard, go to **Authentication** → **Providers**.
2. Find **Google** in the list and enable it.
3. Paste the **Client ID** and **Client Secret** from step 2, then **Save**.

## 4. Create the database tables

1. In the Supabase dashboard, go to **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this project, copy its entire contents, paste into the editor.
3. Click **Run**. You should see "Success. No rows returned."
4. (Optional) Verify under **Table Editor** that `profiles`, `collection_items`, and `trade_listings` exist.

## 5. Connect the app to Supabase

1. In the Supabase dashboard, go to **Project Settings** → **API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `js/config.js` in this project and paste them in:
   ```js
   window.APP_CONFIG = {
     SUPABASE_URL: "https://<PROJECT_REF>.supabase.co",
     SUPABASE_ANON_KEY: "<your-anon-public-key>"
   };
   ```
   The anon key is designed to be public in browser code — it is safe to ship, and Row Level Security protects your data.

## 6. Deploy (or run locally)

**Run locally for testing:**
```bash
cd pokemon-tcg-app
python3 -m http.server 8000
# then open http://localhost:8000
```
> Note: when testing locally, add your local URL to Supabase → **Authentication** → **URL Configuration** → **Redirect URLs** (e.g. `http://localhost:8000`), otherwise Google sign-in will refuse to redirect back.

**Deploy for real:**
- **Netlify:** drag the `pokemon-tcg-app` folder onto [Netlify Drop](https://app.netlify.com/drop) — done, you get a live URL in seconds.
- **Vercel:** `vercel` from inside the folder, or import the folder as a project — no build settings needed (it's a static site).

After deploying, add your production site URL (e.g. `https://your-site.netlify.app`) to Supabase → **Authentication** → **URL Configuration** → **Redirect URLs** so Google sign-in works there too.

---

**Optional:** grab a free Pokémon TCG API key at [pokemontcg.io](https://pokemontcg.io) and paste it into the app's **Settings** (gear icon). Without a key you get ~1,000 API requests/day; a key raises it to 20,000/day.
