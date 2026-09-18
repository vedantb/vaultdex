# Japanese Promo-Set Catalog Audit (VaultDex)

**Date:** 2026-09-16
**Scope:** Read-only audit. Nothing in `data/tcgdex/`, `scripts/`, or app code was changed.
**Method:** Compared `data/tcgdex/sets-ja.json` (184 sets, exact id/name matches) against Bulbapedia's authoritative [List of Japanese Pokémon Trading Card Game expansions](https://bulbapedia.bulbagarden.net/wiki/List_of_Japanese_Pok%C3%A9mon_Trading_Card_Game_expansions), which carries a complete "Promotional sets" table with card counts and release periods. Individual Japanese promo pages were opened directly for S-P, SM-P, XY-P, and BW-P.

## Current promo-set coverage

Of the 184 Japanese sets in the snapshot, only **3 true promo sets** are present:

| Snapshot id | Name | Bulbapedia equivalent |
|---|---|---|
| `M-P` | Mega Promos | M-P Promotional cards |
| `SV-P` | Scarlet & Violet Promos | SV-P Promotional cards |
| `SMP2` | Movie Special Pack Great Detective Pikachu | Movie Special Pack Great Detective Pikachu |

Not substitutes (keep this straight):
- `SM0` "Pikachu and New Friends" is a 4-card main/special set — **not** the SM-P promo series.
- `S8a` "25th Anniversary Collection" is a main expansion — **not** the 25-card Promo Card Pack 25th Anniversary Edition.
- `web1` / `VS1` are unrelated specialty sets.

Why this matters: `Pikachu 227/S-P` fails catalog lookup not because PkmnPrices lacks it (PkmnPrices id **49627** exists) but because our catalog has no S-P set to map it into.

## Missing promo sets (all of them)

Counts are per Bulbapedia's promotional table, which distinguishes numbered cards from unnumbered variants with unique attributes. Era order below is newest first.

| # | Set | Era | Cards (numbered + unnumbered) | Release period |
|---|---|---|---|---|
| 1 | **S-P Promotional cards** | Sword & Shield | 350 + 24 = **374** | Nov 2019 – Dec 2022 |
| 2 | **SM-P Promotional cards** | Sun & Moon | 408 + 29 = **437** | Nov 2016 – Oct 2019 |
| 3 | **XY-P Promotional cards** | XY | 298 + 155 = **453** | Aug 2013 – Feb 2017 |
| 4 | **BW-P Promotional cards** | Black & White | **229** (numbers run through 236; 7 never issued) | Dec 2010 – Sep 2013 |
| 5 | **L-P Promotional cards** | HeartGold & SoulSilver | **79** | Sep 2009 – Aug 2010 |
| 6 | **DPt-P Promotional cards** | Platinum | **51** | Oct 2008 – Aug 2009 |
| 7 | **DP-P Promotional cards** | Diamond & Pearl | **127** | Dec 2006 – Jan 2009 |
| 8 | **PPP Promotional cards** | Diamond & Pearl | **7** | May 2007 |
| 9 | **PCG-P Promotional cards** | ADV/PCG | **154** | Feb 2004 – Jul 2006 |
| 10 | **PLAY Promotional cards** | ADV | **32** | Jan 2003 – Jan 2006 |
| 11 | **ADV-P Promotional cards** | ADV | **63** | Jan 2003 – Feb 2004 |
| 12 | **T Promotional cards** | e-Card | **24** | Jan 2002 – Mar 2003 |
| 13 | **J Promotional cards** | e-Card | **2** | Aug 2001 – Jul 2002 |
| 14 | **P Promotional cards** | e-Card | **47** | Jul 2001 – Jul 2002 |
| 15 | **McDonald's Original Minimum★Pack** | e-Card | **30** | Jan – Feb 2002 |
| 16 | **Southern Islands** | Neo | **18** | Jul 1999 |
| 17 | **Vending Series 1 (Blue)** | Original | **36** | Mar 1998 |
| 18 | **Vending Series 2 (Red)** | Original | **36** | Jun 1998 |
| 19 | **Vending Series 3 (Green)** | Original | 36 + 17 non-standard = **53** | Nov 1998 |
| 20 | **Promo Card Pack 25th Anniversary Edition** | Sword & Shield | **25** | Oct 2021 |
| 21 | **Movie 10: 10th Anniversary Premium Sheet** | Diamond & Pearl | **11** | Jul 2007 |
| 22 | **Movie Commemoration Premium Sheet** | Diamond & Pearl | **9** | Jul 2008 |
| 23 | **World Collection** (Pikachu World Collection 2010) | Black & White | **10** | Jul 2010 |
| 24 | **Collection Sheet Journey Partners** | Black & White | **9** | Sep 2010 |
| 25 | **Unnumbered Promotional cards** (Original Era catch-all) | Original | Unbounded — ongoing collection, no fixed count | Oct 1996 – present |

Estimated total missing: **~3,190 cards** (not counting the unbounded original-era unnumbered collection).

## Bulbapedia references

- Master table (authoritative source for every count above): https://bulbapedia.bulbagarden.net/wiki/List_of_Japanese_Pok%C3%A9mon_Trading_Card_Game_expansions
- S-P Promotional cards (verified by opening): https://bulbapedia.bulbagarden.net/wiki/S-P_Promotional_cards_(TCG)
- SM-P Promotional cards (verified by opening): https://bulbapedia.bulbagarden.net/wiki/SM-P_Promotional_cards_(TCG)
- XY-P Promotional cards (verified by opening): https://bulbapedia.bulbagarden.net/wiki/XY-P_Promotional_cards_(TCG)
- BW-P Promotional cards (verified by opening): https://bulbapedia.bulbagarden.net/wiki/BW-P_Promotional_cards_(TCG)
- Unnumbered Promotional cards: http://bulbapedia.bulbagarden.net/wiki/Unnumbered_Promotional_cards_(TCG) (found via search, not opened)
- Card-level proof that S-P numbering is real and cards circulate: https://bulbapedia.Bulbagarden.net/wiki/Pikachu_(S-P_Promo_227) (Pikachu 227/S-P, Japan Post Pokémon Stamp Box, Aug 2021)

Note: several same-named promo pages exist for other languages (KTCG, SCTCG, TCTCG, TTCG, ITCG). The plain `(TCG)` pages are the Japanese ones. Search queries for the Japanese numbered-promo pages are heavily polluted by Chinese/Korean/Thai variants — always land on the `(TCG)` page, never the language-suffixed ones.

## Prioritized additions (recent first)

| Priority | Set | Why |
|---|---|---|
| 1 | **S-P** | Sword & Shield era; user has a real collection card here today (Pikachu 227/S-P); 374 cards |
| 2 | **SM-P** | Sun & Moon era; largest numbered run after XY-P; 437 cards |
| 3 | **XY-P** | XY era; biggest of the missing series (453 incl. unnumbered) |
| 4 | **BW-P** | Black & White era; 229 cards, many collector-relevant (Unissued worlds promos, Pokémon + Nobunaga tie-ins) |
| 5 | **Promo Card Pack 25th Anniversary Edition** | 25 cards, pairs with the S8a main set we already carry |
| 6 | **L-P / DPt-P / DP-P** | HGSS→DP era chain; 79 / 51 / 127 cards |
| 7 | Remaining vintage & special promos | PPP, PCG-P, PLAY, ADV-P, T, J, P, McDonald's pack, Southern Islands, Vending 1–3, movie sheets, World Collection, Journey Partners |
| 8 | Unnumbered Promotional cards | Catch-all with no bounded card list; useful only as a reference source, lowest add value |

## Suggested snapshot id convention (proposal, not implemented)

The existing covered promos use `m-p`, `sv-p`, `smp2`. Proposed ids for the missing sets, following that style: `s-p`, `sm-p`, `xy-p`, `bw-p`, `l-p`, `dpt-p`, `dp-p`, `ppp`, `pcg-p`, `play`, `adv-p`, `t-p`, `j-p`, `p-p`, `mcdonalds-pack`, `southern-islands`, `vending-s1`, `vending-s2`, `vending-s3`, `promo-pack-25th`, `movie-10-sheet`, `movie-sheet`, `world-collection`, `journey-partners`. (Single letters avoided since bare `t`/`j`/`p` risk id collisions.)

## Caveats

- TCGdex's Japanese API has no cards for these promo sets at all (same as the other 63 card-less JA sets); catalog content would need to come from PkmnPrices (`language=Japanese`, matching set ids) or Bulbapedia lists, same as the current enrichment pipeline.
- S-P, SM-P, XY-P, BW-P counts above include unnumbered variants where Bulbapedia flags them — any added set should store the numbered run and note the unnumbered extras rather than pretending the set is one flat list.
- BW-P numbering runs to 236 but only 229 cards were actually released (7 unreleased: Emolga 025, Druddigon 026, Pokémon Catcher 027, and four Energy 028–031).
