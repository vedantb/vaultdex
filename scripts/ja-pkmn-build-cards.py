#!/usr/bin/env python3
"""Build snapshot cards from cached PkmnPrices data for Japanese sets whose
TCGdex snapshot exists but contains zero cards (TCGdex's JA catalog has no
card data for these sets).

For each such set with a cached data/pkmn-cache/cards-<ppId>.json, this
creates minimal but app-compatible cards:

  id, localId, name (clean English), nameJa ("" — unknown from PkmnPrices),
  rarity, illustrator, hp, category/types (empty), variants_detailed ([]),
  pricing ({}), imageSmall/imageLarge (PkmnPrices image_url), ppId.

Costs zero credits (uses only the local cache). Safe to re-run:
already-populated snapshots are skipped.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETS_JA = os.path.join(ROOT, "data", "tcgdex", "sets-ja.json")
JA_DIR = os.path.join(ROOT, "data", "tcgdex", "sets", "ja")
CACHE = os.path.join(ROOT, "data", "pkmn-cache")


def norm_num(s):
    s = str(s or "").strip().split("/")[0]
    m = re.match(r"^0*(\d+)(.*)$", s)
    return (m.group(1) + m.group(2)) if m else s


def clean_name(name):
    s = str(name or "").strip()
    # number/set suffix: "Pikachu - 227/S-P" -> "Pikachu"; "Weedle - 092/083" -> "Weedle"
    s = re.sub(r"\s*-\s*\d+/\S+\s*$", "", s)
    # bare promo-set suffix, keeping any parenthetical:
    # "Latias - S-P (Oversize Card)" -> "Latias (Oversize Card)"; "Rare Candy - SM-P" -> "Rare Candy"
    s = re.sub(r"\s*-\s*[A-Z]+-P(\s+\(.*\))?\s*$",
               lambda m: m.group(1) or "", s)
    return s.strip()


def pad_local(num):
    n = norm_num(num)
    return n.zfill(3) if n.isdigit() else n


def main():
    man = json.load(open(os.path.join(CACHE, "manifest.json")))
    pp_of = {s["ourId"]: s["ppSetId"] for s in man["sets"] if "ppSetId" in s}

    built, skipped = 0, []
    for f in sorted(os.listdir(JA_DIR)):
        if not f.endswith(".json"):
            continue
        oid = f[:-5]
        p = os.path.join(JA_DIR, f)
        snap = json.load(open(p))
        if snap.get("cards"):
            continue
        ppid = pp_of.get(oid)
        cache_p = os.path.join(CACHE, "cards-%s.json" % ppid) if ppid else None
        if not cache_p or not os.path.isfile(cache_p):
            skipped.append(oid)
            continue
        cards = json.load(open(cache_p))["cards"]
        seen = {}
        for c in cards:
            k = norm_num(c.get("number"))
            if not k:
                continue  # e.g. unnumbered energy cards; can't build an id
            if k not in seen:
                seen[k] = c
        ordered = sorted(seen.values(),
                         key=lambda c: (0, int(norm_num(c.get("number"))))
                         if norm_num(c.get("number")).isdigit() else (1, 0))
        new_cards = []
        for c in ordered:
            lid = pad_local(c.get("number"))
            img = c.get("image_url")
            new_cards.append({
                "id": "%s-%s" % (oid, lid),
                "localId": lid,
                "name": clean_name(c.get("name")),
                "nameJa": "",
                "rarity": c.get("rarity") or "",
                "illustrator": c.get("artist") or "",
                "image": None,
                "category": "",
                "types": [],
                "hp": c.get("hp"),
                "variants_detailed": [],
                "pricing": {},
                "imageSmall": img,
                "imageLarge": img,
                "ppId": c.get("id"),
            })
        snap["cards"] = new_cards
        json.dump(snap, open(p, "w"), ensure_ascii=False, indent=1)
        built += 1
        print("[%s] built %d cards from PkmnPrices set %s" %
              (oid, len(new_cards), ppid))

    print("\nBuilt %d sets; %d still need PkmnPrices fetch: %s" %
          (built, len(skipped), ", ".join(skipped) if skipped else "none"))


if __name__ == "__main__":
    main()
