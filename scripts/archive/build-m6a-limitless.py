#!/usr/bin/env python3
"""Build the Japanese 30th Celebration set (M6a) from the Limitless TCG
extraction in data/limitless-m6a.json.

Writes data/tcgdex/sets/ja/M6a.json in the app's snapshot schema, inserts
the set at the top of data/tcgdex/sets-ja.json, copies the 30th anniversary
logo, and rebuilds the JA search index.

English names come from the existing JA catalog's nameJa->name mapping,
plus a small override table for brand-new Mega-era cards (each validated
against the English catalog). Rarities are only what Limitless publishes
(10 Double Rare ex cards); everything else stays null — never invented.
Re-runnable: re-extract limitless-m6a.json and run again to pick up new
cards (e.g. the Classic Collection reprints not yet listed).
"""
import json, os, pickle, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "limitless-m6a.json")
SET_OUT = os.path.join(ROOT, "data", "tcgdex", "sets", "ja", "M6a.json")
LIST_PATH = os.path.join(ROOT, "data", "tcgdex", "sets-ja.json")

IMG = "https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpc/M6a/M6a_{n}_R_JP_{s}.png"

# Brand-new cards with no nameJa->EN mapping in our catalog (spellings
# validated against data/tcgdex/index.json on 2026-09-17).
OVERRIDES = {
    "アローラ ナッシー": "Alolan Exeggutor",
    "ホゲータex": "Fuecoco ex",
    "ミュウツーex": "Mewtwo ex",
    "ブラッキー": "Umbreon",
    "イッカネズミ": "Tandemaus",
    "アローラ ニャース": "Alolan Meowth",
    "ガラル ニャース": "Galarian Meowth",
    "ヒスイ ゾロア": "Hisuian Zorua",
    "ヒスイ ゾロアーク": "Hisuian Zoroark",
    "ゲッコウガex": "Greninja ex",
    "ニンフィアex": "Sylveon ex",
    "ジラーチex": "Jirachi ex",
    "ボーマンダex": "Salamence ex",
    "ミュウex": "Mew ex",
    "バルビート": "Volbeat",
    "イルミーゼ": "Illumise",
    "パルキア": "Palkia",
    "ヨワシ": "Wishiwashi",
    "ゼクロム": "Zekrom",
    "モルペコ": "Morpeko",
    "エーフィ": "Espeon",
    "アンノーン": "Unown",
    "シャンデラ": "Chandelure",
    "コレクレー": "Gimmighoul",
    "ルカリオ": "Lucario",
    "ガマゲロゲ": "Seismitoad",
    "ルガルガン": "Lycanroc",
    "ズルッグ": "Scraggy",
    "イベルタル": "Yveltal",
    "ディアルガ": "Dialga",
    "ザマゼンタ": "Zamazenta",
    "サーフゴー": "Gholdengo",
    "ププリン": "Igglybuff",
}
ENERGY_EN = {"G": "Grass", "R": "Fire", "W": "Water", "L": "Lightning",
             "P": "Psychic", "F": "Fighting", "D": "Darkness", "M": "Metal"}

def load_name_map():
    from collections import Counter
    import glob
    mp = {}
    for f in glob.glob(os.path.join(ROOT, "data", "tcgdex", "sets", "ja", "*.json")):
        if os.path.basename(f) == "M6a.json":
            continue
        d = json.load(open(f, encoding="utf-8"))
        for c in d.get("cards", []):
            ja = (c.get("nameJa") or "").strip()
            en = (c.get("name") or "").strip()
            en = re.sub(r"\s+-\s+\S+/\S+$", "", en).strip()
            if ja and en:
                mp.setdefault(ja, Counter())[en] += 1
    return {k: v.most_common(1)[0][0] for k, v in mp.items()}

def main():
    src = json.load(open(SRC, encoding="utf-8"))
    name_map = load_name_map()
    cards, missing = [], []
    for e in src["cards"]:
        n, ja = e["n"], e["ja"]
        lid = n.zfill(3) if n.isdigit() else n
        if n in ENERGY_EN:
            en = f"Basic {ENERGY_EN[n]} Energy"
            cat = "Energy"
        else:
            en = OVERRIDES.get(ja) or name_map.get(ja)
            cat = "Trainer" if n.isdigit() and int(n) > 100 else "Pokemon"
        if not en:
            missing.append((n, ja))
            en = ja  # fall back to the Japanese name rather than dropping the card
        r = e.get("r")
        cards.append({
            "id": f"M6a-{lid}",
            "localId": lid,
            "name": en,
            "nameJa": ja,
            "rarity": "Double rare" if r == "Double Rare" else None,
            "illustrator": None,
            "image": None,
            "imageSmall": IMG.format(n=n, s="SM"),
            "imageLarge": IMG.format(n=n, s="LG"),
            "category": cat,
            "types": [],
            "hp": None,
            "variants_detailed": None,
            "pricing": None,
        })
    if missing:
        print("WARN: no English name for: " + ", ".join(f"{n}={ja}" for n, ja in missing),
              file=sys.stderr)

    logo_src = os.path.join(ROOT, "data", "tcgdex", "set-logos", "30th.png")
    logo_dst = os.path.join(ROOT, "data", "tcgdex", "set-logos", "ja", "M6a.png")
    if os.path.exists(logo_src) and not os.path.exists(logo_dst):
        shutil.copyfile(logo_src, logo_dst)

    out = {
        "generated_at": src.get("extracted_at", ""),
        "source": "limitlesstcg",
        "source_url": src.get("extracted_from"),
        "set": {
            "id": "M6a",
            "name": "30th Celebration",
            "nameJa": src.get("set_name_ja") or "30th セレブレーション",
            "series": "ポケモンカードゲーム MEGA",
            "releaseDate": "2026-09-16",
            "logo": "/data/tcgdex/set-logos/ja/M6a.png" if os.path.exists(logo_dst) else None,
            "symbol": None,
            "printedTotal": len(cards),
            "total": len(cards),
            "lang": "ja",
        },
        "cards": cards,
    }
    tmp = SET_OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, SET_OUT)

    # Insert at the top of the JA browse list (newest set).
    sets = json.load(open(LIST_PATH, encoding="utf-8"))
    sets = [s for s in sets if s.get("id") != "M6a"]
    entry = {
        "id": "M6a",
        "name": "30th Celebration",
        "logo": out["set"]["logo"],
        "symbol": None,
        "printedTotal": len(cards),
        "total": len(cards),
        "series": "Mega Evolution",
        "eraRank": 0,
        "setRank": 0,
        "lang": "ja",
        "nameJa": out["set"]["nameJa"],
    }
    for s in sets:
        s["setRank"] = s.get("setRank", 0) + 1
    sets.insert(0, entry)
    tmp = LIST_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(sets, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, LIST_PATH)

    # Rebuild the JA search index so the new cards are findable.
    subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "build-ja-search-index.py")],
                   check=True)
    print(f"M6a: {len(cards)} cards written; browse list now {len(sets)} sets")

if __name__ == "__main__":
    main()
