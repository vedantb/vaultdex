#!/usr/bin/env python3
"""Weekly VaultDex catalog refresh orchestrator.

Runs the full refresh pipeline as a sequence of resumable stages, with:
  - an exclusive lockfile (two drivers can never run at once),
  - a state file recording per-stage status (a fresh driver resumes,
    never restarts or collides),
  - a heartbeat so a stalled run is detectable,
  - a pre-commit sanity gate (no more partial-catalog commits),
  - data-only git staging (never `git add -A`).

Usage:
  python3 scripts/weekly-refresh.py --full        # weekly cron: force re-fetch
  python3 scripts/weekly-refresh.py               # resumable incremental run
  python3 scripts/weekly-refresh.py --from backfill-ja
  python3 scripts/weekly-refresh.py --only sanity
  python3 scripts/weekly-refresh.py --list-stages
  python3 scripts/weekly-refresh.py --no-push     # run through commit, skip push+verify

Exit codes: 0 = complete, 1 = stage failed (see log), 2 = another driver holds the lock.
"""
import argparse
import fcntl
import glob
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFRESH_DIR = os.path.join(REPO, "data", ".refresh")
STATE_PATH = os.path.join(REFRESH_DIR, "state.json")
LOCK_PATH = os.path.join(REFRESH_DIR, "lock")
LOG_DIR = os.path.expanduser("~/workspace/goals/vaultdex-weekly-catalog-refresh/hidden_files")
PROXY_SECRET = os.path.expanduser("~/workspace/.secrets/vaultdex-proxy-key")
PROD_BASE = "https://vaultdex-three.vercel.app"

STAGES = [
    "preflight",
    "snapshot-en",
    "snapshot-ja",
    "enrich-ja",
    "backfill-ja",
    "m6a",
    "indexes",
    "tests",
    "sanity",
    "commit",
    "push",
    "verify",
]


def log(msg):
    line = "[%s] %s" % (datetime.now().strftime("%H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def run(cmd, cwd=REPO, check=True):
    """Run a command, streaming output to stdout and the log file."""
    log("$ " + (" ".join(cmd) if isinstance(cmd, list) else cmd))
    p = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, shell=isinstance(cmd, str),
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


# ---------------------------------------------------------------- state/lock

def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"run_id": None, "stages": {}, "heartbeat": None}


def save_state(state):
    os.makedirs(REFRESH_DIR, exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def acquire_lock():
    os.makedirs(REFRESH_DIR, exist_ok=True)
    fh = open(LOCK_PATH, "a+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.seek(0)
        holder = fh.read().strip() or "unknown"
        print("another refresh driver holds the lock (%s) — exiting" % holder, file=sys.stderr)
        sys.exit(2)
    fh.seek(0)
    fh.truncate()
    fh.write("pid=%d started=%s" % (os.getpid(), datetime.now(timezone.utc).isoformat()))
    fh.flush()
    return fh  # keep open: lock releases on close/exit


def heartbeat_loop(state, stop):
    while not stop.wait(300):
        state["heartbeat"] = datetime.now(timezone.utc).isoformat()
        save_state(state)
        log("heartbeat: still running")


# ---------------------------------------------------------------- stages

def stage_preflight(ctx):
    # TCGdex must be reachable or we must not push anything.
    r = subprocess.run(
        ["curl", "-sf", "--max-time", "25", "https://api.tcgdex.net/v2/en/sets", "-o", "/dev/null"],
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
    log("preflight ok: tcgdex reachable, proxy secret present, node/npx present")


def _force_refresh_set_files(lang):
    """Delete per-set JSON so --all re-fetches everything (weekly full refresh)."""
    d = os.path.join(REPO, "data", "tcgdex", "sets", "ja" if lang == "ja" else "")
    files = [f for f in glob.glob(os.path.join(d, "*.json")) if os.path.isfile(f)]
    for f in files:
        os.remove(f)
    log("forced refresh: removed %d %s set files" % (len(files), lang))


def stage_snapshot_en(ctx):
    if ctx["full"]:
        _force_refresh_set_files("en")
    run([sys.executable, "scripts/snapshot-tcgdex.py", "--all", "--workers", "2"])


def stage_snapshot_ja(ctx):
    if ctx["full"]:
        _force_refresh_set_files("ja")
    run([sys.executable, "scripts/snapshot-tcgdex.py", "--all", "--workers", "2", "--lang", "ja"])


def stage_enrich_ja(ctx):
    run([sys.executable, "scripts/ja-pkmn-enrich.py", "--resume"])
    run([sys.executable, "scripts/ja-pkmn-build-cards.py"])


def stage_backfill_ja(ctx):
    run([sys.executable, "scripts/ja-price-backfill.py"])


def stage_m6a(ctx):
    # Cache-only rebuild of the JP 30th Celebration set (173 cards).
    # NEVER re-run pull-pkmngg-m6a.py (one-time third-party pull).
    run([sys.executable, "scripts/build-m6a-pkmngg.py"])


def stage_indexes(ctx):
    run([sys.executable, "scripts/build-ja-search-index.py"])
    run(["node", "scripts/build-species-printings.js"])
    run(["node", "scripts/build-artist-stats.js"])


def stage_tests(ctx):
    run(["npx", "vitest", "run"])
    run([sys.executable, "scripts/tests/test_pipeline.py"])

def _load(p):
    with open(p) as f:
        return json.load(f)


def stage_sanity(ctx):
    """Pre-commit gate: structural checks fail the run; advisories only warn."""
    errors, warnings = [], []
    tcg = os.path.join(REPO, "data", "tcgdex")

    def need(cond, msg):
        if not cond:
            errors.append(msg)

    # 1. every set file parses
    bad = []
    en_files = sorted(glob.glob(os.path.join(tcg, "sets", "*.json")))
    ja_files = sorted(glob.glob(os.path.join(tcg, "sets", "ja", "*.json")))
    for f in en_files + ja_files:
        try:
            _load(f)
        except Exception as e:
            bad.append("%s (%s)" % (os.path.basename(f), e))
    need(not bad, "unparseable set files: %s" % bad[:5])

    # 2. no leftover temp files from crashed atomic writes
    tmps = glob.glob(os.path.join(tcg, "**", "*.tmp"), recursive=True)
    need(not tmps, "leftover .tmp files: %s" % tmps[:5])

    # 3. set-list counts within sane floors
    try:
        en_n = len(_load(os.path.join(tcg, "sets.json")))
    except Exception:
        en_n = 0
    try:
        ja_n = len(_load(os.path.join(tcg, "sets-ja.json")))
    except Exception:
        ja_n = 0
    need(en_n >= 200, "sets.json has only %d sets (expected >= 200)" % en_n)
    need(ja_n >= 180, "sets-ja.json has only %d sets (expected >= 180)" % ja_n)
    log("counts: EN sets=%d files=%d | JA sets=%d files=%d" % (en_n, len(en_files), ja_n, len(ja_files)))

    # 4. manifests prove both snapshots completed
    for m in ("manifest.json", "manifest-ja.json"):
        need(os.path.isfile(os.path.join(tcg, m)), "missing %s (snapshot did not finish)" % m)

    # 5. M6a (JP 30th) present with the full 173-card checklist
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
        p = os.path.join(REPO, "data", rel)
        need(os.path.isfile(p) and os.path.getsize(p) > 1000, "%s missing or tiny" % rel)

    # 7. advisory: JA pricing coverage must not have regressed vs the last
    # committed refresh (warn only — some cards legitimately lack listings).
    # The backfill runs before this gate, so a drop means it didn't complete.
    def _coverage(rev):
        priced = total = 0
        if rev is None:
            files = ja_files
        else:
            lst = subprocess.run(
                ["git", "ls-tree", "-r", "--name-only", rev, "data/tcgdex/sets/ja/"],
                capture_output=True, text=True).stdout.split()
            files = [f for f in lst if f.endswith(".json")]
        for f in files:
            try:
                if rev is None:
                    data = _load(f)
                else:
                    r = subprocess.run(["git", "show", "%s:%s" % (rev, f)],
                                       capture_output=True, text=True)
                    data = json.loads(r.stdout)
            except Exception:
                continue
            for c in data.get("cards", []):
                total += 1
                if (c.get("pricing") or {}).get("tcgplayer"):
                    priced += 1
        return priced, total
    priced, total = _coverage(None)
    if total:
        log("JA pricing coverage: %d/%d (%.1f%%)" % (priced, total, 100.0 * priced / total))
        old_priced, old_total = _coverage("HEAD")
        if old_total and priced < old_priced:
            warnings.append("JA pricing coverage regressed: %d < %d at HEAD" % (priced, old_priced))

    for w in warnings:
        log("SANITY WARNING: " + w)
    if errors:
        for e in errors:
            log("SANITY ERROR: " + e)
        raise StageError("%d sanity errors — refusing to commit" % len(errors))
    log("sanity ok")


def _git(*args):
    r = subprocess.run(["git"] + list(args), cwd=REPO, capture_output=True, text=True)
    if r.returncode != 0:
        raise StageError("git %s failed: %s" % (" ".join(args), r.stderr.strip()))
    return r.stdout.strip()


def stage_commit(ctx):
    # Data-only staging. NEVER `git add -A`: a concurrent worker may have
    # unrelated changes in the tree, and partial runs must never be swept in.
    run(["git", "add", "data/tcgdex", "data/species-printings.json", "data/artist-stats.json"])
    staged = _git("diff", "--cached", "--stat")
    if not staged.strip():
        log("nothing staged — catalog unchanged, skipping commit")
        ctx["no_changes"] = True
        return
    log("staged:\n" + staged)
    msg = "weekly catalog refresh %s" % datetime.now().strftime("%F")
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


def _prod_counts():
    out = {}
    for name in ("sets.json", "sets-ja.json"):
        r = subprocess.run(
            ["curl", "-sf", "--max-time", "40", "%s/data/tcgdex/%s" % (PROD_BASE, name)],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            return None
        try:
            out[name] = len(json.loads(r.stdout))
        except ValueError:
            return None  # block page or truncated body, not real JSON
    return out


def stage_verify(ctx):
    if ctx.get("no_changes") or ctx.get("no_push_done"):
        log("nothing pushed — skipping deploy verification")
        return
    try:
        want = {"sets.json": len(_load(os.path.join(REPO, "data", "tcgdex", "sets.json"))),
                "sets-ja.json": len(_load(os.path.join(REPO, "data", "tcgdex", "sets-ja.json")))}
    except Exception as e:
        raise StageError("cannot read local set lists: %s" % e)
    log("local counts: %s" % want)
    log("waiting ~3.5 min for the Vercel deploy…")
    time.sleep(210)
    for attempt in range(3):
        got = _prod_counts()
        if got and all(got[k] == want[k] for k in want):
            log("deploy verified: production counts match %s" % got)
            return
        log("production not matching yet (got %s, want %s) — retrying" % (got, want))
        time.sleep(90)
    raise StageError("production counts never matched %s — deploy unverified" % want)


STAGE_FNS = {
    "preflight": stage_preflight,
    "snapshot-en": stage_snapshot_en,
    "snapshot-ja": stage_snapshot_ja,
    "enrich-ja": stage_enrich_ja,
    "backfill-ja": stage_backfill_ja,
    "m6a": stage_m6a,
    "indexes": stage_indexes,
    "tests": stage_tests,
    "sanity": stage_sanity,
    "commit": stage_commit,
    "push": stage_push,
    "verify": stage_verify,
}


# ---------------------------------------------------------------- main

def main():
    global LOG_FILE
    ap = argparse.ArgumentParser(description="VaultDex weekly catalog refresh orchestrator")
    ap.add_argument("--full", action="store_true",
                    help="force re-fetch: delete per-set JSON before each snapshot")
    ap.add_argument("--from", dest="from_stage", choices=STAGES,
                    help="resume from this stage (earlier done stages are kept)")
    ap.add_argument("--only", dest="only_stage", choices=STAGES,
                    help="run exactly this stage")
    ap.add_argument("--force", action="store_true",
                    help="re-run all stages even if marked done")
    ap.add_argument("--no-push", action="store_true",
                    help="run through commit, skip push and deploy verification")
    ap.add_argument("--list-stages", action="store_true")
    args = ap.parse_args()

    if args.list_stages:
        print("\n".join(STAGES))
        return 0

    os.makedirs(LOG_DIR, exist_ok=True)
    LOG_FILE = os.path.join(LOG_DIR, "refresh-%s.log" % datetime.now().strftime("%F"))
    lock_fh = acquire_lock()

    ctx = {"full": args.full, "no_push": args.no_push}
    run_id = datetime.now().strftime("%F")
    state = load_state()
    if args.force or state.get("run_id") != run_id:
        state = {"run_id": run_id, "stages": {}, "heartbeat": None}
    save_state(state)

    if args.only_stage:
        plan = [args.only_stage]
    elif args.from_stage:
        plan = STAGES[STAGES.index(args.from_stage):]
    else:
        plan = [s for s in STAGES if state["stages"].get(s, {}).get("status") != "done"]
    if not plan:
        log("all stages already done for %s — nothing to do" % run_id)
        return 0
    log("plan: %s (full=%s)" % (" -> ".join(plan), args.full))

    stop = threading.Event()
    hb = threading.Thread(target=heartbeat_loop, args=(state, stop), daemon=True)
    hb.start()
    try:
        for stage in plan:
            st = state["stages"].setdefault(stage, {})
            st["status"] = "running"
            st["started_at"] = datetime.now(timezone.utc).isoformat()
            save_state(state)
            log("=" * 60)
            log("STAGE %s" % stage)
            try:
                STAGE_FNS[stage](ctx)
            except StageError as e:
                st["status"] = "failed"
                st["ended_at"] = datetime.now(timezone.utc).isoformat()
                st["error"] = str(e)
                save_state(state)
                log("STAGE %s FAILED: %s" % (stage, e))
                log("re-run with: python3 scripts/weekly-refresh.py --from %s" % stage)
                return 1
            st["status"] = "done"
            st["ended_at"] = datetime.now(timezone.utc).isoformat()
            save_state(state)
            log("STAGE %s done" % stage)
    finally:
        stop.set()
        try:
            os.close(lock_fh.fileno())
        except OSError:
            pass

    log("=" * 60)
    log("refresh complete: %s" % _git("rev-parse", "--short", "HEAD"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
