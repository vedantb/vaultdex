#!/usr/bin/env python3
"""Japanese card enrichment from PkmnPrices (Pro API).

For each of our 188 Japanese sets (184 from TCGdex plus 4 hand-maintained
promo sets from scripts/ja-custom-sets.json), matches the PkmnPrices set
(language=Japanese), downloads its cards, and merges into our per-set
snapshots at data/tcgdex/sets/ja/<id>.json:

  - imageSmall / imageLarge = PkmnPrices image_url  (PkmnPrices wins)
  - name: if the current name contains non-ASCII (i.e. still Japanese),
    replace it with the cleaned PkmnPrices English name.
  - rarity: cards TCGdex mislabeled "Mega Hyper Rare" are corrected from the
    PkmnPrices rarity (Art Rare -> Illustration rare, Special Art Rare ->
    Special illustration rare, Super Rare -> Ultra Rare).
  - nameJa is NEVER modified.

Everything from the API is cached under data/pkmn-cache/:
  sets-ja.json               full Japanese set list (one-time)
  cards-<ppSetId>.json       raw card payloads per PkmnPrices set
  credit-ledger.json         { "YYYY-MM-DD": credits_spent }
  manifest.json              per-set match/merge report

Credit rules: 1 credit per item returned. Hard cap 16,000 credits/day
(leaves headroom for the app's price refreshes). On HTTP 429 we back off
and retry twice (60s, 120s), then stop. Polite pacing: >=0.55s between
requests (the Vercel proxy allows 120 req/min per IP).

Usage:
  python3 scripts/ja-pkmn-enrich.py [--force] [--resume] [--match-only]
                                   [--limit N] [--only <id>[,<id>...]]
  --force      re-fetch cached API responses
  --resume     (default) skip anything already cached/done
  --match-only fetch set list only, print set matching + credit estimate
  --limit N    process at most N sets (newest-first)
  --only       comma-separated list of our set ids to process

The PkmnPrices key lives server-side; all calls go through the
production proxy. This script never handles the raw key.
"""
import fcntl
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETS_JA = os.path.join(ROOT, "data", "tcgdex", "sets-ja.json")
JA_DIR = os.path.join(ROOT, "data", "tcgdex", "sets", "ja")
CACHE = os.path.join(ROOT, "data", "pkmn-cache")
PROXY = "https://vaultdex-three.vercel.app/api/pkmnprices"

# Shared secret for the Vercel proxy's caller check (api/pkmnprices.js).
# The proxy only serves requests carrying this as the x-vaultdex-key header
# (browser traffic is authorized by Referer instead). The secret lives OUTSIDE
# the repo at ~/workspace/.secrets/vaultdex-proxy-key (chmod 600) so it can
# never be committed; VAULTDEX_PROXY_KEY env var takes precedence.
def _proxy_secret():
    v = os.environ.get("VAULTDEX_PROXY_KEY")
    if v:
        return v.strip()
    try:
        with open(os.path.expanduser("~/workspace/.secrets/vaultdex-proxy-key")) as f:
            return f.read().strip()
    except OSError:
        return ""

PROXY_KEY = _proxy_secret()

DAILY_CAP = 16000

# Rarity correction: TCGdex's Japanese catalog bulk-mislabeled many cards as
# "Mega Hyper Rare" (e.g. nearly every Art Rare / Special Art Rare / Super
# Rare in M6 "Storm Emeralda"). PkmnPrices carries the correct per-card
# rarity, so during the merge we translate its labels to TCGdex-style ones.
# Only unambiguous mislabels are mapped; anything else (e.g. PkmnPrices
# "Mega Ultra Rare" / "Ultra Rare" for gold chase cards) is left untouched.
PP_RARITY_FIX = {
    "Art Rare": "Illustration rare",
    "Special Art Rare": "Special illustration rare",
    "Super Rare": "Ultra Rare",
}
# Seconds between proxy requests. The Vercel proxy (api/pkmnprices.js)
# allows 120 req/min per IP (2/s); ~109/min keeps us safely under it.
MIN_INTERVAL = 0.55

# Manual set-id fixes: our id -> PkmnPrices set id. Used when the "<ID>:"
# prefix convention doesn't hold (no colon, different naming, or ambiguity).
# Also used for the hand-maintained promo sets in ja-custom-sets.json, to
# pin the match explicitly rather than relying on prefix search.
OVERRIDES = {
    "S-P": 891,     # "S-P: Sword & Shield Promos"
    "SM-P": 1074,   # "SM-P: Sun & Moon Promos"
    "XY-P": 1073,   # "XY-P: XY Promos"
    "BW-P": 783,    # "BW-P Promotional cards"
    "M-P": 1017,    # "M-P Promotional Cards"
    "SV-P": 1069,   # "SV-P Promotional Cards"
    "SVK": 876,     # "SV: Stellar Miracle Deck Build Box"
    "SVLS": 670,    # "SV: Ceruledge ex Stellar Tera Type Starter Set"
    "SVLN": 1015,   # "SV: Sylveon ex Stellar Tera Type Starter Set"
    "SM1+": 871,    # "sm1+: Enhanced Expansion Pack Sun & Moon" (not 696)
    "SM2p": 700,    # "SM2+: Facing a New Trial" ~= "Let's Face New Trials"
    "sm2+": 700,    # tentative: same pp set; card numbers will confirm
    "SM3+": 764,    # same pp set as SM3p; numbers will confirm
    "SM3p": 764,    # "SM3+: Shining Legends"
    "SM4+": 1070,   # same pp set as SM4p; numbers will confirm
    "SM4p": 1070,   # "SM4+: GX Battle Boost"
    "SM5+": 878,    # same pp set as SM5p; numbers will confirm
    "SM5p": 878,    # "SM5+: Ultra Force"
    "SMP2": 666,    # "smP2: Great Detective Pikachu"
    "SM12a": 971,   # "SM12a: TAG TEAM GX: Tag All Stars"
    "L2": 1067,     # "L2: Revival Legends" (not the constructed decks)
    "XY1a": 1038,   # "XY-Bx: Collection X"
    "XY1b": 750,    # "XY-By: Collection Y"
    "XY5a": 763,    # "XY5-Bg: Gaia Volcano"
    "XY5b": 833,    # "XY5-Bt: Tidal Storm"
    "XY8a": 685,    # "XY8-Bb: Blue Shock"
    "XY8b": 865,    # "XY8-Br: Red Flash" (name differs; numbers will confirm)
    "XY11a": 805,   # "XY11-Bb: Fever-Burst Fighter"
    "XY11b": 870,   # "XY11-Br: Cruel Traitor"
    "L1a": 832,     # "L1: HeartGold Collection"
    "L1b": 931,     # "L1: SoulSilver Collection"
    "PCG1": 826,    # "Flight of Legends"
    "PCG2": 946,    # "Clash of the Blue Sky"
    "PCG3": 860,    # "Rocket Gang Strikes Back"
    "PCG4": 681,    # "Golden Sky, Silvery Ocean"
    "PCG5": 749,    # "Mirage Forest"
    "PCG6": 706,    # "Holon Research Tower"
    "PCG7": 754,    # "Holon Phantom"
    "PCG8": 1011,   # "Miracle Crystal"
    "PCG9": 679,    # "Offense and Defense of the Furthest Ends"
    "PCG10": 857,   # "World Champions Pack"
    "ADV1": 892,    # "ADV Expansion Pack"
    "ADV2": 935,    # "Miracle of the Desert"
    "ADV3": 964,    # "Rulers of the Heavens"
    "ADV4": 940,    # "Magma VS Aqua: Two Ambitions"
    "ADV5": 1018,   # "Undone Seal"
    "E1": 790,      # "Base Expansion Pack"
    "E2": 853,      # "The Town on No Map"
    "E3": 1050,     # "Wind from the Sea"
    "E4": 1041,     # "Split Earth"
    "E5": 1053,     # "Mysterious Mountains"
    "web1": 841,    # "Pokemon Web"
    "VS1": 1024,    # "Pokemon VS"
    "neo1": 695,    # "Gold, Silver, to a New World..."
    "neo2": 959,    # "Crossing the Ruins..."
    "neo3": 691,    # "Awakening Legends"
    "neo4": 770,    # "Darkness, and to Light..."
    "PMCG1": 809,   # "Expansion Pack"
    "PMCG2": 811,   # "Pokemon Jungle"
    "PMCG3": 698,   # "Mystery of the Fossils"
    "PMCG4": 684,   # "Rocket Gang"
    "PMCG5": 801,   # "Leaders' Stadium"
    "PMCG6": 731,   # "Challenge from the Darkness"
    # All CS* ids are the 101-card "Triplet Beat" collection sheet.
    "CS1a": 1054, "CS1b": 1054, "CS2a": 1054, "CS2b": 1054,
    "CS3a": 1054, "CS3b": 1054, "CS3.5": 1054, "CS1.5": 1054,
    "CS4": 1054, "CS2.5": 1054, "CS4a": 1054, "CS4b": 1054,
    "CS4Da": 1054, "CS3D": 1054, "CSA": 1054,
}
# NOTE: MC ("Starter Decks 100 Battle Collection") has no PkmnPrices
# equivalent and is intentionally left unmatched.

_last_req = 0.0


def utc_today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def ledger_path():
    return os.path.join(CACHE, "credit-ledger.json")


def load_ledger():
    p = ledger_path()
    if os.path.isfile(p):
        try:
            return json.load(open(p))
        except Exception:
            return {}
    return {}


def spent_today(ledger):
    return int(ledger.get(utc_today(), 0))


def atomic_write_json(path, obj, **kwargs):
    """Write JSON atomically (tmp file + os.replace) so a crash or OOM
    mid-write can never leave a truncated file in place."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, **kwargs)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def add_spend(ledger, n):
    """Record n credits spent today. Uses a lockfile-guarded
    read-modify-write (re-reading the ledger under the lock) so overlapping
    runs can't lose counts against the paid 20,000/day Pro cap, and writes
    the ledger atomically."""
    p = ledger_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + ".lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            try:
                disk = json.load(open(p)) if os.path.isfile(p) else {}
            except Exception:
                disk = {}
            today = utc_today()
            ledger[today] = max(int(disk.get(today, 0)),
                                int(ledger.get(today, 0))) + n
            atomic_write_json(p, ledger, indent=1)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def pace():
    global _last_req
    dt = time.time() - _last_req
    if dt < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - dt)
    _last_req = time.time()


MAX_429_TRIES = 2
BACKOFF_429 = (60, 120)  # seconds between 429 retries


def proxy_get(path, params, ledger):
    """GET through the Vercel proxy. Returns parsed JSON. Counts credits.

    A 403 means the proxy rejected our caller key: permanent, so fail fast
    instead of walking all ~184 sets fetching nothing. On 429 we back off
    and retry twice, then stop cleanly (exit 3)."""
    if spent_today(ledger) >= DAILY_CAP:
        print("BUDGET_EXHAUSTED: daily cap of %d credits reached." % DAILY_CAP)
        sys.exit(2)
    qs = {"path": path}
    qs.update(params)
    url = PROXY + "?" + urllib.parse.urlencode(qs)
    req = urllib.request.Request(url, headers={
        "User-Agent": "VaultDex-ja-enrich/1.0",
        "x-vaultdex-key": PROXY_KEY,
    })
    body = None
    for attempt in range(MAX_429_TRIES + 1):
        pace()
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                body = resp.read().decode("utf-8")
            break
        except urllib.error.HTTPError as e:
            if e.code == 403:
                print("PROXY 403 FORBIDDEN: the Vercel proxy rejected our "
                      "caller key (no request will succeed). Check that "
                      "PROXY_SHARED_SECRET in Vercel matches "
                      "~/workspace/.secrets/vaultdex-proxy-key (or the "
                      "VAULTDEX_PROXY_KEY env var), then re-run.",
                      file=sys.stderr)
                sys.exit(4)
            if e.code == 429:
                if attempt < MAX_429_TRIES:
                    wait = BACKOFF_429[attempt]
                    print("HTTP 429 — backing off %ds (attempt %d/%d)." %
                          (wait, attempt + 1, MAX_429_TRIES + 1),
                          file=sys.stderr)
                    time.sleep(wait)
                    continue
                print("RATE LIMITED (HTTP 429) after %d retries — stopping." %
                      MAX_429_TRIES)
                sys.exit(3)
            raise
    data = json.loads(body)
    items = data.get("data") if isinstance(data, dict) else data
    n = len(items) if isinstance(items, list) else 0
    add_spend(ledger, n)
    return data


def fetch_all_pages(path, params, ledger, label):
    """Follow pagination; return the concatenated data list."""
    params = dict(params)
    params["page"] = 1
    first = proxy_get(path, params, ledger)
    items = list(first.get("data", []))
    pag = first.get("pagination", {}) or {}
    total_pages = int(pag.get("total_pages") or 1)
    for page in range(2, total_pages + 1):
        params["page"] = page
        d = proxy_get(path, params, ledger)
        items.extend(d.get("data", []))
        print("  %s: page %d/%d (%d items)" % (label, page, total_pages, len(items)),
              file=sys.stderr)
    return items


def get_pp_sets(ledger, force):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, "sets-ja.json")
    if os.path.isfile(p) and not force:
        try:
            return json.load(open(p))
        except Exception as e:
            # Truncated/corrupt cache (see issue #2): treat as cache-miss
            # and refetch rather than crashing the whole weekly run.
            print("Corrupt cache %s (%r) — refetching." % (p, e),
                  file=sys.stderr)
    print("Fetching PkmnPrices Japanese set list...", file=sys.stderr)
    sets = fetch_all_pages("/v1/sets", {"language": "Japanese"}, ledger, "sets")
    atomic_write_json(p, sets, indent=1)
    print("Cached %d PkmnPrices sets." % len(sets), file=sys.stderr)
    return sets


def norm_num(s):
    """'001' -> '1', '092' -> '92'. Keeps non-numeric tails intact."""
    s = str(s or "").strip()
    s = s.split("/")[0]  # just in case a "092/083" slips into a number field
    m = re.match(r"^0*(\d+)(.*)$", s)
    if m:
        return m.group(1) + m.group(2)
    return s


def clean_name(name):
    """Strip PkmnPrices' ' - 092/083' / ' - 227/S-P' / ' - SM-P' suffixes
    to get the clean English name."""
    s = str(name or "").strip()
    s = re.sub(r"\s*-\s*\d+/\S+\s*$", "", s)
    s = re.sub(r"\s*-\s*[A-Z]+-P(\s+\(.*\))?\s*$",
               lambda m: m.group(1) or "", s)
    return s.strip()


def has_non_ascii(s):
    return any(ord(c) > 127 for c in str(s or ""))


def match_sets(our_sets, pp_sets):
    """Return (matches, unmatched, warnings).

    matches: list of (our_set, pp_set, warning_or_None)
    """
    by_prefix = {}
    for ps in pp_sets:
        nm = str(ps.get("name") or "")
        if ":" in nm:
            prefix = nm.split(":", 1)[0].strip().lower()
            by_prefix.setdefault(prefix, []).append(ps)

    matches, unmatched, warnings = [], [], []
    for s in our_sets:
        oid = s["id"]
        pp = None
        if oid in OVERRIDES:
            want = OVERRIDES[oid]
            pp = next((x for x in pp_sets if x.get("id") == want), None)
            if pp is None:
                warnings.append("%s: override target pp set %s not found" %
                                (oid, want))
        else:
            cands = by_prefix.get(oid.lower(), [])
            if cands:
                # Prefer the candidate whose full name contains our set name.
                ours_nm = str(s.get("name") or "").lower()
                ranked = sorted(
                    cands,
                    key=lambda p: (0 if ours_nm and ours_nm in
                                   str(p.get("name") or "").lower() else 1,
                                   p.get("id") or 0))
                pp = ranked[0]
                if len(cands) > 1:
                    warnings.append(
                        "%s: %d PkmnPrices sets share prefix, took '%s'" %
                        (oid, len(cands), pp.get("name")))
        if pp is None:
            unmatched.append(oid)
            continue
        # sanity check on card counts
        warn = None
        ours = s.get("total") or s.get("printedTotal")
        theirs = pp.get("card_count")
        if ours and theirs:
            drift = abs(int(theirs) - int(ours))
            if drift > max(10, int(0.2 * int(ours))):
                warn = ("card count drift: ours=%s pp=%s" % (ours, theirs))
                warnings.append("%s: %s" % (oid, warn))
        matches.append((s, pp, warn))
    return matches, unmatched, warnings


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--resume", action="store_true", default=True)
    ap.add_argument("--match-only", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    ledger = load_ledger()
    print("Credits spent today so far: %d / %d" % (spent_today(ledger), DAILY_CAP))

    our_sets = json.load(open(SETS_JA))  # newest-first order
    if args.only:
        want = set(x.strip() for x in args.only.split(",") if x.strip())
        our_sets = [s for s in our_sets if s["id"] in want]
        if not our_sets:
            print("No matching set ids for --only filter.")
            return

    pp_sets = get_pp_sets(ledger, args.force)
    matches, unmatched, warnings = match_sets(our_sets, pp_sets)

    print("Set matching: %d matched, %d unmatched" % (len(matches), len(unmatched)))
    for w in warnings:
        print("  WARN: " + w)
    if unmatched:
        print("  Unmatched: " + ", ".join(unmatched[:20]) +
              (" ..." if len(unmatched) > 20 else ""))

    # credit estimate: sum of PkmnPrices card_counts for matched sets
    est_cards = sum(int(pp.get("card_count") or 0) for _, pp, _ in matches)
    print("Estimated card items to fetch: ~%d (cap remaining: %d)" %
          (est_cards, DAILY_CAP - spent_today(ledger)))

    totals = {"sets": 0, "cards": 0, "matched": 0,
              "imagesSet": 0, "namesFixed": 0, "raritiesFixed": 0}
    deferred_sets = []

    # Run-local manifest entries. write_manifest() merges them into the
    # existing data/pkmn-cache/manifest.json instead of replacing it, so
    # --only / --limit runs can't wipe mappings for sets processed on an
    # earlier run (ja-pkmn-build-cards.py and ja-price-backfill.py both
    # read the manifest to find PkmnPrices set/card ids).
    run_sets = []
    run_unmatched_cards = []
    run_warnings = list(warnings)
    run_unmatched_sets = list(unmatched)
    run_skipped_no_snapshot = []

    def write_manifest(preserve_summary=False):
        old = {}
        mp = os.path.join(CACHE, "manifest.json")
        if os.path.isfile(mp):
            try:
                old = json.load(open(mp))
            except Exception:
                old = {}
        processed = {e.get("ourId") for e in run_sets if e.get("ourId")}
        old_sets = [e for e in old.get("sets", [])
                    if e.get("ourId") not in processed]
        old_unmatched = [u for u in old.get("unmatchedSets", [])
                         if u not in processed]
        merged_unmatched = old_unmatched + [
            u for u in run_unmatched_sets if u not in old_unmatched]
        old_uc = [c for c in old.get("unmatchedCards", [])
                  if c.get("set") not in processed]
        old_warn = [w for w in old.get("warnings", [])
                    if not any(str(w).startswith(pid + ":")
                               for pid in processed)]
        old_sns = list(old.get("skippedNoSnapshot", []))
        sns = old_sns + [x for x in run_skipped_no_snapshot
                         if x not in old_sns]
        manifest = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "sets": old_sets + run_sets,
            "unmatchedSets": merged_unmatched,
            "unmatchedCards": old_uc + run_unmatched_cards,
            "warnings": old_warn + run_warnings,
            # --match-only runs carry no per-set results; keep the
            # previous run's summary instead of zeroing it.
            "deferredSets": old.get("deferredSets", []) if preserve_summary
                            else deferred_sets,
            "totals": old.get("totals", totals) if preserve_summary
                      else totals,
            "creditsSpentToday": spent_today(ledger),
        }
        if sns:
            manifest["skippedNoSnapshot"] = sns
        atomic_write_json(mp, manifest, indent=1)

    if args.match_only:
        write_manifest(preserve_summary=True)
        return

    targets = matches
    if args.limit:
        targets = targets[:args.limit]

    # Budget gate: only take what fits, newest-first. Sets whose card data
    # is already cached cost nothing, so they don't reserve budget.
    chosen = []
    running = 0
    for s, pp, warn in targets:
        cache_p = os.path.join(CACHE, "cards-%s.json" % pp.get("id"))
        need = 0 if (os.path.isfile(cache_p) and not args.force) \
            else int(pp.get("card_count") or 0)
        if spent_today(ledger) + running + need > DAILY_CAP:
            print("Budget gate: stopping before %s (need ~%d, remaining %d)." %
                  (s["id"], need, DAILY_CAP - spent_today(ledger) - running))
            break
        chosen.append((s, pp, warn))
        running += need
    skipped = [s["id"] for s, _, _ in targets[len(chosen):]]
    if skipped:
        print("Deferred to another day (%d sets): %s" %
              (len(skipped), ", ".join(skipped[:10])))
    deferred_sets = skipped

    # Incremental manifest flushes: the per-set loop can exit mid-run
    # via SystemExit (429 / budget exhaustion from proxy_get), so
    # per-set manifest entries are checkpointed after every set and
    # flushed on all exit paths.
    try:
        for s, pp, warn in chosen:
            oid = s["id"]
            ppid = pp.get("id")
            snap_p = os.path.join(JA_DIR, oid + ".json")
            if not os.path.isfile(snap_p):
                print("[%s] snapshot missing, skipping (no credits spent)" % oid)
                run_sets.append({
                    "ourId": oid, "ppSetId": ppid, "ppName": pp.get("name"),
                    "skipped": "no snapshot"})
                run_skipped_no_snapshot.append(oid)
                write_manifest()  # checkpoint: don't lose this set's entry
                continue
            cache_p = os.path.join(CACHE, "cards-%s.json" % ppid)
            cached = None
            if os.path.isfile(cache_p) and not args.force:
                try:
                    cached = json.load(open(cache_p))["cards"]
                except Exception as e:
                    # Truncated/corrupt cache: treat as cache-miss and refetch
                    # rather than crashing the whole weekly run.
                    print("[%s] corrupt cache %s (%r) — refetching" %
                          (oid, cache_p, e), file=sys.stderr)
            if cached is not None:
                cards = cached
            else:
                print("[%s] fetching cards from PkmnPrices set %s..." % (oid, ppid),
                      file=sys.stderr)
                try:
                    cards = fetch_all_pages(
                        "/v1/cards",
                        {"language": "Japanese", "set_id": ppid},
                        ledger, oid)
                except SystemExit:
                    raise
                except Exception as e:
                    print("[%s] FAILED: %r — continuing" % (oid, e), file=sys.stderr)
                    run_sets.append({
                        "ourId": oid, "ppSetId": ppid, "ppName": pp.get("name"),
                        "error": repr(e)})
                    write_manifest()  # checkpoint: don't lose this set's entry
                    continue
                atomic_write_json(cache_p, {
                    "set_id": ppid,
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "cards": cards})

            pp_by_num = {}
            dup_nums = 0
            for c in cards:
                k = norm_num(c.get("number"))
                if k in pp_by_num:
                    dup_nums += 1
                    continue  # first entry wins; extras are usually reprints/variants
                pp_by_num[k] = c
            if dup_nums:
                run_warnings.append(
                    "%s: %d duplicate card numbers in PkmnPrices data (kept first)" %
                    (oid, dup_nums))

            snap = json.load(open(snap_p))
            scards = snap.get("cards", [])

            matched = images = names = rarities = 0
            for sc in scards:
                pc = pp_by_num.get(norm_num(sc.get("localId")))
                if not pc:
                    run_unmatched_cards.append({
                        "set": oid, "localId": sc.get("localId"),
                        "name": sc.get("name")})
                    continue
                matched += 1
                img = pc.get("image_url")
                if img:
                    sc["imageSmall"] = img
                    sc["imageLarge"] = img
                    images += 1
                # else: keep the old (Bulbapedia) URL if any
                if has_non_ascii(sc.get("name")):
                    clean = clean_name(pc.get("name"))
                    if clean:
                        sc["name"] = clean
                        names += 1
                # nameJa is never touched.
                # Rarity correction for TCGdex's "Mega Hyper Rare" mislabels.
                if sc.get("rarity") == "Mega Hyper Rare":
                    fixed = PP_RARITY_FIX.get(pc.get("rarity"))
                    if fixed:
                        sc["rarity"] = fixed
                        rarities += 1

            atomic_write_json(snap_p, snap, indent=1)

            totals["sets"] += 1
            totals["cards"] += len(scards)
            totals["matched"] += matched
            totals["imagesSet"] += images
            totals["namesFixed"] += names
            totals["raritiesFixed"] += rarities
            run_sets.append({
                "ourId": oid, "ppSetId": ppid, "ppName": pp.get("name"),
                "cards": len(scards), "matched": matched,
                "imagesSet": images, "namesFixed": names,
                "raritiesFixed": rarities,
                "countWarning": warn,
            })
            print("[%s] %d/%d matched, %d images, %d names fixed, %d rarities fixed" %
                  (oid, matched, len(scards), images, names, rarities))
            write_manifest()  # checkpoint after each set

    finally:
        write_manifest()
    print("\nDone: %d sets, %d cards, %d matched, %d images set, %d names fixed, %d rarities fixed." %
          (totals["sets"], totals["cards"], totals["matched"],
           totals["imagesSet"], totals["namesFixed"], totals["raritiesFixed"]))
    print("Credits spent today: %d / %d" % (spent_today(ledger), DAILY_CAP))


if __name__ == "__main__":
    # Catalog writers must not run concurrently (read-modify-write
    # on the same set files). See scripts/pipeline_lock.py.
    from pipeline_lock import pipeline_lock
    with pipeline_lock("ja-pkmn-enrich"):
        main()
