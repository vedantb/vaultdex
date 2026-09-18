#!/usr/bin/env python3
"""One-off Japanese rarity correction (cache-only, zero API credits).

TCGdex's Japanese catalog bulk-mislabeled many cards as "Mega Hyper Rare"
(e.g. nearly every Art Rare / Special Art Rare / Super Rare in M6 "Storm
Emeralda"). This script corrects those labels using the cached PkmnPrices
rarities (data/pkmn-cache/cards-<ppSetId>.json), reusing the PP_RARITY_FIX
mapping from scripts/ja-pkmn-enrich.py.

Only cards currently labeled "Mega Hyper Rare" whose PkmnPrices rarity maps
to an unambiguous TCGdex-style label are touched. Everything else stays.

The weekly enrich (scripts/ja-pkmn-enrich.py) now applies the same
correction on every run, so this one-off is only needed to fix the current
snapshots without waiting for the next weekly cycle.

IMPORTANT: do not run this while scripts/ja-price-backfill.py is running --
both do read-modify-write on data/tcgdex/sets/ja/*.json and can clobber
each other's writes.

Usage:
  python3 scripts/ja-rarity-correct.py            # dry run, prints plan
  python3 scripts/ja-rarity-correct.py --apply   # writes the snapshots
  python3 scripts/ja-rarity-correct.py --apply --only M6
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# The enrich module file has a hyphen (ja-pkmn-enrich.py), so import by path.
import importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "pkmn-cache")
SNAP = os.path.join(ROOT, "data", "tcgdex", "sets", "ja")


def load_mapping():
    spec = importlib.util.spec_from_file_location(
        "ja_pkmn_enrich",
        os.path.join(ROOT, "scripts", "ja-pkmn-enrich.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.PP_RARITY_FIX


def norm_num(s):
    s = str(s or "")
    return s.lstrip("0") or "0"


def main():
    apply = "--apply" in sys.argv
    only = None
    for a in sys.argv[1:]:
        if a.startswith("--only="):
            only = a.split("=", 1)[1]
        elif a == "--only" and sys.argv.index(a) + 1 < len(sys.argv):
            only = sys.argv[sys.argv.index(a) + 1]
    if only:
        only = {x.strip() for x in only.split(",") if x.strip()}

    rmap = load_mapping()
    manifest = json.load(open(os.path.join(CACHE, "manifest.json")))
    pp_map = {s["ourId"]: s["ppSetId"] for s in manifest["sets"]
              if isinstance(s, dict)}

    total_fixed = 0
    total_mhr = 0
    for sid in sorted(pp_map):
        if only and sid not in only:
            continue
        snap_p = os.path.join(SNAP, sid + ".json")
        if not os.path.exists(snap_p):
            continue
        cache_p = os.path.join(CACHE, "cards-%d.json" % pp_map[sid])
        if not os.path.exists(cache_p):
            continue
        snap = json.load(open(snap_p))
        pcards = json.load(open(cache_p))
        items = pcards.get("cards", pcards) if isinstance(pcards, dict) else pcards
        pp_by_num = {}
        for c in items:
            if isinstance(c, dict):
                pp_by_num.setdefault(norm_num(c.get("number")), c)
        fixed = 0
        mhr = 0
        for sc in snap.get("cards", []):
            if sc.get("rarity") != "Mega Hyper Rare":
                continue
            mhr += 1
            pc = pp_by_num.get(norm_num(sc.get("localId")))
            if not pc:
                continue
            new = rmap.get(pc.get("rarity"))
            if new:
                fixed += 1
                if apply:
                    sc["rarity"] = new
        total_mhr += mhr
        total_fixed += fixed
        if mhr:
            print("[%s] %d Mega Hyper Rare cards, %d corrected%s" %
                  (sid, mhr, fixed, " (written)" if apply and fixed else ""))
        if apply and fixed:
            json.dump(snap, open(snap_p, "w"), ensure_ascii=False, indent=1)
    print("\n%s: %d Mega Hyper Rare cards found, %d corrected." %
          ("APPLIED" if apply else "DRY RUN", total_mhr, total_fixed))


if __name__ == "__main__":
    main()
