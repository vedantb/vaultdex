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
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "tcgdex")
CACHE = os.path.join(ROOT, "data", "pkmn-cache")
IMG_CACHE = os.path.join(CACHE, "en-img")
LEDGER = os.path.join(CACHE, "credit-ledger.json")
CLI = os.path.expanduser("~/workspace/skills/pkmnprices/bin/pkmnprices.py")
DAILY_CAP = 16000

# Sets whose card numbers don't align with PkmnPrices numbering — match on
# exact normalized name instead of number (e.g. Celebrations Classic
# Collection: ours "CC001", theirs original print numbers; My First
# Battle: PkmnPrices carries no numbers at all; ecard2: 38 index-only
# holo (H01-H32) and a/b variant cards have no PkmnPrices number).
NAME_MATCH = {"cel25cc", "mfb", "ecard2"}

# Per-card overrides for one-offs: our card id -> (PkmnPrices set id,
# PkmnPrices exact card name). Used when the card lives in a different
# PkmnPrices set than its siblings.
CARD_OVERRIDES = {
    "mep-Museum": (550, "Pikachu at the Museum"),  # Jumbo Cards, not ME promos
    # SM Trainer Kit: both half-decks share numbers; PP disambiguates in the name
    "tk-sm-l-19": (520, "Hau (#19) (Lycanroc Half-Deck)"),
    "tk-sm-l-23": (520, "Hau (#23) (Lycanroc Half-Deck)"),
    "tk-sm-r-19": (520, "Hau (#19) (Alolan Raichu Half-Deck)"),
    "tk-sm-r-23": (520, "Hau (#23) (Alolan Raichu Half-Deck)"),
}

# Per-set manual name aliases (normalized form): ours -> theirs.
NAME_ALIASES = {
    "cel25cc": {
        "gardevoirex": "gardevoirexdeltaspecies",
        "umbreon": "umbreonstar",  # ours "Umbreon ☆"
        "donphan": "donphanprime",
    },
    "ecard2": {
        # PkmnPrices names 5 Aquapolis holos "Name (H##)"
        "exeggutor": "exeggutorh10",
        "houndoom": "houndoomh11",
        "kingdra": "kingdrah14",
        "lanturn": "lanturnh15",
        "nidoking": "nidokingh18",
    },
}

# Our TCGdex set id -> PkmnPrices English set id. Built 2026-09-18 against
# the full PkmnPrices set list (214 sets); the number+name guard validates
# every match, so a wrong mapping just yields zero fixes.
# Still no PkmnPrices equivalent (skipped): ex5.5 (Poké Card Creator Pack).
OVERRIDES = {
    "swsh4.5sv": 468,   # Shining Fates: Shiny Vault
    "mep": 502,         # ME: Mega Evolution Promo
    "swsh12.5gg": 566,  # SWSH: Crown Zenith: Galarian Gallery (NOT 467)
    "svp": 505,         # SV: Scarlet & Violet Promo Cards
    "swsh10tg": 458,    # SWSH10: Astral Radiance Trainer Gallery
    "swsh9tg": 526,     # SWSH09: Brilliant Stars Trainer Gallery
    "swsh11tg": 544,    # SWSH11: Lost Origin Trainer Gallery
    "swsh12tg": 585,    # SWSH12: Silver Tempest Trainer Gallery
    "exu": 466,         # Unown Collection lives inside Unseen Forces
    "tk-xy-w": 431,     # XY Trainer Kit: Bisharp & Wigglytuff (Wigglytuff half)
    "tk-xy-b": 431,     # XY Trainer Kit: Bisharp & Wigglytuff (Bisharp half)
    "tk-xy-n": 465,     # XY Trainer Kit: Sylveon & Noivern (Noivern half)
    "tk-xy-sy": 465,    # XY Trainer Kit: Sylveon & Noivern (Sylveon half)
    "tk-xy-latia": 515, # XY Trainer Kit: Latias & Latios
    "cel25cc": 501,     # Celebrations: Classic Collection (name-matched)
    "tk-hs-r": 433,     # HGSS Trainer Kit: Gyarados & Raichu
    "sve": 473,         # SVE: Scarlet & Violet Energies
    "2016xy": 430,      # McDonald's Promos 2016
    "2011bw": 477,      # McDonald's Promos 2011
    "2012bw": 545,      # McDonald's Promos 2012
    "2014xy": 583,      # McDonald's Promos 2014
    "2015xy": 556,      # McDonald's Promos 2015
    "tk-ex-latia": 516, # EX Trainer Kit 1: Latias & Latios
    "tk-ex-latio": 516, # EX Trainer Kit 1: Latias & Latios
    "tk-ex-m": 553,     # EX Trainer Kit 2: Plusle & Minun
    "tk-bw-e": 557,     # BW Trainer Kit: Excadrill & Zoroark (Excadrill half)
    "tk-bw-z": 557,     # BW Trainer Kit: Excadrill & Zoroark (Zoroark half)
    "tk-dp-m": 506,     # DP Trainer Kit: Manaphy & Lucario
    "tk-dp-l": 506,     # DP Trainer Kit: Manaphy & Lucario (Lucario half)
    "tk-xy-latio": 515, # XY Trainer Kit: Latias & Latios (Latios half)
    "tk-hs-g": 433,     # HGSS Trainer Kit: Gyarados & Raichu (Gyarados half)
    "tk-ex-p": 553,     # EX Trainer Kit 2: Plusle & Minun (Plusle half)
    "mee": 425,         # MEE: Mega Evolution Energies
    "hgssp": 472,       # HGSS Promos
    "ecard2": 491,      # Aquapolis
    "ecard3": 600,      # Skyridge
    "bwp": 514,         # Black and White Promos
    "swshp": 599,       # SWSH: Sword & Shield Promo Cards
    "cel25": 509,       # Celebrations
    "bog": 576,         # Best of Promos (NOT 434 Nintendo Promos)
    "mfb": 554,         # My First Battle
    "xya": 462,         # Alternate Art Promos (candidate — guard validates)
    "tk-xy-p": 560,     # XY Trainer Kit: Pikachu Libre & Suicune (Pikachu Libre half)
    "tk-xy-su": 560,    # XY Trainer Kit: Pikachu Libre & Suicune (Suicune half)
    "tk-sm-l": 520,     # SM Trainer Kit: Lycanroc & Alolan Raichu (Lycanroc half)
    "tk-sm-r": 520,     # SM Trainer Kit: Lycanroc & Alolan Raichu (Alolan Raichu half)
    "sm7.5": 436,       # Dragon Majesty
    "sm3.5": 529,       # Shining Legends
    "smp": 539,         # SM Black Star Promos (PkmnPrices "SM Promos")
    "2017sm": 517,      # McDonald's Promos 2017
    "2018sm": 579,      # McDonald's Promos 2018
    "2019sm": 590,      # McDonald's Promos 2019
    "2021swsh": 486,    # McDonald's 25th Anniversary Promos (McDonald's Collection 2021)
    "2022swsh": 589,    # McDonald's Promos 2022
    "2023sv": 426,      # McDonald's Promos 2023
    "2024sv": 513,      # McDonald's Promos 2024
    "sm6": 617,         # SM - Forbidden Light
    "xyp": 621,         # XY Black Star Promos (PkmnPrices "XY Promos")
    # 30th-c (local-only 30th Classic Collection) has no PkmnPrices
    # equivalent yet — 1086 "ME: 30th Celebration" is the ME-era set.
}


def norm_num(s):
    s = re.sub(r"[^A-Z0-9]", "", str(s or "").strip().upper())
    # strip leading zeros inside every digit run: "BW005"->"BW5", "085"->"85"
    return re.sub(r"(?<!\d)0+(?=\d)", "", s) or "0"


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
    """Run the PkmnPrices CLI; returns parsed JSON. Raises on 429.

    NOTE: never substring-match "429" in stdout — valid card payloads
    contain tcg_player_ids like 242915. A real 429 is the CLI exiting
    nonzero with "HTTP 429" on stderr.
    """
    p = subprocess.run([sys.executable, CLI] + args, capture_output=True, text=True, timeout=120)
    out = (p.stdout or "").strip()
    err = (p.stderr or "").strip()
    if p.returncode != 0 and ("HTTP 429" in err or "rate_limit" in err or "rate_limit" in out):
        raise RuntimeError("429")
    try:
        return json.loads(out)
    except Exception:
        raise RuntimeError("bad response: " + (err or out)[:200])


def norm_name(s):
    # NFKD folds accents (café->cafe, pokémon->pokemon) so names match
    # across sources regardless of diacritics
    s = unicodedata.normalize("NFKD", clean_name(s).lower())
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", "", s)


def names_compatible(a, b):
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return False
    # containment is too weak for very short names ("N" is inside
    # "greninjaex") — require equality there
    if min(len(na), len(nb)) < 4:
        return na == nb
    return na in nb or nb in na


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
    fixes = {}  # sid -> [(card_id, image_url)]
    stop = False
    def fetch_with_backoff(ppid, delay):
        """Fetch a PkmnPrices set with patient 429 backoff; None if it won't clear."""
        backoff = 0
        while backoff < 6:
            try:
                return fetch_set_cards(ppid, delay)
            except RuntimeError as e:
                if "429" not in str(e):
                    raise
                backoff += 1
                print(f"429 ({backoff}/6) — sleeping 300s")
                time.sleep(300)
        print("rate limit would not clear, stopping cleanly")
        return None

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
        pp_cards = fetch_with_backoff(ppid, args.delay)
        if pp_cards is None:
            break
        # index by normalized number for exact matching (plus a name index
        # for the few sets whose numbering doesn't align with PkmnPrices)
        by_num = {}
        by_exact_name = {}
        for it in pp_cards:
            keys = {norm_num(it.get("number"))}
            # "SVP 175" -> also index "175"; "(#23)" in the name -> "23"
            keys.add(re.sub(r"^[A-Z]+", "", norm_num(it.get("number"))))
            m = re.search(r"\(#([0-9A-Z]+)\)", str(it.get("name") or "").upper())
            if m:
                keys.add(norm_num(m.group(1)))
            for k in keys:
                by_num.setdefault(k, []).append(it)
            by_exact_name.setdefault(norm_name(it.get("name")), []).append(it)
        for c in clist:
            hit = None
            # one-off: card lives in a different PkmnPrices set than siblings
            override = CARD_OVERRIDES.get(c["id"])
            if override:
                opp_id, opp_name = override
                if ledger_today() >= DAILY_CAP:
                    print("daily cap reached, stopping cleanly")
                    stop = True
                    break
                opp_cards = fetch_with_backoff(opp_id, args.delay)
                if opp_cards is None:
                    stop = True
                    break
                for it in opp_cards:
                    if norm_name(it.get("name")) == norm_name(opp_name):
                        hit = it
                        break
            elif sid in NAME_MATCH:
                want_name = NAME_ALIASES.get(sid, {}).get(norm_name(c["name"]),
                                                          norm_name(c["name"]))
                for it in by_exact_name.get(want_name, []):
                    hit = it
                    break
            else:
                want = norm_num(c["localId"])
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
    # Catalog writers must not run concurrently (read-modify-write
    # on the same set files). See scripts/pipeline_lock.py.
    from pipeline_lock import pipeline_lock
    with pipeline_lock("en-image-backfill"):
        sys.exit(main())
