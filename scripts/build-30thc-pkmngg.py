#!/usr/bin/env python3
"""Vendor card images for the English 30th Anniversary sets from pkmn.gg.

TCGdex carries no scans for the 30th Classic Collection (30th-c, all 30
cards) and is missing 3 promo-numbered Mews (B/G/R) in 30th Celebration
(30th). PkmnPrices has no 30th Classic Collection equivalent, so images are
vendored from pkmn.gg's set pages into data/tcgdex/card-images/en/<set>/
and referenced via imageSmall/imageLarge — the same approach as the JP M6a
build (scripts/build-m6a-pkmngg.py).

pkmn.gg image URLs are signed and expire — the remote URLs are never stored,
only the vendored files. Re-runs are cache-only: set pages are cached under
data/pkmn-gg-cache/ and already-vendored images are skipped.

Lock note: this script deliberately does NOT take the global pipeline lock.
It only writes data/tcgdex/sets/30th-c.json, data/tcgdex/sets/30th.json and
new files under data/tcgdex/card-images/en/ + data/pkmn-gg-cache/ — none of
which the JA price backfill (or any other active writer) touches. The lock
exists to serialize writers on the SAME files (see scripts/pipeline_lock.py).

Usage:
  python3 scripts/build-30thc-pkmngg.py            # full run (cache-only re-runs)
  python3 scripts/build-30thc-pkmngg.py --refresh  # refetch the pkmn.gg set pages
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "tcgdex")
IMG_ROOT = os.path.join(DATA, "card-images", "en")
PAGE_CACHE = os.path.join(ROOT, "data", "pkmn-gg-cache")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

PAGES = {
    # set id -> (pkmn.gg set page, cache file)
    "30th-c": ("https://www.pkmn.gg/en/series/mega-evolution/30th-anniversary-classic-collection",
               "30th-c-classic-collection.html"),
    "30th": ("https://www.pkmn.gg/en/series/mega-evolution/30th-celebration",
             "30th-celebration.html"),
}

# 30th-c: pkmn.gg keeps the ORIGINAL print numbers (004 Charizard = Base Set
# 4/102) while our TCGdex numbering is sequential 001-030 — same situation as
# Celebrations Classic Collection (cel25cc). Match on normalized name.
# Manual overrides for ambiguous / name-divergent cards:
#   019/020: the two "Darkrai & Cresselia LEGEND" halves (099 = top, 100 = bottom)
#   022: our "Palkia" is the Palkia LV.X reprint
MANUAL_30THC = {
    "019": "099",
    "020": "100",
    "022": "106-palkia-lv-x",
}


def norm_name(s):
    t = unicodedata.normalize("NFD", str(s or ""))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]", "", t.lower())


def fetch_page(set_id, refresh=False):
    url, cache_name = PAGES[set_id]
    os.makedirs(PAGE_CACHE, exist_ok=True)
    cache_path = os.path.join(PAGE_CACHE, cache_name)
    if not refresh and os.path.isfile(cache_path) and os.path.getsize(cache_path) > 10000:
        with open(cache_path, encoding="utf-8") as f:
            return f.read()
    print("fetching %s" % url, flush=True)
    html = subprocess.run(
        ["curl", "-sS", "--max-time", "60", "-A", UA, url],
        capture_output=True, text=True, check=True).stdout
    if "__NEXT_DATA__" not in html:
        raise RuntimeError("pkmn.gg page for %s did not return card data" % set_id)
    with open(cache_path, "w", encoding="utf-8") as f:
        f.write(html)
    return html


def parse_cards(html):
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
                  html, re.S)
    if not m:
        raise RuntimeError("no __NEXT_DATA__ in pkmn.gg page")
    data = json.loads(m.group(1))
    return data["props"]["pageProps"]["cardData"]


def download(url, dest):
    """Download one image; refetch the set page once if the signature expired."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in (0, 1):
        r = subprocess.run(
            ["curl", "-sS", "--max-time", "60", "-A", UA, "-o", dest,
             "-w", "%{http_code}", url],
            capture_output=True, text=True)
        code = r.stdout.strip()
        if code == "200" and os.path.getsize(dest) > 5000:
            with open(dest, "rb") as f:
                magic = f.read(12)
            if magic[:4] == b"RIFF" and magic[8:12] == b"WEBP":
                return True
        if attempt == 0:
            # possibly an expired signature — signal the caller to refetch
            # the set page and retry with a fresh URL
            return "refetch"
    return False


def build_mapping_30thc(cards):
    """Map our localId -> pkmn.gg card via normalized name + manual overrides."""
    by_norm = {}
    for c in cards:
        by_norm.setdefault(norm_name(c["name"]), []).append(c)
    mapping = {}
    for local_id, name in OUR_30THC_NAMES:
        if local_id in MANUAL_30THC:
            key = MANUAL_30THC[local_id]
            hit = next((c for c in cards if c["numberKey"] == key), None)
            if not hit:
                raise RuntimeError("manual override %s -> %s not on pkmn.gg" % (local_id, key))
            mapping[local_id] = hit
            continue
        cands = by_norm.get(norm_name(name), [])
        if len(cands) != 1:
            raise RuntimeError("ambiguous/no pkmn.gg match for 30th-c %s %s (%d candidates)"
                               % (local_id, name, len(cands)))
        mapping[local_id] = cands[0]
    if len(set(id(c) for c in mapping.values())) != len(mapping):
        raise RuntimeError("two localIds mapped to the same pkmn.gg card")
    return mapping


def load_set(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def detect_format(path):
    """Return (indent, separators) matching the file's existing formatting."""
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    has_non_ascii = any(ord(ch) > 127 for ch in raw)
    if re.search(r'\n +"set"', raw):
        m = re.search(r'\n( +)"set"', raw)
        return {"indent": len(m.group(1)), "ensure_ascii": not has_non_ascii}
    return {"separators": (",", ":"), "ensure_ascii": not has_non_ascii}


def write_set(path, doc):
    fmt = detect_format(path)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, **fmt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true",
                    help="refetch the pkmn.gg set pages instead of using cache")
    ap.add_argument("--delay", type=float, default=1.2,
                    help="seconds between image downloads")
    args = ap.parse_args()

    # ---- 30th-c: map all 30 cards ----
    html_cc = fetch_page("30th-c", refresh=args.refresh)
    cc_cards = parse_cards(html_cc)

    set_path = os.path.join(DATA, "sets", "30th-c.json")
    doc = load_set(set_path)
    global OUR_30THC_NAMES
    OUR_30THC_NAMES = [(c["localId"], c["name"]) for c in doc["cards"]]
    assert len(OUR_30THC_NAMES) == 30, "expected 30 cards in 30th-c, got %d" % len(OUR_30THC_NAMES)
    mapping = build_mapping_30thc(cc_cards)
    print("30th-c: mapped %d/30 cards to pkmn.gg" % len(mapping))

    vendored = 0
    for local_id in sorted(mapping):
        card = mapping[local_id]
        dest = os.path.join(IMG_ROOT, "30th-c", "%s.webp" % local_id)
        rel = "/data/tcgdex/card-images/en/30th-c/%s.webp" % local_id
        if not (os.path.isfile(dest) and os.path.getsize(dest) > 5000):
            url = card["largeImageUrl"]
            ok = download(url, dest)
            if ok == "refetch":
                # signature expired mid-run: re-parse fresh page, retry once
                html_cc = fetch_page("30th-c", refresh=True)
                fresh = {c["numberKey"]: c for c in parse_cards(html_cc)}
                url = fresh[card["numberKey"]]["largeImageUrl"]
                ok = download(url, dest)
            if not ok:
                raise RuntimeError("failed to vendor image for 30th-c %s" % local_id)
            vendored += 1
            time.sleep(args.delay)
        for c in doc["cards"]:
            if c["localId"] == local_id:
                c["imageSmall"] = rel
                c["imageLarge"] = rel
    write_set(set_path, doc)
    print("30th-c: vendored %d new images, set JSON updated" % vendored)

    # ---- 30th: fill the 3 promo-numbered Mews (B/G/R) ----
    set30_path = os.path.join(DATA, "sets", "30th.json")
    doc30 = load_set(set30_path)
    gaps = [c for c in doc30["cards"] if not c.get("image")]
    print("30th: %d cards without TCGdex images: %s"
          % (len(gaps), [(c["localId"], c["name"]) for c in gaps]))
    if gaps:
        html_30 = fetch_page("30th", refresh=args.refresh)
        gg30 = {c["numberKey"]: c for c in parse_cards(html_30)}

        vendored30 = 0
        for c in gaps:
            lid = c["localId"]
            hit = gg30.get(lid)
            if not hit:
                print("  30th %s %s: no pkmn.gg match, leaving imageless" % (lid, c["name"]))
                continue
            dest = os.path.join(IMG_ROOT, "30th", "%s.webp" % lid)
            rel = "/data/tcgdex/card-images/en/30th/%s.webp" % lid
            if not (os.path.isfile(dest) and os.path.getsize(dest) > 5000):
                ok = download(hit["largeImageUrl"], dest)
                if ok == "refetch":
                    html_30 = fetch_page("30th", refresh=True)
                    gg30 = {cc["numberKey"]: cc for cc in parse_cards(html_30)}
                    ok = download(gg30[lid]["largeImageUrl"], dest)
                if not ok:
                    raise RuntimeError("failed to vendor image for 30th %s" % lid)
                vendored30 += 1
                time.sleep(args.delay)
            c["imageSmall"] = rel
            c["imageLarge"] = rel
        write_set(set30_path, doc30)
        print("30th: vendored %d new images, set JSON updated" % vendored30)

    print("done")


if __name__ == "__main__":
    main()
