#!/usr/bin/env python3
"""One-time gentle pull of pkmn.gg's Japanese 30th Celebration (M6a) set.

Writes:
  data/pkmn-gg-m6a.json               - 173-card list from the set page's embedded JSON
  data/pkmn-gg-cache/m6a-<num>.json   - per-card page JSON (types, hp, baseImagePath, ...)
  data/tcgdex/card-images/ja/M6a/<num>.png - vendored card scans (pkmn.gg image URLs
      are signed and expire, so we self-host instead of hotlinking)

Politeness: single-threaded, 2s between page fetches, 1s between image
downloads, proper UA, resumable (skips cached files), 3 retries with backoff.
~173 pages + 173 images => roughly 10 minutes.

This is a TEMPORARY source until TCGdex / PkmnPrices carry M6a. The weekly
refresh must NOT re-run this script unprompted; it re-runs only
build-m6a-pkmngg.py from the cached extraction.

Runtime guard: main() refuses to run unless --i-am-sure is passed, so the
script can never land in a cron or a careless shell glob and re-hit the
fan site.
"""
import json, re, subprocess, sys, time, os

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
SET_URL = "https://www.pkmn.gg/jp/series/mega-evolution/30th-celebration"
CARD_URL = SET_URL + "/{num}"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_LIST = os.path.join(HERE, "data", "pkmn-gg-m6a.json")
CACHE_DIR = os.path.join(HERE, "data", "pkmn-gg-cache")
IMG_DIR = os.path.join(HERE, "data", "tcgdex", "card-images", "ja", "M6a")
IMG_EXT = "webp"  # largeImageUrl is 600x836 webp (baseImagePath serves AVIF despite .png path)

os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(IMG_DIR, exist_ok=True)


def fetch(url, out_path=None, retries=3):
    for attempt in range(retries):
        try:
            cmd = ["curl", "-sS", "--max-time", "40", "-A", UA, url]
            if out_path:
                cmd += ["-o", out_path]
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                if r.returncode == 0 and os.path.getsize(out_path) > 1000:
                    return True
            else:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                if r.returncode == 0 and len(r.stdout) > 10000:
                    return r.stdout
        except Exception as e:
            print(f"  attempt {attempt+1} error: {e}", flush=True)
        time.sleep(2 * (attempt + 1))
    return None


def next_data_props(html):
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        return None
    return json.loads(m.group(1))["props"]["pageProps"]


def main():
    # Stage 1: set page -> full 173-card list
    if os.path.exists(RAW_LIST):
        cards = json.load(open(RAW_LIST, encoding="utf-8"))
        print(f"Stage 1: using cached list ({len(cards)} cards)")
    else:
        print("Stage 1: fetching set page...", flush=True)
        html = fetch(SET_URL)
        if not html:
            sys.exit("FAILED to fetch set page")
        pp = next_data_props(html)
        cards = pp["pageProps"]["cardData"] if "pageProps" in pp else pp["cardData"]
        json.dump(cards, open(RAW_LIST, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"Stage 1: saved {len(cards)} cards -> {RAW_LIST}", flush=True)

    # Stage 2: per-card pages
    print(f"Stage 2: per-card pages ({len(cards)} cards, ~2.5s apart)...", flush=True)
    details = {}
    for i, c in enumerate(cards):
        num = c["numberKey"]
        cache = os.path.join(CACHE_DIR, f"m6a-{num}.json")
        if os.path.exists(cache):
            details[num] = json.load(open(cache, encoding="utf-8"))
            continue
        cd = None
        for attempt in range(3):
            html = fetch(CARD_URL.format(num=num))
            if html:
                pp = next_data_props(html)
                if pp:
                    cd = pp.get("cardData", pp)
                    break
            print(f"  {num}: no card data (attempt {attempt+1}/3), retrying...", flush=True)
            time.sleep(5)
        if not cd:
            print(f"  !! {num} failed after retries, will use set-page data only", flush=True)
            continue
        json.dump(cd, open(cache, "w", encoding="utf-8"), ensure_ascii=False)
        details[num] = cd
        if (i + 1) % 25 == 0:
            print(f"  {i+1}/{len(cards)}...", flush=True)
        time.sleep(2.5)
    print(f"Stage 2: done ({len(details)}/{len(cards)} detail files)", flush=True)

    # Stage 3: vendor images (largeImageUrl webp; signatures are one-time use)
    print("Stage 3: downloading card images (~1s apart)...", flush=True)
    done, failed = 0, []
    for i, c in enumerate(cards):
        num = c["numberKey"]
        dest = os.path.join(IMG_DIR, f"{num}.{IMG_EXT}")
        if os.path.exists(dest) and os.path.getsize(dest) > 5000:
            done += 1
            continue
        cd = details.get(num)
        if cd is None and os.path.exists(os.path.join(CACHE_DIR, f"m6a-{num}.json")):
            cd = json.load(open(os.path.join(CACHE_DIR, f"m6a-{num}.json"), encoding="utf-8"))
        img_url = c.get("largeImageUrl") or (cd or {}).get("largeImageUrl")
        if not img_url:
            failed.append(num)
            continue
        ok = fetch(img_url, out_path=dest)
        # verify WebP magic: RIFF....WEBP
        if ok:
            with open(dest, "rb") as f:
                head = f.read(12)
                if not (head[:4] == b"RIFF" and head[8:12] == b"WEBP"):
                    ok = False
        if ok:
            done += 1
        else:
            failed.append(num)
            if os.path.exists(dest):
                os.remove(dest)
        if (i + 1) % 25 == 0:
            print(f"  {i+1}/{len(cards)} images...", flush=True)
        time.sleep(1.0)
    print(f"Stage 3: {done}/{len(cards)} images vendored", flush=True)
    if failed:
        print(f"  failed images: {failed}", flush=True)


if __name__ == "__main__":
    if "--i-am-sure" not in sys.argv:
        print("Refusing to run: pull-pkmngg-m6a.py hits a third-party fan "
              "site (pkmn.gg) and must not be re-run unprompted. If you "
              "really mean it, re-run with --i-am-sure.", file=sys.stderr)
        sys.exit(1)
    main()
