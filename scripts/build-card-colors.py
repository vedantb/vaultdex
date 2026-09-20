#!/usr/bin/env python3
"""Extract dominant art-region palettes for every catalog card.

Reads local per-set snapshots (data/tcgdex/sets/*.json + sets/ja/*.json),
downloads each card's image (or reads vendored files directly), crops to the
art window, quantizes to dominant colors, and writes HSL palettes to
data/card-colors.json keyed by "lang:cardId".

Resumable: cards already in the output are skipped unless --force.
The Binder Studio generator degrades gracefully for cards without palettes
(falls back to energy-type colors), so a partial file is always usable.

Usage:
  python3 scripts/build-card-colors.py [--limit N] [--only en|ja]
      [--set <setId>] [--force] [--workers N]
"""
import argparse
import concurrent.futures as cf
import hashlib
import io
import json
import math
import os
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "tcgdex")
OUT_PATH = os.path.join(ROOT, "data", "card-colors.json")

CURL_TIMEOUT = 30
CURL_RETRIES = 3
# Art-window crop as fractions of (left, upper, right, lower). Catches the
# illustration box across eras while skipping borders and attack text.
CROP = (0.10, 0.08, 0.90, 0.52)


def log(*a):
    print(*a, flush=True)


def set_files(lang):
    d = os.path.join(DATA, "sets", "ja" if lang == "ja" else "")
    out = []
    for fn in sorted(os.listdir(d)):
        if fn.endswith(".json"):
            out.append((fn[:-5], os.path.join(d, fn)))
    return out


def image_url(card, lang):
    """Best image URL for palette extraction. Returns (kind, value) where
    kind is 'local' (repo-relative path) or 'remote' (URL)."""
    if lang == "ja":
        u = card.get("imageSmall") or card.get("imageLarge") or card.get("image")
    else:
        u = card.get("image")
        if u and not u.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
            u = u.rstrip("/") + "/low.png"
    if not u:
        return None
    if u.startswith("/"):
        p = os.path.join(ROOT, u.lstrip("/"))
        return ("local", p) if os.path.exists(p) else None
    if u.startswith("http"):
        return ("remote", u)
    return None


def fetch_remote(url):
    last = None
    for attempt in range(CURL_RETRIES):
        try:
            r = subprocess.run(
                ["curl", "-sSL", "--max-time", str(CURL_TIMEOUT),
                 "--retry", "2", "--retry-delay", "1", url],
                capture_output=True, timeout=CURL_TIMEOUT + 10)
            if r.returncode == 0 and r.stdout[:4] in (
                    b"\x89PNG", b"\xff\xd8\xff", b"RIFF", b"\x1aE\xdf\xa3"):
                # PNG / JPEG / WEBP / (EBML-ish AVIF header check below)
                return r.stdout
            if r.stdout[:12] == b"\x00\x00\x00\x1cftypavif" or \
               (len(r.stdout) > 12 and b"ftypavif" in r.stdout[:32]):
                return r.stdout
            last = "bad payload (%d bytes)" % len(r.stdout)
        except Exception as e:  # noqa: BLE001
            last = str(e)
        time.sleep(1 + attempt)
    return None


def rgb_to_hsl(r, g, b):
    r, g, b = r / 255.0, g / 255.0, b / 255.0
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2.0
    if mx == mn:
        return (0, 0, round(l * 100))
    d = mx - mn
    s = d / (2.0 - mx - mn) if l > 0.5 else d / (mx + mn)
    if mx == r:
        h = ((g - b) / d) % 6
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    return (round(h * 60) % 360, round(s * 100), round(l * 100))


def palette_of(img_bytes):
    from PIL import Image
    im = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    w, h = im.size
    box = (int(w * CROP[0]), int(h * CROP[1]), int(w * CROP[2]), int(h * CROP[3]))
    art = im.crop(box)
    art.thumbnail((72, 72), Image.LANCZOS)
    q = art.quantize(colors=6, method=Image.MEDIANCUT)
    pal = q.getpalette()[:6 * 3]
    counts = sorted(q.getcolors(), reverse=True)
    total = sum(n for n, _ in counts) or 1
    out = []
    for n, idx in counts[:3]:
        r, g, b = pal[idx * 3:idx * 3 + 3]
        hh, ss, ll = rgb_to_hsl(r, g, b)
        out.append([hh, ss, ll, round(n / total * 100)])
    return out or None


def process_card(args):
    key, kind, src, url_hash = args
    try:
        if kind == "local":
            with open(src, "rb") as f:
                data = f.read()
        else:
            data = fetch_remote(src)
            if not data:
                return (key, None)
        pal = palette_of(data)
        if not pal:
            return (key, None)
        return (key, {"u": url_hash, "p": pal})
    except Exception:  # noqa: BLE001
        return (key, None)


def atomic_write(path, obj):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, separators=(",", ":"))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", choices=["en", "ja"], default=None)
    ap.add_argument("--set", default=None, help="only this set id (e.g. sv01, ja-M6a)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    existing = {}
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH) as f:
            existing = json.load(f)
    log("existing palette entries: %d" % len(existing))

    tasks = []
    langs = [args.only] if args.only else ["en", "ja"]
    for lang in langs:
        for set_id, path in set_files(lang):
            app_id = ("ja-" + set_id) if lang == "ja" else set_id
            if args.set and args.set not in (set_id, app_id):
                continue
            try:
                with open(path) as f:
                    snap = json.load(f)
            except Exception as e:  # noqa: BLE001
                log("skip set %s: %s" % (app_id, e))
                continue
            for card in snap.get("cards", []):
                cid = card.get("id")
                if not cid:
                    continue
                key = "%s:%s" % (lang, cid)
                if key in existing and not args.force:
                    continue
                got = image_url(card, lang)
                if not got:
                    continue
                kind, src = got
                uh = hashlib.md5(src.encode()).hexdigest()[:8]
                if key in existing and not args.force and \
                        existing[key].get("u") == uh:
                    continue
                tasks.append((key, kind, src, uh))
                if args.limit and len(tasks) >= args.limit:
                    break
            if args.limit and len(tasks) >= args.limit:
                break
        if args.limit and len(tasks) >= args.limit:
            break

    log("cards to process: %d" % len(tasks))
    if not tasks:
        return

    done = 0
    failed = 0
    lock = threading.Lock()
    t0 = time.time()

    def flush():
        atomic_write(OUT_PATH, existing)

    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for key, val in ex.map(process_card, tasks):
            with lock:
                if val:
                    existing[key] = val
                else:
                    failed += 1
                done += 1
                if done % 250 == 0:
                    flush()
                    el = time.time() - t0
                    log("... %d/%d (failed %d, %.1f/s)" %
                        (done, len(tasks), failed, done / max(el, 0.01)))
    flush()
    el = time.time() - t0
    log("done: %d palettes, %d failed, total entries %d in %.0fs" %
        (done - failed, failed, len(existing), el))


if __name__ == "__main__":
    main()
