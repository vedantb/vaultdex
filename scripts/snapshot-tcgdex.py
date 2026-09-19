#!/usr/bin/env python3
"""VaultDex — TCGdex catalog snapshot generator.

Downloads the TCGdex English and Japanese catalogs into versioned static
JSON files under data/tcgdex/ so the app serves catalog data itself
instead of calling the TCGdex API on every load. Only pricing
(PkmnPrices) stays live.

Layout:
  data/tcgdex/manifest.json      { generated_at, sets: [ids], index_cards }
  data/tcgdex/sets.json          [{ id, name, logo, symbol, printedTotal,
                                    total, series, eraRank, setRank, lang }]
  data/tcgdex/sets-ja.json       same shape, lang="ja"
  data/tcgdex/index.json         raw /v2/en/cards response (search index)
  data/tcgdex/sets/<setId>.json  { generated_at, set: {...}, cards: [trimmed] }
  data/tcgdex/sets/ja/<setId>.json  same shape for Japanese sets

Japanese promo sets TCGdex doesn't carry (S-P, SM-P, XY-P, BW-P, ...) are
hand-maintained in scripts/ja-custom-sets.json and merged into sets-ja.json
(plus empty per-set shells) on every '--lang ja' run, so the weekly
regeneration can't wipe them. The PkmnPrices pipeline
(scripts/ja-pkmn-enrich.py -> ja-pkmn-build-cards.py ->
ja-price-backfill.py) fills their cards, images, and prices.

Trimmed card details keep exactly what the app renders (id, name, number,
rarity, artist, image, types, hp, print variants) plus a slimmed pricing
summary (TCGdex tcgplayer marketPrice per print variant — the only number
the tile badges and modal price table use). Attack text and the rest of the
pricing blobs are dropped (modal fetches one live detail when opened).

Series/era info: each set-list entry carries the series display label,
eraRank (0 = newest era, e.g. Mega Evolution) and setRank (0 = newest set
within its era), derived from the /series endpoints. Japanese series are
mapped to English era labels.

Usage:
  python3 scripts/snapshot-tcgdex.py --sets --index --set me02.5
  python3 scripts/snapshot-tcgdex.py --sets --lang ja
  python3 scripts/snapshot-tcgdex.py --all [--workers 4] [--lang ja]

--all is resumable: sets already snapshotted are skipped. Delete
data/tcgdex/sets/<id>.json (or sets/ja/<id>.json) to force a refresh.

Be nice to the free API: default 4 req/s with backoff on 429.
"""
import argparse
import http.client
import json
import os
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

API_ROOT = "https://api.tcgdex.net/v2"
BASE = API_ROOT + "/en"
OUT = "data/tcgdex"
RATE = 4  # requests per second across workers
LANG = "en"

# Series excluded from the set lists entirely (not shown in the app).
HIDDEN_SERIES = {"tcgp"}  # Pokémon TCG Pocket (mobile game)

# Explicit era order, newest first. The /series list order is chronological
# for English but not for Japanese, so eras are ranked from these lists
# (any series missing from the list lands at the end, in API order).
ERA_ORDER = {
    "en": ["me", "tcgp", "sv", "swsh", "sm", "xy", "mc", "bw", "col",
           "hgss", "pl", "dp", "tk", "pop", "ex", "ecard", "lc", "neo",
           "gym", "base", "misc"],
    "ja": ["M", "SV", "S", "SM", "XYb", "XY", "L", "PCG", "ADV", "e",
           "web", "VS", "neo", "PMCG"],
}

# Japanese series id -> English era display label.
JA_SERIES_LABELS = {
    "M": "Mega Evolution",
    "SV": "Scarlet & Violet",
    "S": "Sword & Shield",
    "SM": "Sun & Moon",
    "XYb": "XY BREAK",
    "XY": "XY",
    "L": "LEGEND",
    "PCG": "PCG",
    "ADV": "ADV",
    "e": "E-Card",
    "web": "web",
    "VS": "VS",
    "neo": "Neo",
    "PMCG": "Base",
}

# Japanese TCGdex set id -> the English set name the community actually
# uses (Limitless TCG / Bulbapedia conventions — never machine-translated).
# Applied to Japanese set lists and set headers; the Japanese name is kept
# as nameJa. Loaded lazily so --lang en runs don't pay for it.
_JA_EN_NAMES = None
def ja_en_names():
    global _JA_EN_NAMES
    if _JA_EN_NAMES is None:
        import os
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ja-set-names.json")
        with open(p, encoding="utf-8") as f:
            _JA_EN_NAMES = json.load(f)
    return _JA_EN_NAMES


def ja_assets(set_id):
    """Local logo + symbol for a Japanese set, downloading once and caching.

    TCGdex has no Japanese set art, so logos come from Bulbapedia's
    <id>_Logo_JP.png / <id>_Logo.png files and symbols from Limitless TCG's
    per-set S3 images. Returns (logo_rel, symbol_rel) — root-relative paths
    served from data/ — with None for anything unavailable. Downloads are
    cached on disk, so weekly re-runs are no-ops."""
    import os
    logo_dir = os.path.join(OUT, "set-logos", "ja")
    sym_dir = os.path.join(OUT, "set-symbols", "ja")
    os.makedirs(logo_dir, exist_ok=True)
    os.makedirs(sym_dir, exist_ok=True)

    def fetch(url, dest):
        import hashlib
        if os.path.isfile(dest) and os.path.getsize(dest) > 0:
            return True
        # Negative cache (per URL): don't re-attempt a download that failed.
        miss = dest + "." + hashlib.md5(url.encode()).hexdigest()[:8] + ".miss"
        if os.path.isfile(miss):
            return False
        try:
            r = subprocess.run(
                ["curl", "-sfL", "--max-time", "30", "-A", "VaultDex-snapshot/1.0",
                 "-o", dest, url],
                capture_output=True, timeout=45)
            if r.returncode == 0 and os.path.getsize(dest) > 0:
                return True
        except Exception:
            pass
        try:
            os.remove(dest)
        except OSError:
            pass
        open(miss, "w").write("miss\n")
        return False

    logo_rel = None
    logo_path = os.path.join(logo_dir, set_id + ".png")
    for cand in ("https://archives.bulbagarden.net/wiki/Special:FilePath/%s_Logo_JP.png?width=440"
                 % set_id,
                 "https://archives.bulbagarden.net/wiki/Special:FilePath/%s_Logo.png?width=440"
                 % set_id):
        if fetch(cand, logo_path):
            logo_rel = "/data/tcgdex/set-logos/ja/%s.png" % set_id
            break

    symbol_rel = None
    sym_path = os.path.join(sym_dir, set_id + ".png")
    if fetch("https://s3.limitlesstcg.com/sets/jp/%s.png" % set_id, sym_path):
        symbol_rel = "/data/tcgdex/set-symbols/ja/%s.png" % set_id
    return logo_rel, symbol_rel


# Local set-logo overrides for English sets whose artwork TCGdex hasn't
# published yet (e.g. brand-new sets like the 30th Celebration line).
# Applied only when TCGdex reports no logo, so official art wins
# automatically once it exists. Files live in data/tcgdex/set-logos/
# and are committed alongside the snapshots.
EN_LOGO_OVERRIDES = {
    "30th": "/data/tcgdex/set-logos/30th.png",
    "30th-c": "/data/tcgdex/set-logos/30th.png",
}


def apply_en_logo_override(set_id, logo):
    if not logo and set_id in EN_LOGO_OVERRIDES:
        return EN_LOGO_OVERRIDES[set_id]
    return logo


def apply_ja_display(entry):
    """Give a Japanese set entry/header its community English name and art.

    entry is a dict with id/name/logo/symbol keys (mutated in place)."""
    names = ja_en_names()
    sid = entry.get("id")
    entry["nameJa"] = entry.get("name")
    entry["name"] = names.get(sid, entry.get("name"))
    logo_rel, symbol_rel = ja_assets(sid)
    entry["logo"] = logo_rel
    entry["symbol"] = symbol_rel
    return entry


# Populated by snapshot_sets() for LANG == "ja": ids of hand-maintained
# sets merged from scripts/ja-custom-sets.json. main() excludes these from
# the per-set TCGdex fetch loop (TCGdex has no such sets; fetching would
# just 404).
CUSTOM_JA_IDS = []


def merge_custom_ja_sets(out):
    """Merge hand-maintained Japanese sets into the JA set list.

    Entries live in scripts/ja-custom-sets.json (promo series TCGdex
    doesn't carry). Called after the TCGdex list is built, so a weekly
    '--lang ja' regeneration can't wipe them: if TCGdex ever gains one of
    these sets, the TCGdex entry wins and the custom one is skipped.
    Returns (merged_list, custom_ids). Also ensures each custom set has a
    per-set snapshot shell under data/tcgdex/sets/ja/ so the PkmnPrices
    pipeline (enrich -> build-cards -> price backfill) can fill it.
    """
    import os
    have = {e["id"] for e in out}
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "ja-custom-sets.json")
    try:
        cfg = json.load(open(cfg_path, encoding="utf-8"))
    except OSError:
        return out, []
    names = ja_en_names()
    custom_ids = []
    for c in cfg.get("sets", []):
        sid = c["id"]
        custom_ids.append(sid)
        if sid in have:
            continue  # TCGdex gained the set; its entry wins
        entry = {
            "id": sid,
            # apply_ja_display maps name -> community English name and
            # stashes the current name as nameJa, so seed name with the
            # Japanese name from the manifest.
            "name": c.get("nameJa") or names.get(sid, sid),
            "logo": None,
            "symbol": None,
            "printedTotal": c.get("printedTotal", 0),
            "total": c.get("total", 0),
            "series": c.get("series"),
            "eraRank": c.get("eraRank", 999),
            "setRank": c.get("setRank", 999),
            "lang": "ja",
        }
        apply_ja_display(entry)
        out.append(entry)
        ensure_custom_shell(entry, c.get("releaseDate"))
    return out, custom_ids


def ensure_custom_shell(entry, release_date=None):
    """Create data/tcgdex/sets/ja/<id>.json with an empty card list when
    missing. Never overwrites an existing shell (cards already built stay)."""
    import os
    rel = "sets/ja/%s.json" % entry["id"]
    path = os.path.join(OUT, rel)
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        return
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "set": {
            "id": entry["id"],
            "name": entry["name"],
            "nameJa": entry.get("nameJa"),
            "series": entry.get("series"),
            "releaseDate": release_date,
            "logo": entry.get("logo"),
            "symbol": entry.get("symbol"),
            "printedTotal": entry.get("printedTotal"),
            "total": entry.get("total"),
            "lang": "ja",
            "custom": True,
        },
        "cards": [],
    }
    write(rel, payload)


def deep_unwrap(o):
    """Recursively JSON-decode any string values that are themselves
    encoded JSON (TCGdex flakily nests encoded strings at any depth)."""
    if isinstance(o, str):
        s = o.strip()
        if s[:1] in "{[":
            try:
                return deep_unwrap(json.loads(s))
            except Exception:
                pass
        return o
    if isinstance(o, dict):
        return {k: deep_unwrap(v) for k, v in o.items()}
    if isinstance(o, list):
        return [deep_unwrap(v) for v in o]
    return o


def fetch(path, retries=5):
    """Fetch JSON via curl (urllib flakily truncates TCGdex responses with
    IncompleteRead; curl is reliable). Retries 429/5xx/network errors."""
    url = BASE + path
    for attempt in range(retries):
        try:
            p = subprocess.run(
                ["curl", "-sS", "--max-time", "40", "-w", "\n%{http_code}",
                 "-A", "VaultDex-snapshot/1.0", url],
                capture_output=True, timeout=60, check=False)
            if p.returncode != 0:
                raise OSError("curl exit %d: %s" % (p.returncode, p.stderr.decode()[:200]))
            body, _, code = p.stdout.decode("utf-8", "replace").rpartition("\n")
            code = code.strip()
            if code == "429" or code.startswith("5"):
                raise OSError("HTTP " + code + " (retryable)")
            if code != "200":
                raise RuntimeError("HTTP %s for %s" % (code, url))
            # TCGdex flakily double-encodes JSON for non-browser clients;
            # deep_unwrap keeps responses parseable either way.
            return deep_unwrap(json.loads(body))
        except Exception as e:  # noqa: BLE001
            if attempt < retries - 1:
                time.sleep(2 ** attempt * 2)
                continue
            raise RuntimeError("failed %s: %r" % (url, e))
    raise RuntimeError("failed: " + url)


_last = [0.0]


def polite(path):
    # crude global rate limiter
    wait = (1.0 / RATE) - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    out = fetch(path)
    _last[0] = time.time()
    return out


def trim_detail(c):
    vd = []
    for v in c.get("variants_detailed") or []:
        vd.append({"type": v.get("type"), "foil": v.get("foil")})
    # Slim pricing: only tcgplayer marketPrice per print variant — the one
    # number tile badges and the modal price table read (via pricesOf()).
    pricing = None
    tp = (c.get("pricing") or {}).get("tcgplayer") or {}
    slim = {}
    for variant, blk in tp.items():
        # tcgplayer mixes metadata strings (unit, updated) with per-variant
        # price objects — only the objects carry marketPrice.
        if not isinstance(blk, dict):
            continue
        mp = blk.get("marketPrice")
        if isinstance(mp, (int, float)):
            slim[variant] = {"marketPrice": mp}
    if slim:
        pricing = {"tcgplayer": slim}
    return {
        "id": c.get("id"),
        "localId": c.get("localId"),
        "name": c.get("name"),
        "rarity": c.get("rarity"),
        "illustrator": c.get("illustrator"),
        "image": c.get("image"),
        "category": c.get("category"),
        "types": c.get("types"),
        "hp": c.get("hp"),
        "variants_detailed": vd,
        "pricing": pricing,
    }


def snapshot_sets():
    """Fetch the set list plus series membership. Each entry gets:
    series (display label), eraRank (0 = newest era), setRank (0 = newest
    set within its era). English writes sets.json, Japanese sets-ja.json.
    """
    arr = polite("/sets")
    # Map set id -> (series label, era rank, set rank). Series come back
    # oldest-first; eras are ranked newest-first (Mega Evolution = 0).
    era_map = {}
    hidden_sets = set()
    try:
        series = polite("/series") or []
    except Exception as e:  # noqa: BLE001
        print("  !! /series failed: %r — sets will have no era info" % e, file=sys.stderr)
        series = []
    want = ERA_ORDER.get(LANG, [])
    ordered = [s for sid in want for s in series if s.get("id") == sid]
    ordered += [s for s in series if s.get("id") not in want]
    for era_rank, ser in enumerate(ordered):
        sid = ser.get("id")
        try:
            detail = polite("/series/" + sid)
        except Exception as e:  # noqa: BLE001
            print("  !! /series/%s failed: %r — skipping" % (sid, e), file=sys.stderr)
            continue
        sets_in_series = (detail.get("sets") or [])
        if sid in HIDDEN_SERIES:
            hidden_sets.update(s.get("id") for s in sets_in_series)
            continue
        label = ser.get("name")
        if LANG == "ja":
            label = JA_SERIES_LABELS.get(sid, label)
        # English series arrays are chronological (oldest first) — reverse
        # for newest-first. Japanese arrays aren't reliably ordered, so
        # keep the API's stable order.
        if LANG == "en":
            sets_in_series = list(reversed(sets_in_series))
        for set_rank, s in enumerate(sets_in_series):
            era_map[s.get("id")] = (label, era_rank, set_rank)
    out = []
    for s in arr:
        if s.get("id") in hidden_sets:
            continue
        info = era_map.get(s.get("id")) or (None, 999, 999)
        entry = {
            "id": s.get("id"),
            "name": s.get("name"),
            "logo": apply_en_logo_override(s.get("id"), s.get("logo")),
            "symbol": s.get("symbol"),
            "printedTotal": (s.get("cardCount") or {}).get("official"),
            "total": (s.get("cardCount") or {}).get("total"),
            "series": info[0],
            "eraRank": info[1],
            "setRank": info[2],
            "lang": LANG,
        }
        if LANG == "ja":
            apply_ja_display(entry)
        out.append(entry)
    # Keep newest era / newest set first.
    out.sort(key=lambda e: (e["eraRank"], e["setRank"]))
    custom_ids = []
    if LANG == "ja":
        # Hand-maintained sets TCGdex doesn't carry (promo series). Merged
        # after the TCGdex list so weekly regenerations can't wipe them.
        out, custom_ids = merge_custom_ja_sets(out)
        out.sort(key=lambda e: (e["eraRank"], e["setRank"]))
    global CUSTOM_JA_IDS
    CUSTOM_JA_IDS = custom_ids
    fname = "sets.json" if LANG == "en" else "sets-ja.json"
    write(fname, out)
    # Custom JA sets have no TCGdex endpoint; the PkmnPrices pipeline
    # fills their per-set files instead. Exclude them from fetch targets.
    return [s["id"] for s in out if s["id"] not in custom_ids]


def snapshot_index():
    arr = polite("/cards")
    write("index.json", arr)
    return len(arr)


def preserve_backfilled_images(payload, rel):
    """Merge backfilled imageSmall/imageLarge (scripts/en-image-backfill.py,
    scripts/ja-pkmn-enrich.py) into a fresh snapshot payload.

    Cards TCGdex still carries no image for keep their backfilled images;
    when TCGdex now provides a canonical image it wins and the backfilled
    fields are dropped so they can't shadow it.
    """
    old_imgs = {}
    try:
        with open(os.path.join(OUT, rel), encoding="utf-8") as f:
            old_payload = json.load(f)
        for c in old_payload.get("cards") or []:
            if c.get("imageSmall") or c.get("imageLarge"):
                old_imgs[c.get("id")] = (c.get("imageSmall"), c.get("imageLarge"))
    except Exception:  # noqa: BLE001 — no previous snapshot, nothing to keep
        return payload
    for d in payload.get("cards") or []:
        if d.get("image"):
            d.pop("imageSmall", None)
            d.pop("imageLarge", None)
        elif d.get("id") in old_imgs:
            small, large = old_imgs[d["id"]]
            if small:
                d["imageSmall"] = small
            if large:
                d["imageLarge"] = large
    return payload


def snapshot_set(set_id):
    s = polite("/sets/" + set_id)
    summaries = s.get("cards") or []
    dropped = []

    def one(c0):
        try:
            return trim_detail(polite("/cards/" + c0["id"]))
        except Exception as e:  # noqa: BLE001
            print("  !! %s: %s" % (c0.get("id"), e), file=sys.stderr)
            dropped.append(c0.get("id"))
            return None

    cards = []
    with ThreadPoolExecutor(max_workers=RATE) as ex:
        for d in ex.map(one, summaries):
            if d:
                cards.append(d)
    if dropped:
        # Incomplete payloads are re-attempted on resume (see have_set):
        # re-fetching the whole set is cheaper than tracking per-card.
        print("  !! %s: dropped %d card(s): %s"
              % (set_id, len(dropped), ", ".join(str(x) for x in dropped)),
              file=sys.stderr)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "droppedCardIds": dropped,
        "set": {
            "id": s.get("id"),
            "name": s.get("name"),
            "series": (s.get("serie") or {}).get("name"),
            "releaseDate": s.get("releaseDate"),
            "logo": apply_en_logo_override(s.get("id"), s.get("logo")),
            "symbol": s.get("symbol"),
            "printedTotal": (s.get("cardCount") or {}).get("official"),
            "total": (s.get("cardCount") or {}).get("total"),
            "lang": LANG,
        },
        "cards": cards,
    }
    if LANG == "ja":
        apply_ja_display(payload["set"])
    rel = "sets/%s.json" % set_id if LANG == "en" else "sets/ja/%s.json" % set_id
    payload = preserve_backfilled_images(payload, rel)
    write(rel, payload)
    return len(cards)


def set_rel(set_id):
    return "sets/%s.json" % set_id if LANG == "en" else "sets/ja/%s.json" % set_id


def have_set(set_id):
    """True when the snapshot exists and is complete: parseable JSON with
    no dropped cards. Corrupt files and incomplete payloads return False
    so a resumed --all run re-attempts the whole set."""
    import os

    p = os.path.join(OUT, set_rel(set_id))
    if not (os.path.isfile(p) and os.path.getsize(p) > 0):
        return False
    try:
        with open(p) as f:
            payload = json.load(f)
    except Exception:  # corrupt JSON: re-fetch the set
        return False
    return not payload.get("droppedCardIds")


def write(rel, obj):
    import os

    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, path)
    print("wrote %s" % path, file=sys.stderr)


def main():
    global RATE, BASE, LANG
    ap = argparse.ArgumentParser()
    ap.add_argument("--sets", action="store_true")
    ap.add_argument("--index", action="store_true")
    ap.add_argument("--set", dest="one_set")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--workers", type=int, default=RATE)
    ap.add_argument("--lang", choices=["en", "ja"], default="en",
                    help="catalog language to snapshot (default en)")
    args = ap.parse_args()
    RATE = max(1, args.workers)
    LANG = args.lang
    BASE = API_ROOT + "/" + LANG

    if args.all or args.sets:
        ids = snapshot_sets()
    else:
        ids = None
    if (args.all or args.index) and LANG == "en":
        # The upstream /cards index is English-only; the app merges it with
        # the locally-built index-ja.json at runtime, so Japanese sets are
        # searchable too. Local-only cards (e.g. 30th promos TCGdex lacks)
        # are merged into index.json by hand — do not overwrite blindly.
        n = snapshot_index()
        print("index: %d cards" % n, file=sys.stderr)
    targets = []
    if args.one_set:
        targets = [args.one_set]
    elif args.all:
        targets = ids or []
    for i, sid in enumerate(targets):
        if args.all and not args.one_set and have_set(sid):
            print("[%d/%d] %s: skipped (already snapshotted)" % (i + 1, len(targets), sid), file=sys.stderr)
            continue
        try:
            n = snapshot_set(sid)
        except Exception as e:
            print("[%d/%d] %s: FAILED (%r) — continuing" % (i + 1, len(targets), sid, e), file=sys.stderr)
            continue
        print("[%d/%d] %s: %d cards" % (i + 1, len(targets), sid, n), file=sys.stderr)
    if args.all and ids is not None:
        import os

        setdir = os.path.join(OUT, "sets") if LANG == "en" else os.path.join(OUT, "sets", "ja")
        have = sorted(
            f[:-5]
            for f in os.listdir(setdir)
            if f.endswith(".json")
        )
        write(
            "manifest.json" if LANG == "en" else "manifest-ja.json",
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "lang": LANG,
                "sets": have,
                "set_count": len(have),
            },
        )


if __name__ == "__main__":
    # Catalog writers must not run concurrently (read-modify-write
    # on the same set files). See scripts/pipeline_lock.py.
    from pipeline_lock import pipeline_lock
    with pipeline_lock("snapshot-tcgdex"):
        main()
