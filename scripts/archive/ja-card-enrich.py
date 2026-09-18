#!/usr/bin/env python3
"""Enrich Japanese set snapshots with English card names and card images.

TCGdex has no Japanese card images and Japanese-only card names. This script
uses Bulbapedia (which documents every Japanese set with English card names
and hosts card scans on Bulbagarden Archives):

  1. Fetch each set's Bulbapedia article wikitext via the MediaWiki API.
  2. Parse {{Setlist/entry}} / {{Setlist/nmentry}} / {{halfdecklist/entry}}
     rows -> card number + English name, scoped to the set's own section.
  3. Resolve each card's page (following redirects to the English print when one
     exists) and read the infobox |image= file.
  4. Resolve direct thumbnail (400px) + full image URLs in batches.
  5. Write data/tcgdex/ja-cards/<id>.json and merge into the per-set snapshot
     data/tcgdex/sets/ja/<id>.json when present:
       name     -> English name (community/official, never translated)
       nameJa   -> original Japanese name
       imageSmall / imageLarge -> Bulbagarden Archives URLs

Caveat: when Bulbapedia redirects a Japanese set/card to its English print,
names and images come from the English print. Images are therefore NOT
guaranteed to be scans of Japanese-language cards.

Fetching uses curl with retries: urllib flakily truncates Bulbapedia responses
with IncompleteRead (same failure mode documented for TCGdex in AGENTS.md).

Usage:
  python3 scripts/ja-card-enrich.py [--force] [--set <id>] [--limit N]

Incremental: sets already enriched are skipped unless --force (a skipped set
still gets a merge pass into its snapshot).
Polite: ~1.2s between API requests.
"""
import json, os, re, subprocess, sys, time, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETS_JA = os.path.join(ROOT, "data", "tcgdex", "sets-ja.json")
JA_SET_DIR = os.path.join(ROOT, "data", "tcgdex", "sets", "ja")
OUT_DIR = os.path.join(ROOT, "data", "tcgdex", "ja-cards")
LOGO_DIR = os.path.join(ROOT, "data", "tcgdex", "set-logos", "ja")
API = "https://bulbapedia.bulbagarden.net/w/api.php"
UA = "VaultDex/1.0 (personal collection tracker)"
SLEEP = 1.2

# Bulbapedia article titles that don't follow "<name> (TCG)".
# (Research notes: SM6b's catalog name contains an HTML entity
# "Champion&#039;s Road"; PMCG3 was wrongly mapped to "Fossil (TCG)";
# "Super-Burst Impact" needs its hyphen; SM1p is the Enhanced Expansion
# Pack; SM2p/sm2+ is "Facing a New Trial". MC (Starter Decks 100) is
# intentionally unmapped: Bulbapedia's 422-row setlist semantically
# misaligns with TCGdex's 774-card set, so it's skipped.)
ARTICLE_OVERRIDES = {
    "M-P": "M-P Promotional cards (TCG)",
    "SV-P": "SV-P Promotional cards (TCG)",
    "M2a": "MEGA Dream ex (TCG)",
    "SM0": "Pikachu's New Friends (TCG)",
    "sm2+": "Facing a New Trial (TCG)",
    "SM2p": "Facing a New Trial (TCG)",
    "SM4A": "Ultradimensional Beasts (TCG)",
    "SM6b": "Champion Road (TCG)",
    "SM8": "Super-Burst Impact (TCG)",
    "SM9b": "Full Metal Wall (TCG)",
    "SM1p": "Enhanced Expansion Pack Sun & Moon (TCG)",
    "XY8b": "Red Flash (TCG)",
    "XY9": "Rage of the Broken Heavens (TCG)",
    "CP4": "Premium Champion Pack (TCG)",
    "CP6": "Evolutions (TCG)",
    "CP1": "Double Crisis (TCG)",
    "VS1": "Pokémon VS (TCG)",
    "SV11W": "Black Bolt/White Flare (TCG)",
    "SV11B": "Black Bolt/White Flare (TCG)",
    "SVK": "Stellar Miracle Deck Build Box (TCG)",
    "SVLS": "Stellar Tera Type Starter Sets (TCG)",
    "SVLN": "Stellar Tera Type Starter Sets (TCG)",
    "LL": "Lost Link (TCG)",
    "PMCG3": "Mystery of the Fossils (TCG)",
}

# Setlist section titles that differ from the article-derived Japanese set name.
SECTION_OVERRIDES = {
    "SM1p": "Sun & Moon",
    "CP6": "Expansion Pack 20th Anniversary",
    "CP1": "Magma Gang VS Aqua Gang: Double Crisis",
    "VS1": "Pokémon Card★VS",
    "SVLS": "Stellar Tera Type Starter Set Ceruledge ex",
    "SVLN": "Stellar Tera Type Starter Set Sylveon ex",
    "SVK": "Stellar Miracle Deck Build Box",
    "SV11W": "White Flare",
    "SV11B": "Black Bolt",
}

HEADER_RE = re.compile(
    r"\{\{(?:Setlist/(?:nm)?header|halfdecklist/header)\|title=([^|}]+)")
ROW_RE = re.compile(
    r"\{\{(?:Setlist/(?:nmentry|entry)|halfdecklist/entry)\|([^|}]+)\|")
TCGID_RE = re.compile(
    r"\{\{TCG ID\|([^|}]*)\|([^|}]*)\|([^|}]*?)(?:\|[^}]*)?\}\}")
LINK_RE = re.compile(r"\[\[([^|\]#]+)(?:\|[^\]]*)?\]\]")


def curl_get(url, retries=5):
    """GET a URL via curl with retries (urllib truncates Bulbapedia)."""
    for attempt in range(retries):
        try:
            p = subprocess.run(
                ["curl", "-sS", "--max-time", "60", "-A", UA, url],
                capture_output=True, timeout=90)
            if p.returncode != 0:
                raise OSError("curl exit %d: %s"
                              % (p.returncode, p.stderr.decode()[:200]))
            return p.stdout.decode("utf-8")
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError("GET failed %s: %r" % (url, e))
    raise RuntimeError("GET failed: " + url)


def api(params):
    q = urllib.parse.urlencode(params)
    data = json.loads(curl_get(API + "?" + q))
    time.sleep(SLEEP)
    return data


def get_wikitext(title):
    d = api({"action": "parse", "page": title, "prop": "wikitext",
             "redirects": "1", "format": "json", "formatversion": "2"})
    p = d.get("parse")
    if not p:
        return None, None
    return p["title"], p["wikitext"]


def parse_setlist(wt):
    """Return list of dicts: local (str|None), tcg_set, name_en, page, section.

    Rows whose number field is "None" (common in old Japanese setlists) get
    local=None; callers assign positional numbers (rows are in card order).
    """
    out = []
    section = None
    for line in wt.splitlines():
        mh = HEADER_RE.search(line)
        if mh:
            section = mh.group(1).strip()
            continue
        if "entry" not in line:
            continue
        m = ROW_RE.search(line)
        if not m:
            continue
        numfield = m.group(1).strip()
        local = numfield.split("/")[0].strip()
        if not local or local.lower() == "none":
            local = None
        rest = line[m.end():]
        tcg_set = name_en = page = None
        t = TCGID_RE.search(rest)
        if t:
            tcg_set, name_en = t.group(1).strip(), t.group(2).strip()
            tcg_num = t.group(3).strip()
            if tcg_num and tcg_num.lower() != "none":
                page = "%s (%s %s)" % (name_en, tcg_set, tcg_num)
            else:
                page = "%s (%s)" % (name_en, tcg_set)
        else:
            lm = LINK_RE.search(rest)
            if lm:
                page = lm.group(1).strip()
                # "Sylveon ex (Stellar Tera Type Starter Set 5)" -> "Sylveon ex"
                # (page title is more precise than the display label)
                name_en = re.sub(r"\s*\([^()]*\)\s*$", "", page).strip()
        if not name_en:
            continue
        name_en = re.sub(r"\{\{[^}]*\}\}", "", name_en).strip()
        if not name_en:
            continue
        out.append({"local": local, "tcg_set": tcg_set, "name_en": name_en,
                    "page": page, "section": section})
    return out


def select_rows(rows, sid, ja_name):
    """Keep only rows belonging to this Japanese set.

    Bulbapedia often documents a Japanese set inside its English set's
    article (or alongside sibling Japanese subsets); without section
    filtering, same-numbered cards from other sets would collide.
    Returns (rows, mode).
    """
    want_section = SECTION_OVERRIDES.get(sid, ja_name)
    sel = [r for r in rows if r["section"] == want_section]
    mode = "section"
    if not sel:
        sel = [r for r in rows if r["tcg_set"] == ja_name]
        mode = "tcg_set"
    if not sel:
        sel = [r for r in rows if r["section"] and ja_name in r["section"]]
        mode = "section-contains"
    if not sel and not any(r["section"] for r in rows):
        sel = rows
        mode = "all(no-sections)"
    # positional numbers for "None"-numbered old setlists (card order)
    for i, r in enumerate(sel):
        if r["local"] is None:
            r["local"] = str(i + 1)
    return sel, mode


def batch_card_images(cards):
    """cards: list of (key, page title). Returns {key: filename}."""
    res = {}
    for i in range(0, len(cards), 50):
        chunk = cards[i:i + 50]
        d = api({"action": "query", "prop": "revisions", "rvprop": "content",
                 "rvslots": "main", "titles": "|".join(t for _, t in chunk),
                 "redirects": "1", "format": "json", "formatversion": "2"})
        pages = {}
        redir = {r["from"]: r["to"] for r in d["query"].get("redirects", [])}
        for p in d["query"]["pages"]:
            pages[p["title"]] = p
        for key, title in chunk:
            if not title:
                continue
            pg = pages.get(redir.get(title, title)) or pages.get(title)
            if not pg:
                continue
            revs = pg.get("revisions") or []
            wt = (revs[0].get("slots", {}).get("main", {}).get("content", "")
                  if revs else "")
            m = re.search(r"^\|image\s*=\s*([^|\n<]+)", wt, re.M)
            if m:
                res[key] = m.group(1).strip()
    return res


def batch_image_urls(files):
    """files: list of (key, filename). Returns {key: (thumb, full)}."""
    res = {}
    for i in range(0, len(files), 50):
        chunk = files[i:i + 50]
        d = api({"action": "query", "prop": "imageinfo", "iiprop": "url",
                 "iiurlwidth": "400",
                 "titles": "|".join("File:" + f for _, f in chunk),
                 "format": "json", "formatversion": "2"})
        info = {}
        for p in d["query"]["pages"]:
            ii = (p.get("imageinfo") or [None])[0]
            if ii:
                info[p["title"][5:]] = (ii.get("thumburl"), ii.get("url"))
        for key, f in chunk:
            if f in info and info[f][0]:
                res[key] = info[f]
    return res


def load_snapshot(set_id):
    p = os.path.join(JA_SET_DIR, set_id + ".json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f), p
    return None, None


def merge_snapshot(sid):
    """Overlay ja-cards/<sid>.json into sets/ja/<sid>.json if present."""
    enrich_path = os.path.join(OUT_DIR, sid + ".json")
    if not os.path.exists(enrich_path):
        return 0
    with open(enrich_path, encoding="utf-8") as f:
        enrich = json.load(f)
    snap, spath = load_snapshot(sid)
    if not snap:
        return 0
    by_local = {c.get("localId"): c for c in snap.get("cards", [])}
    n = 0
    for local, e in enrich.items():
        c = by_local.get(local)
        if not c:
            c = by_local.get(local.zfill(3)) or by_local.get(local.lstrip("0") or "0")
        if not c or c.get("imageSmall"):
            continue
        if "nameJa" not in c:
            c["nameJa"] = c.get("name")
        c["name"] = e["name_en"]
        if e.get("img_small"):
            c["imageSmall"] = e["img_small"]
            c["imageLarge"] = e["img_large"]
            n += 1
    if n:
        with open(spath, "w", encoding="utf-8") as f:
            json.dump(snap, f, ensure_ascii=False)
    return n


def enrich_set(entry, force=False):
    sid = entry["id"]
    out_path = os.path.join(OUT_DIR, sid + ".json")
    if os.path.exists(out_path) and not force:
        n = merge_snapshot(sid)
        print(f"[{sid}] already enriched, merge pass: {n} images")
        return "skipped"
    name = entry.get("name") or ""
    title = ARTICLE_OVERRIDES.get(sid, name + " (TCG)")
    ja_name = title[:-6] if title.endswith(" (TCG)") else title
    art_title, wt = get_wikitext(title)
    if not wt:
        print(f"[{sid}] no Bulbapedia article for '{title}'")
        return "no-article"
    rows = parse_setlist(wt)
    if not rows:
        print(f"[{sid}] no setlist rows in '{art_title}'")
        return "no-rows"
    sel, mode = select_rows(rows, sid, ja_name)
    if not sel:
        print(f"[{sid}] no rows for section '{SECTION_OVERRIDES.get(sid, ja_name)}'"
              f" in '{art_title}' ({len(rows)} rows parsed)")
        return "no-rows"
    print(f"[{sid}] '{art_title}' [{mode}]: {len(sel)} cards")
    # resolve card pages -> image files
    want = [(r["local"], r["page"]) for r in sel]
    images = batch_card_images(want)
    print(f"[{sid}] resolved {len(images)}/{len(want)} card images")
    urls = batch_image_urls([(k, f) for k, f in images.items()])
    print(f"[{sid}] resolved {len(urls)}/{len(images)} image urls")
    enrich = {}
    for r in sel:
        local = r["local"]
        e = {"name_en": r["name_en"]}
        if local in urls:
            e["img_small"], e["img_large"] = urls[local]
        # keep first-seen on duplicate locals (same card, repeated row)
        if local not in enrich:
            enrich[local] = e
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(enrich, f, ensure_ascii=False)
    # merge into per-set snapshot when present
    n = merge_snapshot(sid)
    if n:
        print(f"[{sid}] merged into snapshot ({n} images)")
    # bonus: set logo from infobox when we have none
    logo_path = os.path.join(LOGO_DIR, sid + ".png")
    if not os.path.exists(logo_path):
        m = re.search(r"^\|setlogo\s*=\s*([^|\n<]+)", wt, re.M)
        if m:
            fn = m.group(1).strip()
            d = api({"action": "query", "prop": "imageinfo", "iiprop": "url",
                     "titles": "File:" + fn, "format": "json", "formatversion": "2"})
            for p in d["query"]["pages"]:
                ii = (p.get("imageinfo") or [None])[0]
                if ii and ii.get("url"):
                    try:
                        p2 = subprocess.run(
                            ["curl", "-sfL", "--max-time", "60", "-A", UA,
                             "-o", logo_path, ii["url"]],
                            capture_output=True, timeout=90)
                        if p2.returncode == 0 and os.path.getsize(logo_path) > 0:
                            print(f"[{sid}] downloaded set logo {fn}")
                        else:
                            os.remove(logo_path)
                    except Exception as ex:
                        print(f"[{sid}] logo download failed: {ex}")
    return "ok"


def main():
    args = sys.argv[1:]
    force = "--force" in args
    only = args[args.index("--set") + 1] if "--set" in args else None
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    with open(SETS_JA, encoding="utf-8") as f:
        sets = json.load(f)
    if only:
        sets = [s for s in sets if s["id"] == only]
    if limit:
        sets = sets[:limit]
    stats = {}
    for s in sets:
        try:
            st = enrich_set(s, force)
        except Exception as ex:
            print(f"[{s['id']}] ERROR: {ex}")
            st = "error"
        stats[st] = stats.get(st, 0) + 1
    print("done:", stats)


if __name__ == "__main__":
    main()
