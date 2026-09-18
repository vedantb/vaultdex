#!/usr/bin/env python3
"""Backfill missing English card images from PkmnPrices.

TCGdex carries no scan for ~956 English cards (old promo sets, the e-card
era, trainer kits, McDonald's collections, and scattered promos such as
svp-085 "Pikachu with Grey Felt Hat"). PkmnPrices usually has them.

For each affected TCGdex set we map to a PkmnPrices English set (OVERRIDES),
page through that set's cards once (cached), then match imageless cards by
card number (leading zeros stripped) plus a name-compatibility guard.
Matches write imageSmall/imageLarge (PkmnPrices image_url, same as the
Japanese enrichment) into the local snapshots — normCard already prefers
those, so no app change is needed.

Credit rules (shared with the JA scripts): 1 credit per item returned,
hard daily cap 16000 in this script (Pro allows 20000/day; the cap leaves
headroom for price refreshes), ledger keyed by UTC date at
data/pkmn-cache/credit-ledger.json, clean stop on 429. Raw responses are
cached under data/pkmn-cache/en-img/ so re-runs are free.

Usage:
  python3 scripts/en-image-backfill.py            # dry run
  python3 scripts/en-image-backfill.py --apply    # write snapshots
  python3 scripts/en-image-backfill.py --apply --only svp
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "tcgdex")
CACHE = os.path.join(ROOT, "data", "pkmn-cache")
IMG_CACHE = os.path.join(CACHE, "en-img")
LEDGER = os.path.join(CACHE, "credit-ledger.json")
CLI = os.path.expanduser("~/workspace/skills/pkmnprices/bin/pkmnprices.py")
DAILY_CAP = 16000

# Our TCGdex set id -> PkmnPrices English set id. Built 2026-09-18 against
# the PkmnPrices set list; verify with --only if a set looks wrong.
# Sets with no PkmnPrices equivalent (mfb, ecard3/Skyridge, swsh12tg,
# swsh11tg, swsh9tg, 30th-c, tk-bw-e, tk-bw-z, 2012bw, 2014xy, 2015xy,
# tk-ex-m, xya, ex5.5) are absent and skipped.
OVERRIDES = {
    "swsh4.5sv": 468,   # Shining Fates: Shiny Vault
    "mep": 502,         # ME: Mega Evolution Promo
    "swsh12.5gg": 467,  # Galarian Gallery lives inside SWSH: Crown Zenith
    "svp": 505,         # SV: Scarlet & Violet Promo Cards
    "swsh10tg": 458,    # SWSH10: Astral Radiance Trainer Gallery
    "exu": 466,         # Unown Collection lives inside Unseen Forces
    "tk-xy-w": 431,     # XY Trainer Kit: Bisharp & Wigglytuff (Wigglytuff half)
    "tk-xy-b": 431,     # XY Trainer Kit: Bisharp & Wigglytuff (Bisharp half)
    "tk-xy-n": 465,     # XY Trainer Kit: Sylveon & Noivern (Noivern half)
    "tk-xy-sy": 465,    # XY Trainer Kit: Sylveon & Noivern (Sylveon half)
    "tk-xy-latia": 515, # XY Trainer Kit: Latias & Latios
    "cel25cc": 501,     # Celebrations: Classic Collection
    "tk-hs-r": 433,     # HGSS Trainer Kit: Gyarados & Raichu
    "sve": 473,         # SVE: Scarlet & Violet Energies
    "2016xy": 430,      # McDonald's Promos 2016
    "2011bw": 477,      # McDonald's Promos 2011
    "tk-ex-latia": 516, # EX Trainer Kit 1: Latias & Latios
    "tk-ex-latio": 516, # EX Trainer Kit 1: Latias & Latios
    "tk-dp-m": 506,     # DP Trainer Kit: Manaphy & Lucario
    "mee": 425,         # MEE: Mega Evolution Energies
    "hgssp": 472,       # HGSS Promos
    "ecard2": 491,      # Aquapolis
    "bwp": 514,         # Black and White Promos
    "cel25": 509,       # Celebrations
    "bog": 434,         # Best of Game promos live inside Nintendo Promos
}


def norm_num(s):
    s = str(s or "").strip().upper().lstrip("0")
    return s or "0"


def clean_name(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def today_key():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def ledger_get():
    try:
        with open(LEDGER) as f:
            return json.load(f)
    except Exception:
        return {}


def ledger_add(n):
    lg = ledger_get()
    k = today_key()
    lg[k] = lg.get(k, 0) + n
    os.makedirs(CACHE, exist_ok=True)
    tmp = LEDGER + ".tmp"
    with open(tmp, "w") as f:
        json.dump(lg, f)
    os.replace(tmp, LEDGER)
    return lg[k]


def ledger_today():
    return ledger_get().get(today_key(), 0)


def pkmn(args):
    """Run the PkmnPrices CLI; returns parsed JSON. Raises on 429."""
    p = subprocess.run([sys.executable, CLI] + args, capture_output=True, text=True, timeout=60)
    out = (p.stdout or "").strip()
    if "429" in out or "rate_limit" in out or "HTTP 429" in (p.stderr or ""):
        raise RuntimeError("429")
    try:
        return json.loads(out)
    except Exception:
        raise RuntimeError("bad response: " + out[:200])


def norm_name(s):
    return re.sub(r"[^a-z0-9]+", "", clean_name(s).lower())


def names_compatible(a, b):
    na, nb = norm_name(a), norm_name(b)
    return bool(na and nb) and (na in nb or nb in na)


def set_cache_path(pp_set_id, page):
    d = os.path.join(IMG_CACHE, "set-" + str(pp_set_id))
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "page-" + str(page) + ".json")


def fetch_set_cards(pp_set_id, delay):
    """Page through every card in a PkmnPrices set (cached; 1 credit/item)."""
    items = []
    page = 1
    while True:
        cp = set_cache_path(pp_set_id, page)
        if os.path.exists(cp):
            with open(cp) as f:
                data = json.load(f)
        else:
            time.sleep(delay)
            data = pkmn(["search", "--set-id", str(pp_set_id), "--language", "English",
                         "--per-page", "100", "--page", str(page)])
            got = data.get("data") or []
            ledger_add(len(got))
            with open(cp, "w") as f:
                json.dump(data, f)
        got = data.get("data") or []
        items.extend(got)
        pag = data.get("pagination") or {}
        total_pages = pag.get("total_pages") or 1
        if not got or page >= total_pages:
            break
        page += 1
    return items


def load_sets():
    with open(os.path.join(DATA, "sets.json")) as f:
        return {s["id"]: s for s in json.load(f)}


def imageless_cards(only=None):
    out = []
    tsets = load_sets()
    for fn in sorted(os.listdir(os.path.join(DATA, "sets"))):
        if not fn.endswith(".json"):
            continue
        sid = fn[:-5]
        if only and sid != only:
            continue
        with open(os.path.join(DATA, "sets", fn)) as f:
            d = json.load(f)
        for c in d.get("cards") or []:
            if not c.get("image") and not c.get("imageSmall"):
                out.append({
                    "set": sid,
                    "set_name": (tsets.get(sid) or {}).get("name", sid),
                    "id": c.get("id"),
                    "localId": c.get("localId"),
                    "name": c.get("name"),
                })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--only", default=None)
    ap.add_argument("--delay", type=float, default=6.0,
                    help="seconds between PkmnPrices requests (rate-limit pacing)")
    args = ap.parse_args()

    cards = imageless_cards(args.only)
    by_set = {}
    for c in cards:
        by_set.setdefault(c["set"], []).append(c)
    print(f"{len(cards)} imageless cards across {len(by_set)} sets "
          f"(ledger today: {ledger_today()})")

    # OVERRIDES carries the set mappings; the sets-list endpoint is only
    # informational and costs a rate-limited request, so it is skipped.

    resolved = dict(OVERRIDES)
    for sid in by_set:
        if sid in resolved:
            continue
        # naive fallback: none — require explicit mapping
        print(f"  no PkmnPrices mapping for {sid} ({by_set[sid][0]['set_name']}) — skipping")

    fixed = skipped = 0
    backoff = 0
    fixes = {}  # sid -> [(card_id, image_url)]
    stop = False
    for sid, clist in sorted(by_set.items()):
        if stop:
            break
        ppid = resolved.get(sid)
        if not ppid:
            skipped += len(clist)
            continue
        if ledger_today() >= DAILY_CAP:
            print("daily cap reached, stopping cleanly")
            break
        # One paged pull per set (cached), then match locally by number+name.
        pp_cards = None
        while backoff < 6:
            try:
                pp_cards = fetch_set_cards(ppid, args.delay)
                break
            except RuntimeError as e:
                if "429" not in str(e):
                    raise
                backoff += 1
                wait = 300
                print(f"429 ({backoff}/6) — sleeping {wait}s")
                time.sleep(wait)
        if pp_cards is None:
            print("rate limit would not clear, stopping cleanly")
            break
        # index by normalized number for exact matching
        by_num = {}
        for it in pp_cards:
            by_num.setdefault(norm_num(it.get("number")), []).append(it)
        for c in clist:
            want = norm_num(c["localId"])
            hit = None
            for it in by_num.get(want, []):
                if names_compatible(it.get("name"), c["name"]):
                    hit = it
                    break
            if not hit or not hit.get("image_url"):
                skipped += 1
                continue
            fixed += 1
            fixes.setdefault(sid, []).append((c["id"], hit["image_url"]))
    if args.apply:
        for sid, flist in fixes.items():
            fp = os.path.join(DATA, "sets", sid + ".json")
            with open(fp) as f:
                d = json.load(f)
            by_id = {sc.get("id"): sc for sc in d.get("cards") or []}
            for cid, url in flist:
                sc = by_id.get(cid)
                if sc is not None:
                    sc["imageSmall"] = url
                    sc["imageLarge"] = url
            tmp = fp + ".tmp"
            with open(tmp, "w") as f:
                json.dump(d, f)
            os.replace(tmp, fp)
            print(f"  wrote {len(flist)} images into {sid}.json")
    print(f"{'would fix' if not args.apply else 'fixed'}: {fixed}, skipped: {skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
