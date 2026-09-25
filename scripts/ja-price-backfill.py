#!/usr/bin/env python3
"""Bake PkmnPrices Near Mint market prices into the Japanese snapshots.

For every JA snapshot card carrying a ppId, fetches /v1/cards/{ppId} through
the production proxy (1 credit per card) and writes the slim TCGdex-style
pricing block the app already renders for English cards:

    card["pricing"] = {
        "tcgplayer": {"normal": {"marketPrice": 0.15},
                      "holofoil": {"marketPrice": 1.20}},
        "currency": "USD",          # currency of the baked prices
        "pricedAt": "2026-09-16T05:40:00Z",
    }

Variant mapping: PkmnPrices variants ("Normal", "1st Edition", "Unlimited",
"Holofoil", "1st Edition Holofoil", "Reverse Holofoil", ...) collapse to the
three buckets the app understands (normal / holofoil / reverseHolofoil).
Per bucket we prefer the USD Near Mint row, falling back to EUR, then to
whatever row exists. The card currency is USD when any bucket resolved to a
USD row, else EUR.

This is what makes Japanese tiles show price badges and the modal show its
price table exactly like English cards — with zero live API calls at browse
time.

Credit rules: shares data/pkmn-cache/credit-ledger.json (UTC date key) with
ja-pkmn-enrich.py. Hard daily cap 17000 (Pro allows 20000/day). On HTTP 429
we back off twice, then stop cleanly so a later run can resume. A proxy
403 (bad caller key) fails fast instead of retrying every card.

Resume: cards priced within --max-age days are skipped (default 6), so the
weekly refresh only refetches stale cards. --force reprices everything.
--only <id> / --limit N restrict the set list (newest-first).
"""

import fcntl
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JA_DIR = os.path.join(ROOT, "data", "tcgdex", "sets", "ja")
SETS_JA = os.path.join(ROOT, "data", "tcgdex", "sets-ja.json")
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

DAILY_CAP = 17000
# Seconds between proxy requests. The Vercel proxy (api/pkmnprices.js)
# allows 120 req/min per IP (2/s); ~109/min keeps us safely under it.
MIN_INTERVAL = 0.55
MAX_429_TRIES = 4
BACKOFF_429 = (30, 60, 120, 240)  # seconds between 429 retries
# Effective cap for this run; main() may lower it via --daily-cap (e.g. to
# reserve headroom for the app's collection-row price refresh, which shares
# the same 20k/day Pro budget but isn't tracked in the ledger).
daily_cap = DAILY_CAP


def norm_num(s):
    """'001' -> '1'. Same normalization ja-pkmn-enrich.py matched on."""
    s = str(s or "").strip().split("/")[0]
    m = re.match(r"^0*(\d+)(.*)$", s)
    return (m.group(1) + m.group(2)) if m else s


def build_ppid_lookup():
    """(ourSetId, normLocalId) -> PkmnPrices card id, rebuilt from the
    manifest + cached per-set payloads. Zero credits: this reproduces the
    number matches ja-pkmn-enrich.py made (it didn't persist ppIds)."""
    lookup = {}
    mp = os.path.join(CACHE, "manifest.json")
    if not os.path.isfile(mp):
        return lookup
    m = json.load(open(mp))
    for s in m.get("sets", []):
        sid, ppid = s.get("ourId"), s.get("ppSetId")
        if not sid or not ppid:
            continue
        p = os.path.join(CACHE, "cards-%s.json" % ppid)
        if not os.path.isfile(p):
            continue
        try:
            cards = json.load(open(p)).get("cards", [])
        except Exception:
            continue
        for c in cards:
            n = norm_num(c.get("number"))
            if n and c.get("id") is not None:
                lookup.setdefault((sid, n), c["id"])
    return lookup


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
    kwargs.setdefault("ensure_ascii", False)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, **kwargs)
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


_last_req = 0.0


def pace():
    global _last_req
    dt = time.time() - _last_req
    if dt < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - dt)
    _last_req = time.time()


class BudgetExhausted(Exception):
    pass


class RateLimited(Exception):
    pass


class TransientError(Exception):
    pass


class AuthError(Exception):
    """The proxy rejected our caller key (HTTP 403): permanent, fail fast."""
    pass


def proxy_card(pp_id, ledger):
    """GET /v1/cards/{id} via the proxy. 1 credit. Returns parsed JSON.

    A 403 means the proxy rejected our caller key: permanent, so raise
    AuthError (main() fails fast) instead of retrying every card."""
    if spent_today(ledger) >= daily_cap:
        raise BudgetExhausted()
    pace()
    url = PROXY + "?path=" + urllib.parse.quote("/v1/cards/%d" % pp_id, safe="")
    req = urllib.request.Request(url, headers={
        "User-Agent": "VaultDex-ja-prices/1.0",
        "x-vaultdex-key": PROXY_KEY,
    })
    tries = 0
    while True:
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                body = resp.read().decode("utf-8")
            break
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise AuthError(
                    "PROXY 403 FORBIDDEN: the Vercel proxy rejected our "
                    "caller key (no request will succeed). Check that "
                    "PROXY_SHARED_SECRET in Vercel matches "
                    "~/workspace/.secrets/vaultdex-proxy-key (or the "
                    "VAULTDEX_PROXY_KEY env var), then re-run.")
            if e.code == 429:
                if tries < MAX_429_TRIES:
                    wait = BACKOFF_429[min(tries, len(BACKOFF_429) - 1)]
                    print("HTTP 429 — backing off %ds (try %d/%d)." %
                          (wait, tries + 1, MAX_429_TRIES), file=sys.stderr)
                    time.sleep(wait)
                    tries += 1
                    continue
                raise RateLimited()
            # Any other HTTP error (308, 500, 502, 503, ...) is treated as
            # transient: retry, then give up on this card.
            if tries < 3:
                tries += 1
                time.sleep(3 * tries)
                continue
            raise TransientError("HTTP %s" % e.code)
        except Exception as e:
            # Transient network failure (dropped connection, timeout, DNS).
            # Retry a few times, then give up on this card — the resume
            # logic will pick it up on the next run.
            if tries < 3:
                tries += 1
                time.sleep(3 * tries)
                continue
            raise TransientError(str(e))
    add_spend(ledger, 1)
    return json.loads(body)


def norm_variant(v):
    v = (v or "").lower()
    if "reverse" in v:
        return "reverseHolofoil"
    if "holo" in v:
        return "holofoil"
    return "normal"


def extract_prices(card_json):
    """Return ({variant: marketPrice}, currency) from a /v1/cards/{id} payload."""
    rows = [
        p for p in (card_json.get("prices") or [])
        if p and p.get("condition") == "Near Mint"
        and isinstance(p.get("market_price"), (int, float))
    ]
    by_variant = {}
    for p in rows:
        key = norm_variant(p.get("variant"))
        cur = by_variant.get(key)
        if cur is None:
            by_variant[key] = p
        elif cur.get("currency") == "USD":
            pass  # keep USD
        elif p.get("currency") == "USD":
            by_variant[key] = p
    prices = {}
    currency = "USD"
    any_usd = False
    for key, p in by_variant.items():
        prices[key] = {"marketPrice": round(float(p["market_price"]), 2)}
        if p.get("currency") == "USD":
            any_usd = True
    if prices and not any_usd:
        currency = "EUR"
    return prices, currency


def priced_recently(card, max_age_days):
    pr = card.get("pricing") or {}
    ts = pr.get("pricedAt")
    if not ts:
        return False
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return False
    return datetime.now(timezone.utc) - dt < timedelta(days=max_age_days)


def main():
    global daily_cap
    args = sys.argv[1:]
    force = "--force" in args
    only = args[args.index("--only") + 1].split(",") if "--only" in args else None
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else 0
    max_age = float(args[args.index("--max-age") + 1]) if "--max-age" in args else 6.0
    daily_cap = int(args[args.index("--daily-cap") + 1]) if "--daily-cap" in args else DAILY_CAP

    with open(SETS_JA, encoding="utf-8") as f:
        sets = json.load(f)
    if only:
        only_set = set(only)
        sets = [s for s in sets if s["id"] in only_set]
    if limit:
        sets = sets[:limit]

    ledger = load_ledger()
    lookup = build_ppid_lookup()
    print("ppId lookup: %d entries" % len(lookup), file=sys.stderr)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    n_cards = n_priced = n_skipped = n_noprice = 0

    for s in sets:
        sid = s["id"]
        path = os.path.join(JA_DIR, sid + ".json")
        if not os.path.isfile(path):
            continue
        snap = json.load(open(path, encoding="utf-8"))
        cards = snap.get("cards", [])
        dirty = False
        for c in cards:
            pp_id = c.get("ppId") or lookup.get((sid, norm_num(c.get("localId"))))
            if not pp_id:
                continue
            if not c.get("ppId"):
                c["ppId"] = pp_id  # persist for future runs
                dirty = True
            if not force and priced_recently(c, max_age):
                n_skipped += 1
                continue
            n_cards += 1
            try:
                data = proxy_card(int(pp_id), ledger)
            except BudgetExhausted:
                print("BUDGET_EXHAUSTED: daily cap of %d reached." % daily_cap)
                if dirty:
                    atomic_write_json(path, snap, ensure_ascii=False)
                print("priced=%d skipped=%d no-price-data=%d fetched=%d" %
                      (n_priced, n_skipped, n_noprice, n_cards))
                sys.exit(2)
            except RateLimited:
                print("RATE LIMITED after backoff — stopping; resume later.")
                if dirty:
                    atomic_write_json(path, snap, ensure_ascii=False)
                print("priced=%d skipped=%d no-price-data=%d fetched=%d" %
                      (n_priced, n_skipped, n_noprice, n_cards))
                sys.exit(3)
            except AuthError as e:
                # Wrong/missing proxy key: permanent. Fail fast (exit 4)
                # instead of burning retries on every card.
                print(str(e), file=sys.stderr)
                if dirty:
                    atomic_write_json(path, snap, ensure_ascii=False)
                print("priced=%d skipped=%d no-price-data=%d fetched=%d" %
                      (n_priced, n_skipped, n_noprice, n_cards))
                sys.exit(4)
            except TransientError as e:
                # One flaky card shouldn't kill the run; resume picks it up.
                print("TRANSIENT ERROR on ppId %s: %s — skipping card." %
                      (pp_id, e), file=sys.stderr)
                n_noprice += 1
                continue
            prices, currency = extract_prices(data)
            if not prices:
                n_noprice += 1
            else:
                n_priced += 1
            c["pricing"] = {"tcgplayer": prices, "currency": currency,
                            "pricedAt": now}
            dirty = True
        if dirty:
            atomic_write_json(path, snap, ensure_ascii=False)
        print("[%s] done (%d priced this run)" % (sid, n_priced), file=sys.stderr)

    print("Done: priced=%d skipped=%d no-price-data=%d fetched=%d" %
          (n_priced, n_skipped, n_noprice, n_cards))
    print("Credits spent today: %d / %d" % (spent_today(ledger), daily_cap))


if __name__ == "__main__":
    # Catalog writers must not run concurrently (read-modify-write
    # on the same set files). See scripts/pipeline_lock.py.
    from pipeline_lock import pipeline_lock
    with pipeline_lock("ja-price-backfill"):
        main()
