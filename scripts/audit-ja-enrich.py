#!/usr/bin/env python3
"""Audit Japanese snapshots for enrichment completeness.

Checks every set in sets-ja.json:
  - snapshot file exists
  - every card has an English name (name differs from nameJa)
  - nameJa is preserved
  - imageSmall and imageLarge are present

Reports per-set gaps and a summary. Exits 0 if all complete, 1 otherwise.
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETS_JA = os.path.join(ROOT, "data", "tcgdex", "sets-ja.json")
JA_SET_DIR = os.path.join(ROOT, "data", "tcgdex", "sets", "ja")

def is_japanese(text):
    if not text:
        return False
    return any("\u3040" <= ch <= "\u30ff" or "\u4e00" <= ch <= "\u9fff"
               for ch in text)

def main():
    with open(SETS_JA, encoding="utf-8") as f:
        sets = json.load(f)
    total_cards = 0
    missing_snapshot = []
    incomplete = []
    for entry in sets:
        sid = entry["id"]
        p = os.path.join(JA_SET_DIR, sid + ".json")
        if not os.path.exists(p):
            missing_snapshot.append(sid)
            continue
        with open(p, encoding="utf-8") as f:
            snap = json.load(f)
        cards = snap.get("cards", [])
        total_cards += len(cards)
        no_en_name = [c.get("localId") for c in cards
                      if not c.get("name") or c.get("name") == c.get("nameJa")
                      or is_japanese(c.get("name", ""))]
        no_nameja = [c.get("localId") for c in cards if not c.get("nameJa")]
        no_img = [c.get("localId") for c in cards if not c.get("imageSmall")]
        no_img_large = [c.get("localId") for c in cards if not c.get("imageLarge")]
        if no_en_name or no_nameja or no_img or no_img_large:
            incomplete.append({
                "id": sid, "cards": len(cards),
                "no_en_name": no_en_name[:10],
                "no_nameja": len(no_nameja),
                "no_img_small": len(no_img),
                "no_img_large": len(no_img_large),
            })
    print(f"sets: {len(sets)}, snapshots: {len(sets) - len(missing_snapshot)}, "
          f"total cards: {total_cards}")
    if missing_snapshot:
        print(f"missing snapshots ({len(missing_snapshot)}): {missing_snapshot}")
    if incomplete:
        print(f"incomplete sets ({len(incomplete)}):")
        for inc in incomplete:
            print(f"  {inc['id']}: {inc['cards']} cards, "
                  f"no_en_name={len(inc['no_en_name'])}, "
                  f"no_nameja={inc['no_nameja']}, "
                  f"no_img_small={inc['no_img_small']}, "
                  f"no_img_large={inc['no_img_large']}")
            if inc["no_en_name"]:
                print(f"    e.g. {inc['no_en_name']}")
    else:
        print("all snapshots complete: English names, nameJa, and images present")
    sys.exit(1 if (missing_snapshot or incomplete) else 0)

if __name__ == "__main__":
    main()
