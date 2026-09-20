#!/usr/bin/env python3
"""Build data/artist-cards.json: illustrator -> ["lang:cardId", ...].

Binder Studio's artist-spotlight recipe needs "every card by X" without
scanning 300+ set files at runtime. Rebuild after catalog changes
(weekly refresh step, alongside species-printings / artist-stats).
"""
import json
import os
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "tcgdex")
OUT = os.path.join(ROOT, "data", "artist-cards.json")


def main():
    index = {}
    for lang, sub in (("en", ""), ("ja", "ja")):
        d = os.path.join(DATA, "sets", sub)
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".json"):
                continue
            with open(os.path.join(d, fn)) as f:
                snap = json.load(f)
            for card in snap.get("cards", []):
                artist = (card.get("illustrator") or "").strip()
                cid = card.get("id")
                if not artist or not cid:
                    continue
                key = "%s:%s" % (lang, cid)
                index.setdefault(artist, [])
                if key not in index[artist]:
                    index[artist].append(key)
    # Most-prolific first is handy for "top artists" UIs; keep insertion
    # (set-file) order inside each artist for determinism.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(index, f, separators=(",", ":"))
    os.replace(tmp, OUT)
    print("artists: %d, cards indexed: %d" %
          (len(index), sum(len(v) for v in index.values())))


if __name__ == "__main__":
    main()
