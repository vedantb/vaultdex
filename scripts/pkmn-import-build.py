#!/usr/bin/env python3
"""Build VaultDex collection rows from a pkmn.gg export.

Reads the pkmn.gg export JSON (EN + JP only, never Pocket), maps each
card to VaultDex's local TCGdex catalog (exact set, number, variant label),
and writes import-ready rows. Prices are left null so VaultDex's own
price refresh populates them; pkmn_id is left null for the lazy backfill.

Usage: python3 scripts/pkmn-import-build.py <export.json> <out.json>
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

APP = "/home/hatch/workspace/pokemon-tcg-app"
NOW = datetime.now(timezone.utc).isoformat()


def norm_number(n):
    return re.sub(r"^0+(?=\d)", "", str(n or "").strip().lower())


def load_sets(path):
    d = json.load(open(path))
    lst = d if isinstance(d, list) else d.get("sets", [])
    return {s["id"]: s for s in lst}


EN_SETS = load_sets(f"{APP}/data/tcgdex/sets.json")
JA_SETS = load_sets(f"{APP}/data/tcgdex/sets-ja.json")
EN_LOWER = {k.lower(): k for k in EN_SETS}
JA_LOWER = {k.lower(): k for k in JA_SETS}

# pkmn.gg set ids with no VaultDex catalog equivalent at all.
# Values are (set_id, set_name) to store; card data falls back to pkmn.gg's.
FALLBACK_SETS = {
    ("en", "sm3"): ("sm3", "Burning Shadows"),
    ("ja", "swshp_jp"): ("ja-swshp", "SWSH Promos (JP)"),
}


def map_en_set(pid):
    if pid == "pgo":
        return "swsh10.5"
    if pid == "sve23":
        return "sve"
    cands = [pid]
    m = re.fullmatch(r"([a-z]+)(\d+)pt5", pid)
    if m:
        cands.append(f"{m.group(1)}{int(m.group(2)):02d}.5")
    m = re.fullmatch(r"sv(\d+)", pid)
    if m:
        cands.append(f"sv{int(m.group(1)):02d}")
    for c in cands:
        if c.lower() in EN_LOWER:
            return EN_LOWER[c.lower()]
    return None


JA_OVERRIDES = {
    "swsh12a_jp": "S12a",   # VSTAR Universe
    "swsh10a_jp": "S10a",   # Dark Phantasma
    "swsh9a_jp": "S9a",     # Battle Region
    "swsh8b_jp": "S8b",     # VMAX Climax
    "svp_jp": "SV-P",       # Scarlet & Violet Promos
}


def map_ja_set(pid):
    if pid in JA_OVERRIDES:
        return JA_OVERRIDES[pid]
    base = pid[:-3] if pid.endswith("_jp") else pid
    return JA_LOWER.get(base.lower())


def print_label(vd_entry):
    """Replicate the app's printVariants label logic."""
    t = str((vd_entry.get("type") or "")).lower()
    f = str((vd_entry.get("foil") or "")).lower()
    if t == "reverse" and f:
        if f == "pokeball":
            return "Poké Ball"
        return f[:1].upper() + f[1:]
    if t == "reverse":
        return "Reverse Holo"
    if t == "holo":
        return "Holo"
    return "Normal"


def variant_label(pkmn_variant, card):
    if pkmn_variant == "normal":
        return "Normal"
    if pkmn_variant == "holofoil":
        return "Holo"
    if pkmn_variant == "reverseHolofoil":
        return "Reverse Holo"
    if pkmn_variant == "pokeballPattern":
        return "Poké Ball"
    if pkmn_variant == "masterballPattern":
        return "Masterball"
    if pkmn_variant == "stamp":
        vd = card.get("variants_detailed") or []
        if vd:
            return print_label(vd[0])
        return "Holo"
    return None  # unknown -> flagged


PRICE_KEY = {"Normal": "normal", "Holo": "holofoil",
             "Reverse Holo": "reverse-holofoil", "Poké Ball": "reverse-holofoil",
             "Masterball": "reverse-holofoil"}


def typeof_price(p):
    return isinstance(p, (int, float)) and not isinstance(p, bool)


def baked_price(card, label, is_ja):
    """Legitimate price from the local catalog snapshot (never invented).
    EN: TCGdex market. JA: PkmnPrices price baked by ja-price-backfill."""
    tp = (card.get("pricing") or {}).get("tcgplayer") or {}
    key = PRICE_KEY.get(label)
    entry = tp.get(key) if key else None
    price = (entry or {}).get("marketPrice")
    if typeof_price(price):
        return price, ("pkmnprices" if is_ja else "tcgdex")
    return None, None


def main():
    src, out = sys.argv[1], sys.argv[2]
    data = json.load(open(src))

    report = {"unmapped_sets": {}, "unmatched_cards": [], "name_mismatches": [],
              "unknown_variants": [], "fallback_cards": [], "rows": []}
    set_cache = {}
    rows = []
    ja_suffix_pat = re.compile(r" - \d+/\d+( \([^)]*\))?$")

    for block in data:
        cat = block.get("category")
        if cat == "TCG-POCKET-EN":
            continue  # user said: never import Pocket cards
        is_ja = (cat == "JP")
        qty = {(q["cardId"], q["variant"]): q["quantity"]
               for q in block.get("quantities", [])}

        for it in block.get("items", []):
            card = it["card"]
            pid = card["setId"]
            key = ("ja" if is_ja else "en", pid)
            if key not in set_cache:
                if key in FALLBACK_SETS:
                    set_cache[key] = ("fallback",) + FALLBACK_SETS[key]
                else:
                    ours = map_ja_set(pid) if is_ja else map_en_set(pid)
                    if ours is None:
                        report["unmapped_sets"].setdefault(cat, []).append(pid)
                        set_cache[key] = None
                    else:
                        path = (f"{APP}/data/tcgdex/sets/ja/{ours}.json" if is_ja
                                else f"{APP}/data/tcgdex/sets/{ours}.json")
                        if not os.path.exists(path):
                            # Catalog set exists but the per-set file isn't
                            # snapshotted yet: fall back to pkmn.gg's card data.
                            meta = (JA_SETS if is_ja else EN_SETS)[ours]
                            set_cache[key] = ("fallback",
                                              f"ja-{ours}" if is_ja else ours,
                                              meta.get("name"))
                        else:
                            sf = json.load(open(path))
                            by_num = {}
                            for c in sf["cards"]:
                                by_num.setdefault(
                                    norm_number(c.get("localId")), []).append(c)
                            meta = (JA_SETS if is_ja else EN_SETS)[ours]
                            set_cache[key] = ("catalog", ours, by_num, meta)
            hit = set_cache[key]
            if hit is None:
                continue

            def fallback_row(set_id, set_name):
                num = card.get("number") or ""
                local = (num.zfill(3) if num.isdigit() else num)
                label = variant_label(it.get("variant"), {})
                if label is None:
                    report["unknown_variants"].append(
                        (cat, card["id"], it.get("variant")))
                    return
                # pkmn.gg's own market price for the exact variant.
                vm = (it.get("variantMap") or {}).get(it.get("variant")) or {}
                fprice = vm.get("price")
                price = fprice if typeof_price(fprice) else None
                report["fallback_cards"].append(
                    (cat, card["id"], card.get("name")))
                rows.append({
                    "card_id": f"{set_id}-{local}",
                    "card_name": card.get("name"),
                    "set_id": set_id,
                    "set_name": set_name,
                    "number": norm_number(num),
                    "image_small": card.get("thumbImageUrl"),
                    "image_large": card.get("largeImageUrl"),
                    "artist": card.get("artist"),
                    "rarity": card.get("rarity"),
                    "variant": label,
                    "quantity": qty.get((card["id"], it.get("variant")), 1),
                    "pkmn_id": None,
                    "market_price": price,
                    "price_source": "pkmn.gg" if price is not None else None,
                    "price_updated_at": NOW if price is not None else None,
                })

            if hit[0] == "fallback":
                _, set_id, set_name = hit
                fallback_row(set_id, set_name)
                continue
            _, ours, by_num, meta = hit
            cands = by_num.get(norm_number(card.get("number")), [])
            if not cands:
                # Card number missing from our local set file (e.g. Shiny
                # Treasure ex secrets): keep it via pkmn.gg's own data under
                # our set id so the row still lands in the right set.
                fallback_row(f"ja-{ours}" if is_ja else ours, meta.get("name"))
                continue
            ours_card = cands[0]
            if (card.get("name") or "").strip().lower() != \
               (ours_card.get("name") or "").strip().lower():
                report["name_mismatches"].append(
                    (cat, pid, card.get("number"), card.get("name"),
                     ours_card.get("name")))
            label = variant_label(it.get("variant"), ours_card)
            if label is None:
                report["unknown_variants"].append(
                    (cat, card["id"], it.get("variant")))
                continue
            q = qty.get((card["id"], it.get("variant")), 1)
            img = ours_card.get("image") or ""
            set_id = (f"ja-{ours}" if is_ja else ours)
            name = ours_card.get("name") or ""
            if is_ja:
                # Strip PkmnPrices enrichment suffixes like
                # " - 009/086 (Poke Ball Pattern)" for clean display.
                name = ja_suffix_pat.sub("", name)
            price, price_source = baked_price(ours_card, label, is_ja)
            rows.append({
                "card_id": ours_card.get("id"),
                "card_name": name,
                "set_id": set_id,
                "set_name": meta.get("name"),
                "number": norm_number(ours_card.get("localId")),
                "image_small": (ours_card.get("imageSmall")
                                or (img + "/low.png" if img else None)
                                or card.get("thumbImageUrl")),
                "image_large": (ours_card.get("imageLarge")
                                or (img + "/high.png" if img else None)
                                or card.get("largeImageUrl")),
                "artist": ours_card.get("illustrator"),
                "rarity": ours_card.get("rarity"),
                "variant": label,
                "quantity": q,
                "pkmn_id": None,
                "market_price": price,
                "price_source": price_source,
                "price_updated_at": NOW if price is not None else None,
            })

    report["rows"] = rows
    # Merge rows that landed on the same (card_id, variant) — e.g. pkmn.gg
    # lists both a "stamp" and a "holofoil" variant where our catalog has a
    # single Holo printing. Quantities sum; nothing is double-counted.
    merged = {}
    for r in rows:
        k = (r["card_id"], r["variant"])
        if k in merged:
            merged[k]["quantity"] += r["quantity"]
        else:
            merged[k] = dict(r)
    rows = list(merged.values())
    report["rows"] = rows
    json.dump(rows, open(out, "w"))
    # summary to stdout
    print(f"rows written: {len(rows)} -> {out}")
    print(f"unmapped sets: {report['unmapped_sets']}")
    print(f"unmatched cards: {len(report['unmatched_cards'])}")
    for u in report["unmatched_cards"][:20]:
        print("   ", u)
    print(f"name mismatches: {len(report['name_mismatches'])}")
    for m in report["name_mismatches"][:20]:
        print("   ", m)
    print(f"unknown variants: {len(report['unknown_variants'])}")
    print(f"fallback cards (pkmn.gg data, no local set file): "
          f"{len(report['fallback_cards'])}")
    for f in report["fallback_cards"][:20]:
        print("   ", f)
    tot_en = sum(r["quantity"] for r in rows if not r["set_id"].startswith("ja-"))
    tot_ja = sum(r["quantity"] for r in rows if r["set_id"].startswith("ja-"))
    print(f"total copies EN: {tot_en} (expect 3015), JA: {tot_ja} (expect 1759)")


if __name__ == "__main__":
    main()
