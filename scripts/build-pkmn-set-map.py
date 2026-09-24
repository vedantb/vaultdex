#!/usr/bin/env python3
"""Build data/pkmn-set-ids.json: TCGdex/app set id -> PkmnPrices set id.

Why this exists: PkmnPrices set names carry code prefixes ("SV01: ",
"SM - ", "XY - ") and subset suffixes ("Base Set", "Trainer Gallery",
"Shiny Vault") that defeat normalized set-name matching, so the app's
number-only fallback used to price cards as another set's printing --
e.g. Scarlet & Violet Professor's Research #190 ($0.13) as the $36.23
Professor Program promo. Scoping the /v1/cards search with set_id makes
the match exact.

EN: fetch /v1/sets?language=English through the production proxy and
    best-match each TCGdex set (exact normalized name, else a code-aware
    containment match, else manual OVERRIDES).
JA: reuse data/pkmn-cache/manifest.json (ourId -> ppSetId) written by
    scripts/ja-pkmn-enrich.py; sets missing from the manifest are matched
    against /v1/sets?language=Japanese with the same algorithm.

Output keys are the app's set ids ("sv01", "ja-M4"); values carry the
PkmnPrices numeric set id plus the provider name (the repair predicate in
js/collection.js compares the provider name against the old normalization).

Re-run weekly (it is a stage of the catalog refresh): provider set names
and ids drift as new sets release.
"""
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "pkmn-set-ids.json")

# Manual matches the algorithm can't reach (name pairs with no useful
# overlap: "&" vs "and", "Black Star Promos" vs "Promo Cards", split
# trainer-kit halves vs one merged provider set, "Energy" vs "Energies").
# Keyed by our set id, value is the PkmnPrices numeric set id (names as of
# 2026-09-24). The build warns if an override target id vanishes.
OVERRIDES = {
    # Scarlet & Violet promos
    "svp": 505,    # SV: Scarlet & Violet Promo Cards
    # Black Star promo sets -> provider promo sets
    "mep": 502,    # ME: Mega Evolution Promo
    "swshp": 599,  # SWSH: Sword & Shield Promo Cards
    "smp": 539,    # SM Promos
    "xyp": 621,    # XY Promos
    "bwp": 514,    # Black and White Promos
    "hgssp": 472,  # HGSS Promos
    "dpp": 498,    # Diamond and Pearl Promos
    "np": 434,     # Nintendo Promos
    "basep": 555,  # WoTC Promo
    "bog": 576,    # Best of Promos
    # McDonald's collections -> McDonald's promos (exact card counts)
    "2024sv": 513, "2023sv": 426, "2022swsh": 589, "2019sm": 590,
    "2018sm": 579, "2017sm": 517, "2016xy": 430, "2015xy": 556,
    "2014xy": 583, "2012bw": 545, "2011bw": 477,
    # Energies ("Energy" vs "Energies" defeats containment)
    "mee": 425,    # MEE: Mega Evolution Energies
    "sve": 473,    # SVE: Scarlet & Violet Energies
    # "&" vs "and"
    "ex1": 451,    # Ruby and Sapphire
    # Split trainer-kit halves -> the one merged provider set. Safe:
    # the provider keeps both halves' cards (numbers overlap across
    # halves), and the app matches name+number inside the set.
    "tk-sm-r": 520, "tk-sm-l": 520,      # SM Trainer Kit: Lycanroc & Alolan Raichu
    "tk-xy-p": 560, "tk-xy-su": 560,     # XY Trainer Kit: Pikachu Libre & Suicune
    "tk-xy-latio": 515, "tk-xy-latia": 515,  # XY Trainer Kit: Latias & Latios
    "tk-xy-b": 431, "tk-xy-w": 431,      # XY Trainer Kit: Bisharp & Wigglytuff
    "tk-xy-n": 465, "tk-xy-sy": 465,     # XY Trainer Kit: Sylveon & Noivern
    "tk-bw-e": 557, "tk-bw-z": 557,      # BW Trainer Kit: Excadrill & Zoroark
    "tk-hs-r": 433, "tk-hs-g": 433,      # HGSS Trainer Kit: Gyarados & Raichu
    "tk-dp-l": 506, "tk-dp-m": 506,      # DP Trainer Kit: Manaphy & Lucario
    "tk-ex-m": 553, "tk-ex-p": 553,      # EX Trainer Kit 2: Plusle & Minun
    "tk-ex-latia": 516, "tk-ex-latio": 516,  # EX Trainer Kit 1: Latias & Latios
}

PROXY = "https://vaultdex-three.vercel.app/api/pkmnprices"


_PROXY_KEY = None


def _proxy_secret():
    global _PROXY_KEY
    if _PROXY_KEY:
        return _PROXY_KEY
    for env in ("VAULTDEX_PROXY_KEY",):
        if os.environ.get(env):
            _PROXY_KEY = os.environ[env]
            return _PROXY_KEY
    p = os.path.expanduser("~/workspace/.secrets/vaultdex-proxy-key")
    with open(p) as f:
        _PROXY_KEY = f.read().strip()
    return _PROXY_KEY


def proxy_get(path, params):
    # curl, not urllib: urllib flakily truncates responses with
    # IncompleteRead on this VM's egress path; curl is reliable.
    import subprocess
    qs = {"path": path}
    qs.update(params)
    url = PROXY + "?" + urllib.parse.urlencode(qs)
    for attempt in range(4):
        time.sleep(0.6)
        p = subprocess.run(
            ["curl", "-sS", "--max-time", "40", "-w", "\n%{http_code}",
             "-A", "VaultDex-set-map/1.0",
             "-H", "x-vaultdex-key: " + _proxy_secret(), url],
            capture_output=True, timeout=60, check=False)
        if p.returncode != 0:
            continue
        body, _, code = p.stdout.decode("utf-8", "replace").rpartition("\n")
        code = code.strip()
        if code == "403":
            sys.exit("PROXY 403: caller key rejected; check the shared secret.")
        if code == "429" and attempt < 3:
            time.sleep(10 * (attempt + 1))
            continue
        if code == "200" and body.strip():
            return json.loads(body)
    sys.exit("proxy fetch failed for %s %s" % (path, params))


def norm(s):
    """Normalize a set name the way the match needs it: strip a leading
    provider code ("SV01: ", "SM - ", "XY - "), drop inner colons
    ("SWSH: Crown Zenith: Galarian Gallery"), strip accents, lowercase."""
    s = str(s or "")
    s = re.sub(r"^[A-Za-z0-9]+\s*:\s*", "", s)
    s = re.sub(r"^[A-Za-z0-9]+\s+-\s+", "", s)
    s = s.replace(":", "")
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.strip().lower()


def code_of(pp_name):
    """Leading provider code: "SV01: Scarlet & Violet Base Set" -> "sv01",
    "SM - Guardians Rising" -> "sm". None when there is no code."""
    m = re.match(r"^([A-Za-z0-9]+)\s*[:\-]\s*", str(pp_name or ""))
    return m.group(1).lower() if m else None


def code_norm(code):
    """Zero-padding-insensitive code compare: "sv01" -> "sv1"."""
    return re.sub(r"0+(\d)", r"\1", str(code or "").lower())


def best_match(our_id, our_name, pp_sets):
    """Return (pp_set, method) or (None, None)."""
    w = norm(our_name)
    if not w:
        return None, None
    # 1. Exact normalized name.
    for ps in pp_sets:
        if norm(ps["name"]) == w:
            return ps, "exact"
    # 2. Provider code matches our set id (padding-insensitive) and the
    #    names overlap. Catches "sv01" -> "SV01: Scarlet & Violet Base Set".
    oc = code_norm(re.sub(r"^ja-", "", our_id))
    if oc:
        for ps in pp_sets:
            c = code_of(ps["name"])
            if c and code_norm(c) == oc:
                pn = norm(ps["name"])
                if w in pn or pn in w:
                    return ps, "code"
    # 3. Containment, tightest first; prefer the provider name containing
    #    ours over the reverse. Guarded by length: a 1-2 character string
    #    (e.g. our "XY") containment-matches inside unrelated words
    #    ("deoxys") — for those, no mapping beats a wrong one.
    cands = []
    for ps in pp_sets:
        pn = norm(ps["name"])
        if not pn or min(len(w), len(pn)) < 3:
            continue
        if w in pn:
            cands.append((abs(len(pn) - len(w)), 0, ps["id"], ps))
        elif pn in w:
            cands.append((abs(len(pn) - len(w)), 1, ps["id"], ps))
    if cands:
        cands.sort(key=lambda t: (t[0], t[1], t[2]))
        return cands[0][3], "containment"
    return None, None


def fetch_pp_sets(language):
    out = []
    page = 1
    while True:
        d = proxy_get("/v1/sets", {"language": language, "per_page": 200,
                                   "page": page})
        items = d.get("data", [])
        out.extend(items)
        pag = d.get("pagination", {}) or {}
        if page >= int(pag.get("total_pages") or 1):
            break
        page += 1
    return out


def main():
    en_sets = json.load(open(os.path.join(ROOT, "data/tcgdex/sets.json")))
    ja_sets = json.load(open(os.path.join(ROOT, "data/tcgdex/sets-ja.json")))

    pp_en = fetch_pp_sets("English")
    print("provider EN sets: %d" % len(pp_en))
    pp_by_id = {s["id"]: s for s in pp_en}

    result = {}
    warnings = []
    unmatched = []

    for s in en_sets:
        oid = s["id"]
        if oid in OVERRIDES:
            ps = pp_by_id.get(OVERRIDES[oid])
            if ps is None:
                warnings.append("%s: override target pp set %s vanished" %
                                (oid, OVERRIDES[oid]))
                unmatched.append(oid)
                continue
            result[oid] = {"pp": ps["id"], "ppName": ps["name"]}
            continue
        ps, method = best_match(oid, s.get("name"), pp_en)
        if ps is None:
            unmatched.append(oid)
            continue
        # Card-count sanity: a wildly different count means we matched the
        # wrong set (e.g. an energies subset instead of the base set).
        ours = s.get("total") or s.get("printedTotal")
        theirs = ps.get("card_count")
        if ours and theirs:
            drift = abs(int(theirs) - int(ours))
            if drift > max(10, int(0.2 * int(ours))):
                warnings.append(
                    "%s -> '%s' (%s): card count drift ours=%s pp=%s" %
                    (oid, ps["name"], method, ours, theirs))
        result[oid] = {"pp": ps["id"], "ppName": ps["name"]}

    # Japanese: the enricher's manifest is the source of truth.
    man_path = os.path.join(ROOT, "data/pkmn-cache/manifest.json")
    ja_map = {}
    if os.path.exists(man_path):
        man = json.load(open(man_path))
        for e in man.get("sets", []):
            ja_map[e["ourId"]] = {"pp": e["ppSetId"], "ppName": e["ppName"]}
    pp_ja = None
    for s in ja_sets:
        oid = s["id"]  # e.g. "M4"; app ids are "ja-M4"
        if oid in ja_map:
            result["ja-" + oid] = ja_map[oid]
            continue
        if pp_ja is None:
            pp_ja = fetch_pp_sets("Japanese")
            print("provider JA sets: %d" % len(pp_ja))
        ps, method = best_match(oid, s.get("name"), pp_ja)
        if ps is None:
            unmatched.append("ja-" + oid)
            continue
        result["ja-" + oid] = {"pp": ps["id"], "ppName": ps["name"]}

    with open(OUT, "w") as f:
        json.dump(result, f, indent=1, sort_keys=True, ensure_ascii=False)
        f.write("\n")

    print("mapped: %d  unmatched: %d  warnings: %d" %
          (len(result), len(unmatched), len(warnings)))
    if unmatched:
        print("UNMATCHED:")
        for u in unmatched:
            print("  " + u)
    if warnings:
        print("WARNINGS:")
        for wmsg in warnings:
            print("  " + wmsg)


if __name__ == "__main__":
    main()
