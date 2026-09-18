# RUNBOOK — Japanese promo sets S-P / SM-P / XY-P / BW-P (and 30th Celebration check)

Written 2026-09-16. Owner: Vedant. Assistant: Elmo 🔴.

## Goal

Add the four missing Japanese promo series to VaultDex's local catalog, with
cards, English names, PkmnPrices-hosted images, and baked Near Mint prices:

| App id | Display name            | Era            | PkmnPrices set id | Cards (PkmnPrices) |
|--------|-------------------------|----------------|-------------------|--------------------|
| `S-P`  | Sword & Shield Promos   | Sword & Shield | 891               | 344                |
| `SM-P` | Sun & Moon Promos       | Sun & Moon     | 1074              | 410                |
| `XY-P` | XY Promos               | XY             | 1073              | 300                |
| `BW-P` | Black & White Promos    | Black & White  | 783               | 236                |

Total: **1,290 card records** to enrich, then price.

**Why these exist as custom sets:** TCGdex's Japanese catalog does not carry
promo series. All prep work that needs zero API credits is DONE (see
"Prep work completed" below). Only the credit-spending steps remain, and they
**must not run before the PkmnPrices credit reset at 2026-09-17 00:00 UTC**
(ledger was at 19,240 / 20,000 on 2026-09-16).

## Prep work completed (2026-09-16, zero credits spent)

- `scripts/ja-set-names.json`: added the 4 community English names.
- `scripts/ja-custom-sets.json` (new): hand-maintained manifest — ids,
  Japanese names, series, eraRank/setRank, totals (PkmnPrices counts),
  release months. English names stay in `ja-set-names.json` (single source).
- `scripts/snapshot-tcgdex.py`: on every `--lang ja` run it now merges the
  custom sets into `data/tcgdex/sets-ja.json` (TCGdex entries win if TCGdex
  ever gains one), creates empty per-set shells under
  `data/tcgdex/sets/ja/<id>.json` when missing (never overwrites), and
  excludes custom ids from the TCGdex per-set fetch loop. **Survival
  verified**: a full `--sets --lang ja` regen kept all 188 sets, order
  identical, shells untouched — and even picked up 10 previously-missing
  set logos (SM2L, VS1, neo1, neo2, PMCG1–6).
- `data/tcgdex/sets-ja.json`: now 188 sets (was 184); shells created for all 4.
- `scripts/ja-pkmn-enrich.py`: `OVERRIDES` pinned
  (`S-P: 891, SM-P: 1074, XY-P: 1073, BW-P: 783`); **manifest merge fixed** —
  `--only` / `--limit` runs now merge into the existing
  `data/pkmn-cache/manifest.json` instead of wiping the other 182 sets'
  mappings (lossless merge verified byte-for-byte on all manifest sections);
  docstring updated to 188 sets.
- `scripts/ja-pkmn-build-cards.py`: tested with a simulated PkmnPrices
  payload — builds `S-P-001`-style ids, keeps first of duplicate numbers,
  skips unnumbered cards, embeds `ppId` (e.g. Pikachu 227/S-P → ppId 49627,
  the real card Vedant found). Test artifacts fully cleaned up.
- Logo/symbol fetches attempted over plain HTTPS for all 4 sets: none exist
  (Bulbapedia 404s, Limitless S3 403s) — same as the existing M-P / SV-P
  promos, which render fine with null art. Negative `.miss` markers cached so
  weekly runs don't retry.

## Post-reset commands (run after 2026-09-17 00:00 UTC, in order)

All from `~/workspace/pokemon-tcg-app`.

### 1. Enrich — fetch card lists from PkmnPrices (~1,290 credits)

```bash
python3 scripts/ja-pkmn-enrich.py --only S-P,SM-P,XY-P,BW-P
```

- Matches via the pinned OVERRIDES (verified: 4 matched, 0 unmatched, in a
  `--match-only` dry run).
- Downloads each set's Japanese card list into `data/pkmn-cache/cards-<ppSetId>.json`.
  Shells are empty, so nothing is merged into snapshots yet — that happens in step 2.
- Record the per-set card counts it prints; they should be ≈ 344 / 410 / 300 / 236.

### 2. Build — turn cached payloads into app cards (0 credits)

```bash
python3 scripts/ja-pkmn-build-cards.py
```

- Fills the 4 empty shells. Expect ~1,290 cards total (fewer if PkmnPrices
  lists unnumbered cards — those are skipped by design, no placeholders).
- BW-P: numbering runs 001–236 but Bulbapedia notes 7 numbers were never
  issued. Whatever PkmnPrices returns is built; missing numbers are left
  missing. Do NOT invent cards.

### 3. Pricing — bake Near Mint prices into the snapshots (~1,290 credits)

**Preferred:** finish steps 1–2 **before 2026-09-17 00:30 UTC**, so the
already-scheduled full Japanese price backfill picks up the new sets
automatically (it reads `sets-ja.json` fresh and prices via embedded `ppId`).

**Fallback** (if steps 1–2 land after 00:30 UTC):

```bash
python3 scripts/ja-price-backfill.py --only S-P,SM-P,XY-P,BW-P
```

- 1 credit per card, Near Mint, USD preferred / EUR fallback — same shape as
  all other JA snapshots, so tiles get price badges and modals get price
  tables with zero live calls at browse time.
- Do NOT touch the 00:30 / 2026-09-18 00:30 cron schedules themselves.

### 4. Deploy (parent agent runs this — subagent must not)

```bash
cd ~/workspace/pokemon-tcg-app && vercel --prod
```

Static site, no build step. Deploy only after steps 1–3 are confirmed.

## Credit estimate

| Step | Credits |
|------|--------:|
| Enrich 4 sets (344+410+300+236 card items) | ~1,290 |
| Build cards | 0 |
| Price backfill (1/card, only newly built) | ~1,290 |
| **Worst-case total** | **~2,580** |

Well under the 20,000/day Pro allowance and under each script's internal cap
(enricher 16,000 / backfill 17,000). The shared `data/pkmn-cache/credit-ledger.json`
is keyed by UTC date — after 00:00 UTC 2026-09-17 the day rolls over clean.

## Verification

1. `data/tcgdex/sets-ja.json` has 188 sets; each promo entry shows the right
   name, `nameJa`, series, and `total` (344/410/300/236).
2. Shells are filled: `data/tcgdex/sets/ja/S-P.json` etc. each hold ~their
   PkmnPrices count of cards.
3. `data/pkmn-cache/manifest.json` contains entries for all 4 ids with
   `ppSetId` 891/1074/1073/783.
4. **Pikachu check:** `S-P.json` contains card id `S-P-227` with `ppId`
   `49627`, English name, and a PkmnPrices image URL. (Its catalog price row
   will now come from PkmnPrices Near Mint instead of the old pkmn.gg $2,999
   fallback. The collection DB row is separate — do not touch it here.)
5. Browse page: the 4 sets appear under Sword & Shield / Sun & Moon / XY /
   Black & White era sections, newest-first ordering intact.
6. Set pages: tiles show English names + images; variant checkboxes render
   (single "Standard" placeholder per card until TCGdex-style variant data
   exists — same as the 63 existing PkmnPrices-built sets, no crash).
7. **Weekly-refresh survival re-check** (safe, zero credits):
   `python3 scripts/snapshot-tcgdex.py --sets --lang ja` →
   `sets-ja.json` must still list 188 sets with the 4 promos, and per-set
   card files must be untouched.
8. Supabase: untouched (read-only for this task). Collection DB: untouched.

## Troubleshooting

- **Count drift warnings** (ours vs PkmnPrices `card_count`): expected to be
  zero here since manifest totals came from PkmnPrices. If a warning appears,
  trust the fetched payload, update `ja-custom-sets.json`, note it.
- **Duplicate card numbers** (promo reprints sharing a number): builder keeps
  the first PkmnPrices entry. After reset, eyeball one set's payload for
  same-number variants that deserve separate cards rather than being dropped.
- **429 / budget gate**: the enricher stops cleanly and records deferred
  sets; re-run the same `--only` command the next day (cached sets cost
  nothing on re-run).
- **Repo is not git-tracked**: changes are live in the working tree. If you
  need a rollback point, copy `data/tcgdex/sets-ja.json`,
  `data/tcgdex/sets/ja/{S-P,SM-P,XY-P,BW-P}.json`, and
  `data/pkmn-cache/manifest.json` to `~/workspace/` before running.

## Files changed (2026-09-16)

- `scripts/ja-set-names.json` — 4 names added (now 188 entries).
- `scripts/ja-custom-sets.json` — NEW: custom promo-set manifest.
- `scripts/snapshot-tcgdex.py` — custom-set merge (`merge_custom_ja_sets`,
  `ensure_custom_shell`, `CUSTOM_JA_IDS`), hooked into `snapshot_sets()`.
- `data/tcgdex/sets-ja.json` — 184 → 188 sets.
- `data/tcgdex/sets/ja/{S-P,SM-P,XY-P,BW-P}.json` — NEW empty shells.
- `scripts/ja-pkmn-enrich.py` — 4 OVERRIDES, lossless manifest merge on
  scoped runs, 184 → 188 in docstring.

---

# 30th Celebration set — post-reset check (new 2026-09-16 release)

**Status as of 2026-09-16:** the Pokémon TCG "30th Celebration" set released
today — simultaneous global English + Japanese release, ~199 cards + 33
secret rares. TCGdex does **not** have it yet (verified against the live API
today; only the 25th-anniversary Celebrations exists there). PkmnPrices has
no public catalog pages indexed yet, but their API usually picks up new
releases fast.

**Do NOT query the PkmnPrices API for this before the 2026-09-17 00:00 UTC
credit reset.**

## Step 1 — check TCGdex (free, zero credits, anytime)

```bash
curl -s https://api.tcgdex.net/v2/en/sets | python3 -c "
import json,sys
sets=json.load(sys.stdin)
hits=[(s['id'],s.get('name')) for s in sets if '30' in str(s.get('name',''))]
print(hits if hits else 'not in TCGdex yet')"
```

Also check the JA endpoint (`/v2/ja/sets`) — a simultaneous release may
land in both.

## Step 2 — check PkmnPrices set lists (after credit reset only)

```bash
python3 ~/workspace/skills/pkmnprices/bin/pkmnprices.py sets --language English > /tmp/pp-sets-en.json
python3 ~/workspace/skills/pkmnprices/bin/pkmnprices.py sets --language Japanese > /tmp/pp-sets-ja.json
grep -io '"name"[^,]*30[^,]*' /tmp/pp-sets-en.json /tmp/pp-sets-ja.json | head
```

Cost: ~1 credit per set listed (a few hundred per language). Search for
"30th" / "Celebration" in both. Note whether EN and JA appear as one set or
two, and record both PkmnPrices set ids.

## Step 3 — check for a 30th-anniversary promo set (after credit reset only)

Grep the same two set lists for promo keywords. Known box-promo products to
look for coverage of:

- Nidorina ETB promo
- Kanto birds poster collection
- Alolan Exeggutor / Lucario tech sticker promos
- Sylveon ex / Greninja ex box promos
- Eevee knock-out collection promo
- Japanese "Futuristic Box" Pikachu ex promos

If PkmnPrices lists a 30th-anniversary promo set, record its set id(s) and
card count(s) — it becomes a candidate for the same custom-set pipeline
below. If the promos are folded into the main 30th Celebration set id,
note that instead.

## Step 4 — build through the pipeline (decision tree)

- **TCGdex has the EN set:** `python3 scripts/snapshot-tcgdex.py --set <tcgdex-id> --lang en`
  (TCGdex ids differ from PkmnPrices ids — record the mapping; EN pricing
  stays live via the existing proxy, nothing to bake).
- **PkmnPrices has the JA set:** add it to `scripts/ja-custom-sets.json`
  (new entry: id, `nameJa`, series "30th Celebration", eraRank 0, next
  setRank), add the community English name to `scripts/ja-set-names.json`,
  pin the PkmnPrices id in `ja-pkmn-enrich.py` OVERRIDES, then run the same
  flow: `ja-pkmn-enrich.py --only <id>` → `ja-pkmn-build-cards.py` →
  `ja-price-backfill.py --only <id>`.
- **PkmnPrices has the EN set but TCGdex doesn't:** the card builder
  (`ja-pkmn-build-cards.py`) is JA-only today — it hardcodes the JA
  snapshot dir and manifest. Generalizing it to English (parameterize the
  set dir, manifest path, and card-id language handling) is a small,
  well-defined follow-up; do NOT hand-build EN cards outside the pipeline.
- **Neither has it:** wait and re-check in a few days. Do not fabricate
  cards, ids, or prices.

Record whatever you find (set ids per language, card counts, promo-set
presence) in this runbook or `ja-promo-set-audit.md` before building.

---

## Post-reset results (2026-09-17 ~00:20 UTC, job ja-promo-sets-build)

### Promo sets — DONE
- Enrichment: the enricher's urllib fetch hit consistent `IncompleteRead`
  truncation on all 4 sets (retried twice, same). Fetched the 1,290 card
  items via curl through the production proxy instead
  (`hidden_files/ja-promo-sets-build-2026-09-17/fetch-promo-via-curl.py` in
  the vaultdex-weekly-catalog-refresh goal workspace), wrote the enricher's
  exact cache format, then re-ran the enricher from cache (0 extra credits).
  Ledger manually credited +1,290 for 2026-09-17 to keep shared accounting
  honest.
- Built: S-P 334 / SM-P 409 / XY-P 298 / BW-P 236 cards (from 344/410/300/236
  fetched). Skips are by design — duplicate numbers (promo reprints sharing
  one number, first kept; S-P's 6 oversize cards all numbered just "S-P",
  XY-P's Dedenne 078 reprint) and unnumbered cards (4 S-P, 1 SM-P, 1 XY-P,
  e.g. energy) which can't get stable ids. No genuine cards lost.
- Pikachu check: `S-P-227` present with ppId 49627, clean English name,
  PkmnPrices image URL.
- Name cleaning fix: PkmnPrices promo names carry " - 227/S-P"-style
  suffixes that `clean_name` didn't strip (only handled `\d+/\d+`). Extended
  the regex in both `scripts/ja-pkmn-build-cards.py` and
  `scripts/ja-pkmn-enrich.py` to strip ` - <num>/<set>` and bare
  ` - <SET>-P` suffixes (keeping parentheticals like "(Oversize Card)");
  rebuilt all 4 sets from cache. Existing M-P/SV-P names already clean.
- Verified: sets-ja.json 188 sets with correct promo entries; manifest has
  ppSetId 891/1074/1073/783; survival re-check (`--sets --lang ja`) kept all
  188 sets and left the 4 per-set card files byte-identical.
- Credits: 1,290 enrich + 0 build = 1,290 / 20,000 for 2026-09-17.
  Landed before 00:30 UTC, so the scheduled full JA price backfill prices
  the new sets automatically (ppId embedded). Backfill NOT run manually.

### 30th Celebration check — results
- TCGdex EN now carries it: `30th` "30th Celebration" (158 cards, series
  Mega Evolution, released 2026-09-16) and `30th-c` "30th Classic Collection"
  (30 cards). Built both via `snapshot-tcgdex.py --set <id> --lang en` and
  inserted both into `data/tcgdex/sets.json` (now 205 EN sets; eraRank 0,
  setRank 0/1, existing ranks shifted). EN pricing stays live via the proxy —
  nothing baked, per policy.
- TCGdex JA: no 30th set yet.
- PkmnPrices EN: `1086 | ME: 30th Celebration | cards: 71` exists (partial
  vs TCGdex's 158 — TCGdex is the fuller source). PkmnPrices JA: no 30th
  set. No 30th-anniversary promo set in either language.
- Decision: no JA custom-set build (nothing to build from), no EN hand-build
  (TCGdex covered it). Re-check JA coverage in a few days.
