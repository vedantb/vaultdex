# scripts/archive/ — superseded one-off scripts (kept, not deleted)

These scripts are NOT part of the weekly pipeline. Do not call them from
crons or automation.

- **pull-pkmngg-m6a.py** — one-time 2026-09-17 pull of pkmn.gg's Japanese
  30th Celebration (M6a) set: card list, per-card JSON, and vendored scans
  into `data/pkmn-gg-m6a.json`, `data/pkmn-gg-cache/`, and
  `data/tcgdex/card-images/ja/M6a/`. Hits a third-party fan site, so it must
  NOT be re-run unprompted; the `__main__` guard refuses to run without an
  explicit `--i-am-sure` flag. The weekly refresh rebuilds M6a from the local
  cache via `scripts/build-m6a-pkmngg.py` instead.
- **build-m6a-limitless.py** — earlier 111-card M6a build from Limitless TCG
  data; superseded 2026-09-17 by the pkmn.gg build (`data/limitless-m6a.json`
  is kept as fallback).
- **ja-card-enrich.py** — pre-2026-09-16 Bulbapedia name/image backfill for
  Japanese cards; superseded by the PkmnPrices pipeline
  (`scripts/ja-pkmn-enrich.py`). Targets the obsolete `data/tcgdex/ja-cards/`
  dir; its images carry the "English-print, not JP scan" caveat.
- **pkmn-import-build.py** — one-off 2026-09-16 converter for the pkmn.gg
  collection export; the import is complete.
