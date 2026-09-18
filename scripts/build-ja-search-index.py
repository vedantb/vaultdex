#!/usr/bin/env python3
"""Build data/tcgdex/index-ja.json — slim search index over the Japanese
snapshot catalog so the browse search bar can find Japanese cards by
English name, Japanese name, or illustrator (e.g. "yu nagaba").

Entry: {id, localId, name, nameJa, illustrator, rarity, set}
Run after any JA snapshot/enrichment change (weekly refresh included).
"""
import json, glob, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JA_DIR = os.path.join(ROOT, "data", "tcgdex", "sets", "ja")
OUT = os.path.join(ROOT, "data", "tcgdex", "index-ja.json")

def main():
    entries = []
    files = sorted(glob.glob(os.path.join(JA_DIR, "*.json")))
    for f in files:
        set_id = os.path.splitext(os.path.basename(f))[0]
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception as e:
            print(f"skip {set_id}: {e}", file=sys.stderr)
            continue
        for c in d.get("cards", []):
            cid = c.get("id") or f"{set_id}-{c.get('localId')}"
            entries.append({
                "id": cid,
                "localId": c.get("localId"),
                "name": c.get("name"),
                "nameJa": c.get("nameJa"),
                "illustrator": c.get("illustrator"),
                "rarity": c.get("rarity"),
                "set": set_id,
            })
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(entries, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT)
    print(f"index-ja: {len(entries)} cards from {len(files)} sets -> {OUT}")

if __name__ == "__main__":
    main()
