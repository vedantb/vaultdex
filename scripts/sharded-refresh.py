#!/usr/bin/env python3
"""Hardened sharded daily VaultDex catalog refresh orchestrator.

Design premise: the host is an ephemeral container that gets replaced as a
matter of course (sometimes hourly). Mid-run death is the NORMAL case, not
the exception — so every run must be independently resumable, bounded, and
incapable of leaving the repo tree dirty.

Four hardenings over the original sharded design:

1. WORK-QUEUE SCHEDULING (no weekday rota). Every run pulls the stalest
   shards from state.json, bounded at SHARDS_PER_RUN. A missed run just
   means slower progress, never a stuck pipeline.

2. STAGING-DIR ISOLATION. All refresh I/O goes to data/.refresh/staging/
   (gitignored). Sub-scripts redirect via the VAULTDEX_DATA_DIR env var.
   A promote step copies only verified outputs into the live tree; a
   killed run leaves the repo working tree byte-identical.

3. HOT-SET INCREMENTALITY. Per-set upstream fingerprints
   (sha256 of the TCGdex /sets/<id> card list) are stored in state.json;
   unchanged sets are skipped. TCGdex exposes no updatedAt/Last-Modified
   on set resources (only weak, CDN-generated ETags), so we fingerprint
   the content we actually consume. Always refreshed: the hot list
   (data/.refresh/hot-sets.json) + brand-new sets. Full-sweep backstop:
   every shard is force-refreshed at least every FULL_SWEEP_DAYS.

4. DEAD-MAN'S SWITCH. `--check-stale` exits 2 when no shard has succeeded
   within --stale-days (default 3). Wire as a daily cron (spec below);
   the cron runner alerts on nonzero exit.

Dead-man's switch cron (NOT created yet — wire later):
    0 9 * * * cd ~/workspace/pokemon-tcg-app && \
        python3 scripts/sharded-refresh.py --check-stale --stale-days 3

Daily driver cron (NOT created yet — wire later):
    40 3 * * * cd ~/workspace/pokemon-tcg-app && \
        python3 scripts/sharded-refresh.py --no-push

Usage:
  python3 scripts/sharded-refresh.py               # work-queue selection
  python3 scripts/sharded-refresh.py --shard 3     # shard 3, manual
  python3 scripts/sharded-refresh.py --max-shards 1
  python3 scripts/sharded-refresh.py --dry-run     # print plan, change nothing
  python3 scripts/sharded-refresh.py --no-push    # run through commit, skip push+verify
  python3 scripts/sharded-refresh.py --list-shards
  python3 scripts/sharded-refresh.py --check-stale [--stale-days N]

Safety:
  - exclusive data/.refresh/lock (shared with the weekly driver),
  - per-shard state + heartbeat in data/.refresh/shard-state.json,
  - staging isolation: the live data/ tree is only ever touched by the
    promote step, after the sanity gate passes on staging output,
  - data-only git staging (never `git add -A`), push-to-main deploys
    (never `vercel deploy`), one catalog writer at a time.

Exit codes: 0 = complete (or check-stale OK), 1 = stage failed (see log),
2 = another driver holds the lock, or check-stale found the refresh stale.
"""
import argparse
import fcntl
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFRESH_DIR = os.path.join(REPO, "data", ".refresh")
STATE_PATH = os.path.join(REFRESH_DIR, "shard-state.json")
LOCK_PATH = os.path.join(REFRESH_DIR, "lock")  # shared with weekly-refresh.py
HOT_SETS_PATH = os.path.join(REFRESH_DIR, "hot-sets.json")
HOT_SEED_PATH = os.path.join(REPO, "scripts", "hot-sets.seed.json")
DEFAULT_STAGING = os.path.join(REFRESH_DIR, "staging")
LOG_DIR = os.path.expanduser("~/workspace/goals/vaultdex-weekly-catalog-refresh/hidden_files")
PROXY_SECRET = os.path.expanduser("~/workspace/.secrets/vaultdex-proxy-key")
PROD_BASE = "https://vaultdex-three.vercel.app"

NUM_SHARDS = 7
# Salt picked by scanning candidates for the most even set-count split
# (see scripts/tests/test_sharded_refresh.py::ShardBalanceTests).
SHARD_SALT = "vd-shard-v1#6"

# Work-queue bound: max shards per run. Steady-state runs (fingerprint
# skips) finish in minutes; the bound keeps even worst-case runs small.
SHARDS_PER_RUN = 2

# Full-sweep backstop: a shard is force-refreshed when its last full
# sweep is older than this (or never happened).
FULL_SWEEP_DAYS = 30

# Dead-man's switch default: alert when no shard succeeded within N days.
STALE_DAYS = 3

# TCG Pocket sets: hidden from browse by design. Canonical source is
# snapshot-tcgdex.py::POCKET_SET_IDS (unit-tested for equality); sets.json
# already excludes them, this is defense-in-depth for --set targeting
# and hot-list additions.
POCKET_SET_IDS = frozenset({
    "A1", "A1a", "A2", "A2a", "A2b",
    "A3", "A3a", "A3b", "A4", "A4a",
    "B1", "B1a", "B2", "B2a", "P-A",
})

# JA sets with no TCGdex endpoint: never snapshot targets.
# S-P/SM-P/XY-P/BW-P are hand-maintained in ja-custom-sets.json;
# M6a (JP 30th) is rebuilt from cache by build-m6a-pkmngg.py.
JA_NOFETCH_IDS = frozenset({"S-P", "SM-P", "XY-P", "BW-P", "M6a"})

# Exclusions applied to snapshot targeting (incl. hot-list additions).
_EXCLUDED = {"en": POCKET_SET_IDS, "ja": JA_NOFETCH_IDS}

# A shard is overdue when it never completed or last completed > 8 days ago.
# (Legacy helper find_overdue_shards/plan_shards below; the work queue in
# main() supersedes them.)
OVERDUE_DAYS = 8


# ---------------------------------------------------------------- pure logic
# (import-safe: no I/O, no locks — unit-tested in test_sharded_refresh.py)

def shard_of(set_id, num_shards=NUM_SHARDS):
    """Deterministic, stable shard for a set id (0..num_shards-1)."""
    h = hashlib.sha256((SHARD_SALT + ":" + set_id).encode("utf-8")).hexdigest()
    return int(h, 16) % num_shards


def build_shards(en_ids, ja_ids, num_shards=NUM_SHARDS):
    """Map shard -> {"en": [...], "ja": [...]}. Every id lands in exactly
    one shard; Pocket and no-fetch JA sets are excluded from targeting."""
    shards = {i: {"en": [], "ja": []} for i in range(num_shards)}
    for sid in en_ids:
        if sid in POCKET_SET_IDS:
            continue
        shards[shard_of(sid, num_shards)]["en"].append(sid)
    for sid in ja_ids:
        if sid in JA_NOFETCH_IDS:
            continue
        shards[shard_of(sid, num_shards)]["ja"].append(sid)
    for s in shards.values():
        s["en"].sort()
        s["ja"].sort()
    return shards


def weekday_shard(d):
    """Monday=0 .. Sunday=6. Legacy: main() no longer routes by weekday
    (see select_work_queue); kept for backward compatibility."""
    return d.weekday()


def shard_age_days(shard_state, n, now):
    """Days since shard n last completed, or None when never/invalid."""
    info = (shard_state.get("shards") or {}).get(str(n)) or {}
    ts = info.get("last_ok")
    if not ts:
        return None
    try:
        return (now - datetime.fromisoformat(ts)).total_seconds() / 86400.0
    except ValueError:
        return None


def select_work_queue(shard_state, now, max_shards=SHARDS_PER_RUN,
                      num_shards=NUM_SHARDS):
    """Pure pull model: stalest shards first (never-ran before anything
    else), bounded at max_shards. No weekday routing — a missed run just
    means slower progress, never a stuck pipeline. The queue keeps
    rotating even when everything is fresh, so fingerprints get
    re-verified every cycle."""
    def rank(n):
        age = shard_age_days(shard_state, n, now)
        return (1, -age, n) if age is not None else (0, n)
    return sorted(range(num_shards), key=rank)[:max_shards]


def shard_full_sweep_due(shard_state, n, now, days=FULL_SWEEP_DAYS):
    """30-day backstop: True when shard n never had a full sweep or the
    last one is older than `days`."""
    info = (shard_state.get("shards") or {}).get(str(n)) or {}
    ts = info.get("last_full_ok")
    if not ts:
        return True
    try:
        return (now - datetime.fromisoformat(ts)) > timedelta(days=days)
    except ValueError:
        return True


def upstream_fingerprint(set_detail):
    """Content fingerprint of a TCGdex /sets/<id> response.

    TCGdex exposes no updatedAt/Last-Modified on set resources — only
    weak, CDN-generated ETags, which are not trustworthy for change
    detection. So we hash the content we actually consume: the card
    summary list (id/localId/name/image) plus the card counts.
    Price and variant-detail changes do NOT alter the fingerprint;
    those refresh through the PkmnPrices-backed paths, not the snapshot.
    """
    d = set_detail or {}
    cards = d.get("cards") or []
    norm = sorted(
        (c.get("id"), c.get("localId"), c.get("name"), c.get("image"))
        for c in cards if isinstance(c, dict))
    blob = json.dumps({"cardCount": d.get("cardCount"), "cards": norm},
                      sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def select_snapshot_targets(candidates, fingerprints, hot_ids,
                            fetch_detail, force_all=False):
    """Decide which sets to snapshot. Pure except fetch_detail(lang, sid).

    candidates: {"en": [...], "ja": [...]} — pre-filtering not required;
      Pocket / no-fetch exclusions are applied here (defense in depth,
      so a hot-listed Pocket id can never become a target).
    fingerprints: {"<lang>:<sid>": sha} from state.json.
    hot_ids: {"en": set, "ja": set} — always targeted.
    fetch_detail(lang, sid): parsed /sets/<id> JSON; may raise.
    force_all: target everything (30-day backstop).

    Returns (targets, prefetched, fetch_failed):
      targets {"en": [...], "ja": [...]}, prefetched {key: fp} for sets
      whose fingerprint was fetched during selection, fetch_failed [keys]
      whose fingerprint fetch failed (targeted anyway — safe direction).
    """
    targets = {"en": [], "ja": []}
    prefetched = {}
    fetch_failed = []
    hot = {lang: set(hot_ids.get(lang, ())) for lang in ("en", "ja")}
    for lang in ("en", "ja"):
        for sid in sorted(set(candidates.get(lang, ())) - _EXCLUDED[lang]):
            key = "%s:%s" % (lang, sid)
            if sid in hot[lang] or force_all or key not in fingerprints:
                targets[lang].append(sid)
                continue
            try:
                fp = upstream_fingerprint(fetch_detail(lang, sid))
            except Exception:
                fetch_failed.append(key)
                targets[lang].append(sid)
                continue
            prefetched[key] = fp
            if fp != fingerprints[key]:
                targets[lang].append(sid)
    return targets, prefetched, fetch_failed


def _fmt_age(delta):
    s = int(delta.total_seconds())
    if s < 3600:
        return "%dm" % (s // 60)
    if s < 86400:
        return "%dh" % (s // 3600)
    return "%dd" % (s // 86400)


def check_stale(state, now, max_days=STALE_DAYS):
    """Dead-man's switch. Returns (ok, message): ok is False when no
    shard has completed within max_days (or none ever completed)."""
    latest = None
    latest_shard = None
    for n, info in (state.get("shards") or {}).items():
        ts = (info or {}).get("last_ok")
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts)
        except ValueError:
            continue
        if latest is None or dt > latest:
            latest, latest_shard = dt, n
    if latest is None:
        return False, "refresh STALE: no shard has ever completed successfully"
    age = now - latest
    if age > timedelta(days=max_days):
        return False, ("refresh STALE: last successful shard was %s (%s ago; "
                       "threshold %dd)" % (latest_shard, _fmt_age(age), max_days))
    return True, ("refresh OK: last successful shard %s (%s ago)"
                  % (latest_shard, _fmt_age(age)))


def derive_set_id(card_id):
    """Set id from a card id, mirroring the app's setIdOf() (js/tcg-api.js)."""
    cid = str(card_id or "")
    i = cid.rfind("-")
    return cid[:i] if i > 0 else ""


def index_entry_for_card(card):
    """Project a set-file card to an index.json entry, mirroring
    snapshot-tcgdex.snapshot_index() + overlay_set_images()."""
    e = {"id": card.get("id"), "localId": card.get("localId"),
         "name": card.get("name")}
    img = card.get("imageSmall") or card.get("imageLarge") or card.get("image")
    if img:
        e["image"] = img
    return e


def merge_index_entries(existing, shard_set_ids, set_cards):
    """Shard-scoped index.json refresh (pure).

    existing: current index.json entries.
    shard_set_ids: EN set ids refreshed today.
    set_cards: {set_id: [cards]} from the fresh on-disk set files.
    Entries for the shard's sets are replaced with freshly derived ones;
    everything else (other sets, hand-merged local-only cards) passes
    through untouched.
    """
    shard_set_ids = set(shard_set_ids)
    kept = [e for e in existing
            if derive_set_id(e.get("id")) not in shard_set_ids]
    fresh = []
    for sid in sorted(set_cards):
        for c in set_cards[sid]:
            if c.get("id"):
                fresh.append(index_entry_for_card(c))
    return kept + fresh


def detect_new_sets(previous_ids, current_ids):
    """Ids present now but not before (sorted). Empty previous (first run)
    yields no "new" sets — bootstrap is handled by the catch-up rule."""
    if not previous_ids:
        return []
    prev = set(previous_ids)
    return sorted(s for s in current_ids if s not in prev)


def find_overdue_shards(shard_state, now, max_age_days=OVERDUE_DAYS):
    """Shard numbers (ascending) whose last_ok is missing or older than
    max_age_days. 'never ran' sorts first (most overdue). Legacy: the
    work queue (select_work_queue) supersedes this in main()."""
    scored = []
    for n in range(NUM_SHARDS):
        info = (shard_state.get("shards") or {}).get(str(n)) or {}
        last_ok = info.get("last_ok")
        if not last_ok:
            scored.append((0, n))
            continue
        try:
            age = now - datetime.fromisoformat(last_ok)
        except ValueError:
            scored.append((0, n))
            continue
        if age > timedelta(days=max_age_days):
            scored.append((1, n))
    scored.sort()
    return [n for _, n in scored]


def plan_shards(shard_state, today_shard, now):
    """Legacy routing: today's shard plus the single stalest overdue shard.
    main() now uses select_work_queue(); kept for backward compatibility."""
    plan = [today_shard]
    for n in find_overdue_shards(shard_state, now):
        if n != today_shard:
            plan.append(n)
            break
    return plan


def _sync_new_files(src_dir, dst_dir):
    """Copy files present under src_dir but missing under dst_dir
    (by relative path). Used at promote time for vendored binary assets
    (card images, set logos/symbols). Returns the copied rel paths."""
    copied = []
    if not os.path.isdir(src_dir):
        return copied
    for root, _dirs, files in os.walk(src_dir):
        for fn in files:
            src = os.path.join(root, fn)
            rel = os.path.relpath(src, src_dir)
            dst = os.path.join(dst_dir, rel)
            if not os.path.exists(dst):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                copied.append(rel)
    return sorted(copied)


# ---------------------------------------------------------------- state/lock

def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"shards": {}, "heartbeat": None}


def save_state(state):
    os.makedirs(REFRESH_DIR, exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def load_hot_sets(path=None):
    """{"en": [...], "ja": [...]}. Created from scripts/hot-sets.seed.json
    on first run; the live copy at data/.refresh/hot-sets.json is the
    tunable one."""
    path = path or HOT_SETS_PATH
    if not os.path.isfile(path):
        try:
            with open(HOT_SEED_PATH) as f:
                obj = json.load(f)
        except (OSError, ValueError):
            obj = {"en": [], "ja": []}
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _atomic_write(path, {"en": sorted(set(obj.get("en", []))),
                              "ja": sorted(set(obj.get("ja", [])))})
    try:
        with open(path) as f:
            obj = json.load(f)
        return {"en": sorted(set(obj.get("en", []))),
                "ja": sorted(set(obj.get("ja", [])))}
    except (OSError, ValueError):
        return {"en": [], "ja": []}


def acquire_lock():
    os.makedirs(REFRESH_DIR, exist_ok=True)
    fh = open(LOCK_PATH, "a+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.seek(0)
        holder = fh.read().strip() or "unknown"
        print("another refresh driver holds the lock (%s) — exiting" % holder,
              file=sys.stderr)
        sys.exit(2)
    fh.seek(0)
    fh.truncate()
    fh.write("pid=%d started=%s sharded" % (os.getpid(),
              datetime.now(timezone.utc).isoformat()))
    fh.flush()
    return fh


def heartbeat_loop(state, stop):
    while not stop.wait(300):
        state["heartbeat"] = datetime.now(timezone.utc).isoformat()
        save_state(state)
        log("heartbeat: still running")


# ---------------------------------------------------------------- staging

def seed_staging(live_data, staging):
    """Wipe and re-seed the staging dir from the live data tree.

    Mutable catalog inputs are copied (sets/ ~14M, card-images ~21M —
    seconds on local disk). Read-only shared inputs are symlinked so the
    PkmnPrices credit ledger stays single and caches aren't duplicated.
    A previous killed run's staging can never leak into this run.
    """
    if os.path.isdir(staging) or os.path.islink(staging):
        shutil.rmtree(staging)
    os.makedirs(staging)
    shutil.copytree(os.path.join(live_data, "tcgdex"),
                    os.path.join(staging, "tcgdex"))
    for rel in ("species-printings.json", "artist-stats.json"):
        p = os.path.join(live_data, rel)
        if os.path.isfile(p):
            shutil.copy2(p, os.path.join(staging, rel))
    for rel in ("pkmn-cache", "pkmn-gg-cache", "pkmn-gg-m6a.json"):
        src = os.path.join(live_data, rel)
        if os.path.exists(src) and not os.path.lexists(os.path.join(staging, rel)):
            os.symlink(src, os.path.join(staging, rel))


def promote_outputs(staging, live_data, ctx):
    """Copy verified staging outputs into the live data tree. Only known
    outputs are promoted — nothing else can leak from staging. Failed
    sets are skipped (their staging copies are the pre-run versions)."""
    copied = []

    def cp(rel):
        src = os.path.join(staging, rel)
        dst = os.path.join(live_data, rel)
        if os.path.isfile(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            copied.append(rel)

    for rel in ("tcgdex/sets.json", "tcgdex/sets-ja.json",
                "tcgdex/manifest.json", "tcgdex/manifest-ja.json",
                "tcgdex/index.json", "tcgdex/index-ja.json",
                "species-printings.json", "artist-stats.json",
                "tcgdex/sets/ja/M6a.json"):
        cp(rel)
    failed = {lang: {s for (l, s) in ctx.get("failed_sets", []) if l == lang}
              for lang in ("en", "ja")}
    for lang, sub in (("en", "sets"), ("ja", "sets/ja")):
        for sid in ctx["targets"][lang]:
            if sid not in failed[lang]:
                cp("tcgdex/%s/%s.json" % (sub, sid))
    for rel in ("tcgdex/card-images", "tcgdex/set-logos", "tcgdex/set-symbols"):
        for f in _sync_new_files(os.path.join(staging, rel),
                                 os.path.join(live_data, rel)):
            copied.append(os.path.join(rel, f))
    return copied


# ---------------------------------------------------------------- helpers

def log(msg):
    line = "[%s] %s" % (datetime.now().strftime("%H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def run(cmd, cwd=REPO, check=True, env=None):
    log("$ " + (" ".join(cmd) if isinstance(cmd, list) else cmd))
    full_env = None
    if env:
        full_env = dict(os.environ)
        full_env.update(env)
    p = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, shell=isinstance(cmd, str), env=full_env,
    )
    with open(LOG_FILE, "a") as f:
        for line in p.stdout:
            sys.stdout.write(line)
            f.write(line)
    p.wait()
    if check and p.returncode != 0:
        raise StageError("exit %d: %s" % (p.returncode, cmd))
    return p.returncode


class StageError(Exception):
    pass


def _load(p):
    with open(p) as f:
        return json.load(f)


def _set_ids(path):
    try:
        return [s["id"] for s in _load(path)]
    except (OSError, ValueError, KeyError, TypeError):
        return []


def _atomic_write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


_snapshot_mod = None


def snapshot_mod():
    """Import scripts/snapshot-tcgdex.py as a module to reuse its polite()
    rate-limited fetcher for fingerprint checks. Import-safe (the test
    suite imports it the same way)."""
    global _snapshot_mod
    if _snapshot_mod is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "vd_snapshot_tcgdex",
            os.path.join(REPO, "scripts", "snapshot-tcgdex.py"))
        mod = importlib.util.module_from_spec(spec)
        sys.modules["vd_snapshot_tcgdex"] = mod
        spec.loader.exec_module(mod)
        _snapshot_mod = mod
    return _snapshot_mod


# ---------------------------------------------------------------- stages

def stage_preflight(ctx):
    r = subprocess.run(
        ["curl", "-sf", "--max-time", "25", "https://api.tcgdex.net/v2/en/sets",
         "-o", "/dev/null"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise StageError("api.tcgdex.net unreachable — aborting, pushing nothing")
    for path, desc in [
        (PROXY_SECRET, "pkmnprices proxy secret"),
        (os.path.join(REPO, "scripts", "snapshot-tcgdex.py"), "snapshot script"),
    ]:
        if not (os.path.isfile(path) and os.path.getsize(path) > 0):
            raise StageError("missing %s: %s" % (desc, path))
    for tool in (["node", "--version"], ["npx", "--version"]):
        if subprocess.run(tool, capture_output=True).returncode != 0:
            raise StageError("missing tool: %s" % tool[0])
    # Staging isolation means the live tree is only ever touched by the
    # promote step. If it is dirty now, that is pre-existing debris from
    # an older run — refuse to compound it.
    r = subprocess.run(
        ["git", "status", "--porcelain", "--", "data/tcgdex",
         "data/species-printings.json", "data/artist-stats.json"],
        cwd=REPO, capture_output=True, text=True)
    if r.returncode != 0 or r.stdout.strip():
        raise StageError("live data tree is dirty — clear it before running: %s"
                         % r.stdout.strip()[:200])
    log("preflight ok")


def stage_setlists(ctx):
    """Refresh the set lists (cheap) into staging and detect brand-new
    sets, which are snapshotted immediately rather than waiting."""
    tcg = ctx["tcg"]
    prev_en = _set_ids(os.path.join(tcg, "sets.json"))
    prev_ja = _set_ids(os.path.join(tcg, "sets-ja.json"))
    run([sys.executable, "scripts/snapshot-tcgdex.py", "--sets"], env=ctx["env"])
    run([sys.executable, "scripts/snapshot-tcgdex.py", "--sets", "--lang", "ja"],
        env=ctx["env"])
    cur_en = _set_ids(os.path.join(tcg, "sets.json"))
    cur_ja = _set_ids(os.path.join(tcg, "sets-ja.json"))
    new_en = [s for s in detect_new_sets(prev_en, cur_en)
              if s not in POCKET_SET_IDS]
    new_ja = [s for s in detect_new_sets(prev_ja, cur_ja)
              if s not in JA_NOFETCH_IDS]
    ctx["new_sets"] = {"en": new_en, "ja": new_ja}
    ctx["shards"] = build_shards(cur_en, cur_ja)
    if new_en or new_ja:
        log("new sets detected (snapshotting today): en=%s ja=%s"
            % (new_en, new_ja))
    else:
        log("no new sets; shard universes: EN=%d JA=%d"
            % (len(cur_en), len(cur_ja)))


def stage_select_targets(ctx):
    """Hot-set incrementality: fetch each candidate set's upstream
    fingerprint and skip sets whose upstream is unchanged. Hot-listed
    sets, brand-new sets, and (on backstop runs) everything are always
    targeted. Fingerprint fetch failures target the set anyway (safe
    direction)."""
    snap = snapshot_mod()

    def fetch_detail(lang, sid):
        snap.BASE = snap.API_ROOT + "/" + lang
        return snap.polite("/sets/" + sid)

    cand = {"en": set(), "ja": set()}
    for n in ctx["plan"]:
        cand["en"].update(ctx["shards"][n]["en"])
        cand["ja"].update(ctx["shards"][n]["ja"])
    cand["en"] |= ctx["hot_ids"]["en"]
    cand["ja"] |= ctx["hot_ids"]["ja"]
    for lang in ("en", "ja"):
        cand[lang].update(ctx["new_sets"][lang])
    targets, prefetched, fetch_failed = select_snapshot_targets(
        cand, ctx["state"].get("fingerprints", {}),
        {"en": ctx["hot_ids"]["en"], "ja": ctx["hot_ids"]["ja"]},
        fetch_detail, force_all=ctx["force_all"])
    ctx["targets"] = targets
    ctx["prefetched"] = prefetched
    if fetch_failed:
        log("fingerprint fetch failed for %d sets (snapshotting anyway): %s"
            % (len(fetch_failed), fetch_failed[:5]))
    log("targets: %d EN + %d JA sets (hot=%d, forced_full=%s)"
        % (len(targets["en"]), len(targets["ja"]),
           len(ctx["hot_ids"]["en"]) + len(ctx["hot_ids"]["ja"]),
           ctx["force_all"]))


def _snapshot_ids(ctx, lang, ids):
    snap = snapshot_mod()
    snap.BASE = snap.API_ROOT + "/" + lang
    failed = []
    for i, sid in enumerate(ids):
        cmd = [sys.executable, "scripts/snapshot-tcgdex.py",
               "--set", sid, "--workers", "2"]
        if lang == "ja":
            cmd += ["--lang", "ja"]
        try:
            run(cmd, env=ctx["env"])
        except StageError as e:
            log("  !! set %s failed (%s) — continuing" % (sid, e))
            failed.append(sid)
        else:
            log("  [%d/%d] %s ok" % (i + 1, len(ids), sid))
            key = "%s:%s" % (lang, sid)
            fp = ctx["prefetched"].get(key)
            if fp is None:
                # Hot / forced / new sets skipped the prefetch: fetch now
                # so the next cycle can skip them when unchanged.
                try:
                    fp = upstream_fingerprint(snap.polite("/sets/" + sid))
                except Exception as e:
                    log("  !! fingerprint refresh failed for %s: %s" % (key, e))
                    fp = None
            if fp:
                ctx["new_fingerprints"][key] = fp
    return failed


def stage_snapshot(ctx):
    """Snapshot the selected targets into staging. Per-set --set writes
    are atomic; a failed set keeps its previous file and is recorded
    for retry — no backup dance needed."""
    failed = []
    failed += [("en", s) for s in _snapshot_ids(ctx, "en", sorted(ctx["targets"]["en"]))]
    failed += [("ja", s) for s in _snapshot_ids(ctx, "ja", sorted(ctx["targets"]["ja"]))]
    ctx["failed_sets"] = failed
    if failed:
        log("WARNING: %d sets failed: %s" % (len(failed), failed))


def stage_30thc(ctx):
    # Cache-only re-vendor of EN 30th Anniversary card images (no-op when
    # images are already present).
    run([sys.executable, "scripts/build-30thc-pkmngg.py"], env=ctx["env"])


def stage_enrich_ja(ctx):
    ja_ids = sorted(ctx["targets"]["ja"])
    if not ja_ids:
        log("no JA sets targeted — skipping enrich")
        return
    run([sys.executable, "scripts/ja-pkmn-enrich.py",
         "--only", ",".join(ja_ids)], env=ctx["env"])
    run([sys.executable, "scripts/ja-pkmn-build-cards.py"], env=ctx["env"])


def stage_backfill_ja(ctx):
    ja_ids = sorted(ctx["targets"]["ja"])
    if not ja_ids:
        log("no JA sets targeted — skipping backfill")
        return
    # --max-age 6 (default): cards priced within 6 days are skipped, so the
    # daily run is cheap after the first cycle. In-script daily cap 17000.
    run([sys.executable, "scripts/ja-price-backfill.py",
         "--only", ",".join(ja_ids)], env=ctx["env"])


def stage_m6a(ctx):
    # Cache-only rebuild of the JP 30th Celebration set (173 cards) +
    # its sets-ja.json entry. NEVER re-run pull-pkmngg-m6a.py.
    run([sys.executable, "scripts/build-m6a-pkmngg.py"], env=ctx["env"])


def stage_indexes(ctx):
    tcg = ctx["tcg"]
    # EN index.json: merge entries for exactly the targeted EN sets from
    # the fresh staging set files.
    en_ids = sorted(ctx["targets"]["en"])
    set_cards = {}
    for sid in en_ids:
        p = os.path.join(tcg, "sets", sid + ".json")
        try:
            set_cards[sid] = _load(p).get("cards") or []
        except (OSError, ValueError):
            log("  !! cannot read %s for index merge" % p)
    idx_path = os.path.join(tcg, "index.json")
    try:
        existing = _load(idx_path)
    except (OSError, ValueError):
        existing = []
    merged = merge_index_entries(existing, en_ids, set_cards)
    _atomic_write(idx_path, merged)
    log("index.json: %d -> %d entries (%d sets merged)"
        % (len(existing), len(merged), len(en_ids)))
    # JA search index + derived stats: full rebuilds from staging (fast).
    run([sys.executable, "scripts/build-ja-search-index.py"], env=ctx["env"])
    run(["node", "scripts/build-species-printings.js"], env=ctx["env"])
    run(["node", "scripts/build-artist-stats.js"], env=ctx["env"])
    # Shard-aware manifests (the --all manifest writer only runs on full
    # snapshots; keep the "snapshot completed" proof meaningful).
    for lang, sub in (("en", "sets"), ("ja", "sets/ja")):
        d = os.path.join(tcg, sub)
        have = sorted(f[:-5] for f in os.listdir(d) if f.endswith(".json"))
        _atomic_write(
            os.path.join(tcg, "manifest.json" if lang == "en" else "manifest-ja.json"),
            {"generated_at": datetime.now(timezone.utc).isoformat(),
             "lang": lang, "sets": have, "set_count": len(have),
             "sharded": True})
    log("manifests rewritten from staging sets")


def stage_tests(ctx):
    run([sys.executable, "-m", "unittest", "discover", "-s", "scripts/tests"])
    run(["npx", "vitest", "run"])


def _shrink_errors(entries):
    """Pure: fail when an index shrank >3% vs HEAD (mirrors
    weekly-refresh._index_shrink_errors)."""
    errors = []
    for rel, n, old in entries:
        if old and n < old * 0.97:
            errors.append("%s shrank %d -> %d (>3%% vs HEAD)" % (rel, old, n))
    return errors


def _coverage_drop_error(priced, total, old_priced, old_total):
    """Pure: a >5-point JA pricing coverage drop vs HEAD is an error
    (mirrors weekly-refresh._coverage_drop_error)."""
    if total and old_total:
        cov_now, cov_old = 100.0 * priced / total, 100.0 * old_priced / old_total
        if cov_old - cov_now > 5:
            return ("JA pricing coverage dropped %.1f%% -> %.1f%% (>5 pts vs HEAD)"
                    % (cov_old, cov_now))
    return None


def stage_sanity(ctx):
    """Sanity gate, evaluated against the STAGING tree. Nothing reaches
    the live tree unless this passes."""
    errors, warnings = [], []
    tcg = ctx["tcg"]

    def need(cond, msg):
        if not cond:
            errors.append(msg)

    # 1. the targeted set files parse
    bad = []
    for sid in ctx["targets"]["en"]:
        f = os.path.join(tcg, "sets", sid + ".json")
        try:
            _load(f)
        except Exception as e:
            bad.append("%s (%s)" % (sid, e))
    for sid in ctx["targets"]["ja"]:
        f = os.path.join(tcg, "sets", "ja", sid + ".json")
        try:
            _load(f)
        except Exception as e:
            bad.append("%s (%s)" % (sid, e))
    need(not bad, "unparseable targeted set files: %s" % bad[:5])
    if ctx.get("failed_sets"):
        warnings.append("%d sets failed to snapshot: %s"
                        % (len(ctx["failed_sets"]), ctx["failed_sets"][:5]))

    # 2. no leftover temp files from crashed atomic writes
    tmps = glob.glob(os.path.join(tcg, "**", "*.tmp"), recursive=True)
    need(not tmps, "leftover .tmp files: %s" % tmps[:5])

    # 3. set-list counts within sane floors
    en_n = len(_set_ids(os.path.join(tcg, "sets.json")))
    ja_n = len(_set_ids(os.path.join(tcg, "sets-ja.json")))
    need(en_n >= 200, "sets.json has only %d sets (expected >= 200)" % en_n)
    need(ja_n >= 180, "sets-ja.json has only %d sets (expected >= 180)" % ja_n)

    # 4. manifests prove the snapshot step completed
    for m in ("manifest.json", "manifest-ja.json"):
        need(os.path.isfile(os.path.join(tcg, m)), "missing %s" % m)

    # 5. M6a present with the full 173-card checklist
    try:
        m6a = _load(os.path.join(tcg, "sets", "ja", "M6a.json"))
        need(len(m6a.get("cards", [])) == 173,
             "M6a.json has %d cards (expected 173)" % len(m6a.get("cards", [])))
    except Exception as e:
        errors.append("M6a.json unreadable: %s" % e)

    # 6. derived indexes exist and are non-trivial
    for rel, floor in (("index-ja.json", 15000), ("index.json", 10000)):
        p = os.path.join(tcg, rel)
        try:
            n = len(_load(p))
            need(n >= floor, "%s has %d entries (expected >= %d)" % (rel, n, floor))
        except Exception as e:
            errors.append("%s unreadable: %s" % (rel, e))
    for rel in ("species-printings.json", "artist-stats.json"):
        p = os.path.join(ctx["data"], rel)
        need(os.path.isfile(p) and os.path.getsize(p) > 1000,
             "%s missing or tiny" % rel)

    # 7. JA pricing coverage must not have regressed vs HEAD
    def _coverage(rev):
        priced = total = 0
        files = []  # (readable path, git-relative path or None)
        if rev is None:
            for f in glob.glob(os.path.join(tcg, "sets", "ja", "*.json")):
                files.append((f, None))
        else:
            lst = subprocess.run(
                ["git", "ls-tree", "-r", "--name-only", rev, "data/tcgdex/sets/ja/"],
                cwd=REPO, capture_output=True, text=True).stdout.split()
            for f in lst:
                if f.endswith(".json"):
                    files.append((os.path.join(REPO, f), f))
        for absf, relf in files:
            try:
                if rev is None:
                    data = _load(absf)
                else:
                    r = subprocess.run(["git", "show", "%s:%s" % (rev, relf)],
                                       cwd=REPO, capture_output=True, text=True)
                    data = json.loads(r.stdout)
            except Exception:
                continue
            for c in data.get("cards", []):
                total += 1
                if (c.get("pricing") or {}).get("tcgplayer"):
                    priced += 1
        return priced, total
    priced, total = _coverage(None)
    old_priced, old_total = _coverage("HEAD")
    if total:
        log("JA pricing coverage: %d/%d (%.1f%%)" % (priced, total, 100.0 * priced / total))
    cov_err = _coverage_drop_error(priced, total, old_priced, old_total)
    if cov_err:
        errors.append(cov_err)

    # 8. index shrink vs HEAD
    def _head_len(rel):
        r = subprocess.run(["git", "show", "HEAD:" + rel], cwd=REPO,
                           capture_output=True, text=True)
        if r.returncode != 0:
            return None
        try:
            return len(json.loads(r.stdout))
        except ValueError:
            return None
    entries = []
    for rel in ("data/tcgdex/index.json", "data/tcgdex/index-ja.json"):
        try:
            n = len(_load(os.path.join(ctx["data"], "tcgdex", os.path.basename(rel))))
        except Exception:
            n = 0
        entries.append((rel, n, _head_len(rel)))
    errors.extend(_shrink_errors(entries))

    for w in warnings:
        log("SANITY WARNING: " + w)
    if errors:
        for e in errors:
            log("SANITY ERROR: " + e)
        raise StageError("%d sanity errors — refusing to promote" % len(errors))
    log("sanity ok (staging)")


def _git(*args):
    r = subprocess.run(["git"] + list(args), cwd=REPO, capture_output=True, text=True)
    if r.returncode != 0:
        raise StageError("git %s failed: %s" % (" ".join(args), r.stderr.strip()))
    return r.stdout.strip()


def stage_promote(ctx):
    """Copy verified staging outputs into the live tree, then drop the
    staging dir. Sanity already passed on staging — this is the only
    step that touches the live data/ tree."""
    copied = promote_outputs(ctx["staging"], os.path.join(REPO, "data"), ctx)
    log("promote: %d paths -> live tree" % len(copied))
    for rel in copied[:10]:
        log("  + %s" % rel)
    ctx["promoted"] = copied
    shutil.rmtree(ctx["staging"], ignore_errors=True)


def stage_commit(ctx):
    # Data-only staging. NEVER `git add -A`.
    run(["git", "add", "data/tcgdex", "data/species-printings.json",
         "data/artist-stats.json"])
    staged = _git("diff", "--cached", "--stat")
    if not staged.strip():
        log("nothing staged — catalog unchanged, skipping commit")
        ctx["no_changes"] = True
        return
    log("staged:\n" + staged)
    msg = "sharded catalog refresh %s shards %s (%d EN + %d JA sets)" % (
        datetime.now().strftime("%F"), ",".join(map(str, ctx["plan"])),
        len(ctx["targets"]["en"]), len(ctx["targets"]["ja"]))
    _git("commit", "-m", msg)
    log("committed: %s (%s)" % (_git("rev-parse", "--short", "HEAD"), msg))


def stage_push(ctx):
    if ctx.get("no_changes"):
        log("no new commit — skipping push")
        return
    if ctx.get("no_push"):
        log("--no-push: skipping push (commit stays local)")
        ctx["no_push_done"] = True
        return
    _git("pull", "--rebase")
    _git("push")
    log("pushed %s" % _git("rev-parse", "--short", "HEAD"))


def stage_verify(ctx):
    if ctx.get("no_changes") or ctx.get("no_push_done"):
        log("nothing pushed — skipping deploy verification")
        return
    try:
        want = {"sets.json": len(_set_ids(os.path.join(REPO, "data", "tcgdex", "sets.json"))),
                "sets-ja.json": len(_set_ids(os.path.join(REPO, "data", "tcgdex", "sets-ja.json")))}
    except Exception as e:
        raise StageError("cannot read local set lists: %s" % e)
    log("local counts: %s" % want)
    log("waiting ~3.5 min for the Vercel deploy…")
    time.sleep(210)
    for attempt in range(3):
        got = {}
        ok = True
        for name in want:
            r = subprocess.run(
                ["curl", "-sf", "--max-time", "40",
                 "%s/data/tcgdex/%s" % (PROD_BASE, name)],
                capture_output=True, text=True)
            if r.returncode != 0:
                # relay fallback (vercel.app is sinkholed on some workers)
                r = subprocess.run(
                    ["curl", "-sf", "--max-time", "40", "-x",
                     "http://127.0.0.1:8888",
                     "%s/data/tcgdex/%s" % (PROD_BASE, name)],
                    capture_output=True, text=True)
            try:
                got[name] = len(json.loads(r.stdout))
            except ValueError:
                ok = False
        if ok and all(got.get(k) == want[k] for k in want):
            log("deploy verified: production counts match %s" % got)
            return
        log("production not matching yet (got %s, want %s) — retrying" % (got, want))
        time.sleep(90)
    raise StageError("production counts never matched %s — deploy unverified" % want)


STAGE_FNS = {
    "preflight": stage_preflight,
    "setlists": stage_setlists,
    "select-targets": stage_select_targets,
    "snapshot": stage_snapshot,
    "30thc": stage_30thc,
    "enrich-ja": stage_enrich_ja,
    "backfill-ja": stage_backfill_ja,
    "m6a": stage_m6a,
    "indexes": stage_indexes,
    "tests": stage_tests,
    "sanity": stage_sanity,
    "promote": stage_promote,
    "commit": stage_commit,
    "push": stage_push,
    "verify": stage_verify,
}
STAGES = list(STAGE_FNS)


# ---------------------------------------------------------------- main

def main():
    global LOG_FILE
    ap = argparse.ArgumentParser(description="VaultDex sharded daily catalog refresh (hardened)")
    ap.add_argument("--shard", type=int, choices=list(range(NUM_SHARDS)),
                    help="run this shard instead of the work-queue selection")
    ap.add_argument("--max-shards", type=int, default=SHARDS_PER_RUN,
                    help="work-queue bound: max shards per run (default %d)"
                         % SHARDS_PER_RUN)
    ap.add_argument("--staging-dir", default=None,
                    help="staging dir (default %s)" % DEFAULT_STAGING)
    ap.add_argument("--hot-sets", default=None,
                    help="hot-sets.json path (default %s)" % HOT_SETS_PATH)
    ap.add_argument("--check-stale", action="store_true",
                    help="dead-man's switch: exit 2 when no shard succeeded "
                         "within --stale-days (no lock, no writes)")
    ap.add_argument("--stale-days", type=int, default=STALE_DAYS,
                    help="staleness threshold in days (default %d)" % STALE_DAYS)
    ap.add_argument("--dry-run", action="store_true",
                    help="print the plan and exit without network or writes")
    ap.add_argument("--no-push", action="store_true",
                    help="run through commit, skip push and deploy verification")
    ap.add_argument("--list-shards", action="store_true",
                    help="print the shard -> set-id assignment and exit")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)

    if args.check_stale:
        ok, msg = check_stale(load_state(), now, args.stale_days)
        print(msg)
        return 0 if ok else 2

    if args.list_shards:
        tcg = os.path.join(REPO, "data", "tcgdex")
        shards = build_shards(_set_ids(os.path.join(tcg, "sets.json")),
                              _set_ids(os.path.join(tcg, "sets-ja.json")))
        for n in range(NUM_SHARDS):
            s = shards[n]
            print("shard %d: %d EN + %d JA sets" % (n, len(s["en"]), len(s["ja"])))
        return 0

    os.makedirs(LOG_DIR, exist_ok=True)
    state = load_state()

    if args.shard is not None:
        plan, force_all, via = [args.shard], False, "manual --shard"
    else:
        queue = select_work_queue(state, now, max_shards=args.max_shards)
        forced = [n for n in queue if shard_full_sweep_due(state, n, now)]
        if forced:
            # 30-day backstop: one full shard per run and nothing else —
            # keeps even the worst-case run bounded.
            plan, force_all, via = forced[:1], True, "30-day full-sweep backstop"
        else:
            plan, force_all, via = queue, False, "work queue (stalest first)"

    # Shard universes for the plan preview come from the live set lists;
    # stage_setlists rebuilds them from the refreshed staging lists.
    tcg = os.path.join(REPO, "data", "tcgdex")
    shards = build_shards(_set_ids(os.path.join(tcg, "sets.json")),
                          _set_ids(os.path.join(tcg, "sets-ja.json")))
    print("plan: shard(s) %s via %s%s%s"
          % (plan, via, " [FORCED FULL]" if force_all else "",
             " [dry-run]" if args.dry_run else ""))
    for n in plan:
        s = shards[n]
        print("  shard %d: %d EN + %d JA" % (n, len(s["en"]), len(s["ja"])))
    if args.dry_run:
        return 0

    LOG_FILE = os.path.join(LOG_DIR, "shard-%s-s%s.log"
                            % (now.strftime("%F"), "".join(map(str, plan))))
    lock_fh = acquire_lock()

    staging = args.staging_dir or DEFAULT_STAGING
    seed_staging(os.path.join(REPO, "data"), staging)
    hot = load_hot_sets(args.hot_sets or HOT_SETS_PATH)
    log("staging: %s" % staging)
    log("hot sets: en=%s ja=%s" % (hot["en"], hot["ja"]))

    ctx = {"plan": plan, "force_all": force_all, "shards": shards,
           "staging": staging, "env": {"VAULTDEX_DATA_DIR": staging},
           "tcg": os.path.join(staging, "tcgdex"), "data": staging,
           "hot_ids": {"en": set(hot["en"]), "ja": set(hot["ja"])},
           "state": state, "no_push": args.no_push,
           "new_sets": {"en": [], "ja": []}, "failed_sets": [],
           "targets": {"en": [], "ja": []},
           "prefetched": {}, "new_fingerprints": {}}
    for n in plan:
        st = state["shards"].setdefault(str(n), {})
        st["last_attempt"] = now.isoformat()
        st["status"] = "running"
    save_state(state)

    stop = threading.Event()
    hb = threading.Thread(target=heartbeat_loop, args=(state, stop), daemon=True)
    hb.start()
    try:
        for stage in STAGES:
            log("=" * 60)
            log("STAGE %s" % stage)
            try:
                STAGE_FNS[stage](ctx)
            except StageError as e:
                for n in plan:
                    st = state["shards"][str(n)]
                    st["status"] = "failed"
                    st["error"] = str(e)
                save_state(state)
                log("STAGE %s FAILED: %s" % (stage, e))
                log("staging left at %s for forensics; live tree untouched"
                    % staging)
                return 1
            log("STAGE %s done" % stage)
        ok_now = datetime.now(timezone.utc).isoformat()
        for n in plan:
            st = state["shards"][str(n)]
            st["status"] = "ok"
            st["last_ok"] = ok_now
            st.pop("error", None)
            if force_all:
                st["last_full_ok"] = ok_now
            if ctx.get("failed_sets"):
                st["failed_sets"] = ctx["failed_sets"]
            else:
                st.pop("failed_sets", None)
        state.setdefault("fingerprints", {}).update(ctx["new_fingerprints"])
        # Prune fingerprints for sets that left the shard universes.
        universe = set()
        for n in range(NUM_SHARDS):
            universe.update("en:" + s for s in shards[n]["en"])
            universe.update("ja:" + s for s in shards[n]["ja"])
        fps = state["fingerprints"]
        for k in [k for k in fps if k not in universe]:
            del fps[k]
        save_state(state)
    finally:
        stop.set()
        try:
            os.close(lock_fh.fileno())
        except OSError:
            pass

    log("=" * 60)
    log("sharded refresh complete: shards %s" % plan)
    return 0


if __name__ == "__main__":
    sys.exit(main())
