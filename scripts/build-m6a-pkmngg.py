#!/usr/bin/env python3
"""Build data/tcgdex/sets/ja/M6a.json from the cached pkmn.gg extraction.

Reads data/pkmn-gg-m6a.json + data/pkmn-gg-cache/m6a-<num>.json (written by
scripts/archive/pull-pkmngg-m6a.py - do NOT re-run that pull unprompted; it
hits a third-party fan site). Safe to re-run: rebuilds purely from local
cache.

TEMPORARY source until TCGdex / PkmnPrices carry M6a - then their data wins.
"""
import json, os, subprocess, sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_LIST = os.path.join(HERE, "data", "pkmn-gg-m6a.json")
CACHE_DIR = os.path.join(HERE, "data", "pkmn-gg-cache")
SET_PATH = os.path.join(HERE, "data", "tcgdex", "sets", "ja", "M6a.json")
SETS_JA = os.path.join(HERE, "data", "tcgdex", "sets-ja.json")
IMG_URL = "/data/tcgdex/card-images/ja/M6a/{num}.webp"

RARITY_MAP = {
    "None_JP": None,
    "Pikachu Rare_JP": "Pikachu Rare",
    "Art Rare_JP": "Illustration rare",
    "Double Rare_JP": "Double Rare",
    "Special Art Rare_JP": "Special illustration rare",
    "Futuristic Rare_JP": "Futuristic Rare",
}
CATEGORY_MAP = {"Pok\u00e9mon": "Pokemon", "Trainer": "Trainer", "Energy": "Energy"}


def atomic_write_json(path, obj, **kwargs):
    """Write JSON atomically (tmp file + os.replace) so a crash or OOM
    mid-write can never leave a truncated file in place."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, **kwargs)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def main():
    cards = json.load(open(RAW_LIST, encoding="utf-8"))
    print(f"loaded {len(cards)} cards from pkmn.gg extraction")

    # name cross-check vs previous Limitless build
    old = {}
    if os.path.exists(SET_PATH):
        old_d = json.load(open(SET_PATH, encoding="utf-8"))
        old = {c["localId"]: c["name"] for c in old_d["cards"]}
    mismatches = []

    out_cards = []
    missing_detail = []
    for c in cards:
        num = c["numberKey"]
        cache = os.path.join(CACHE_DIR, f"m6a-{num}.json")
        det = json.load(open(cache, encoding="utf-8")) if os.path.exists(cache) else None
        if not det:
            missing_detail.append(num)

        name = c.get("name")
        if num in old and old[num] != name:
            mismatches.append((num, old[num], name))

        raw_rar = c.get("rarity")
        rarity = RARITY_MAP.get(raw_rar, raw_rar)
        if raw_rar not in RARITY_MAP:
            print(f"  !! unmapped rarity {raw_rar} on {num}")

        sup = (det or {}).get("superType") or c.get("cardType")
        category = CATEGORY_MAP.get(sup or "", None)

        types = (det or {}).get("types") or []
        hp = (det or {}).get("hp")

        out_cards.append({
            "id": f"M6a-{num}",
            "localId": num,
            "name": name,
            "nameJa": (c.get("altName") or {}).get("JP"),
            "rarity": rarity,
            "illustrator": c.get("artist"),
            "image": None,
            "imageSmall": IMG_URL.format(num=num),
            "imageLarge": IMG_URL.format(num=num),
            "category": category,
            "types": types,
            "hp": hp,
            "variants_detailed": None,
            "pricing": None,
        })

    out_cards.sort(key=lambda x: x["localId"])

    old_set = {}
    if os.path.exists(SET_PATH):
        old_set = json.load(open(SET_PATH, encoding="utf-8")).get("set", {})
    set_block = {
        "id": "M6a",
        "name": old_set.get("name", "30th Celebration"),
        "nameJa": old_set.get("nameJa", "30th \u30bb\u30ec\u30d6\u30ec\u30fc\u30b7\u30e7\u30f3"),
        "series": old_set.get("series", "\u30dd\u30b1\u30e2\u30f3\u30ab\u30fc\u30c9\u30b2\u30fc\u30e0 MEGA"),
        "releaseDate": old_set.get("releaseDate", "2026-09-16"),
        "logo": "/data/tcgdex/set-logos/ja/M6a.png",
        "symbol": None,
        "printedTotal": 103,
        "total": len(out_cards),
        "lang": "ja",
    }
    atomic_write_json(
        SET_PATH,
        {"set": set_block, "cards": out_cards,
         "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
         "source": "pkmn.gg",
         "source_url": "https://www.pkmn.gg/jp/series/mega-evolution/30th-celebration"})

    # sets-ja.json entry
    sets = json.load(open(SETS_JA, encoding="utf-8"))
    for s in sets:
        if s.get("id") == "M6a":
            s["total"] = len(out_cards)
            s["printedTotal"] = 103
            break
    else:
        # the JA snapshot rewrites sets-ja.json from TCGdex, which has no
        # M6a — re-add the entry or the set vanishes from browse
        sets.append({
            "id": "M6a",
            "name": "30th Celebration",
            "logo": "/data/tcgdex/set-logos/ja/M6a.png",
            "symbol": None,
            "printedTotal": 103,
            "total": len(out_cards),
            "series": "Mega Evolution",
            "eraRank": 0,
            "setRank": 0,
            "lang": "ja",
            "nameJa": "30th セレブレーション",
        })
    atomic_write_json(SETS_JA, sets)
    print(f"wrote {SET_PATH} ({len(out_cards)} cards); sets-ja.json updated")

    if mismatches:
        print(f"name mismatches vs previous build ({len(mismatches)}):")
        for num, o, n in mismatches[:20]:
            print(f"  {num}: was {o!r} -> now {n!r}")
    if missing_detail:
        print(f"cards missing detail JSON (no types/hp): {missing_detail}")

    # rebuild JA search index
    print("rebuilding JA search index...", flush=True)
    r = subprocess.run([sys.executable, os.path.join(HERE, "scripts", "build-ja-search-index.py")],
                       capture_output=True, text=True)
    print(r.stdout[-500:] if r.stdout else "")
    if r.returncode != 0:
        print("index rebuild FAILED:", r.stderr[-1000:])


if __name__ == "__main__":
    # Catalog writers must not run concurrently (read-modify-write
    # on the same set files). See scripts/pipeline_lock.py.
    from pipeline_lock import pipeline_lock
    with pipeline_lock("build-m6a-pkmngg"):
        main()
