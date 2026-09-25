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
    "30thc",
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


def _sets_dir(lang):
    return os.path.join(REPO, "data", "tcgdex", "sets", "ja" if lang == "ja" else "")


def _backup_dir(lang):
    return os.path.join(REPO, "data", ".refresh", "backup-" + lang)


def _force_refresh_set_files(lang):
    """Move per-set JSON to a backup dir so --all re-fetches everything.

    Files are MOVED, not deleted: a crash mid-snapshot can never leave the
    tree with missing set files. On entry, backup copies for currently
    missing sets are merged back first (recovers a previous crashed run);
    on snapshot-stage failure the caller restores the backup; on success
    the backup is dropped. (2026-09-25: --full used to os.remove() every
    file up front — a mid-run crash left the tree degraded.)"""
    d, backup = _sets_dir(lang), _backup_dir(lang)
    os.makedirs(backup, exist_ok=True)
    for f in glob.glob(os.path.join(backup, "*.json")):
        dest = os.path.join(d, os.path.basename(f))
        if not os.path.isfile(dest):
            os.rename(f, dest)
            log("recovered %s from previous backup" % os.path.basename(f))
    files = [f for f in glob.glob(os.path.join(d, "*.json")) if os.path.isfile(f)]
    for f in files:
        os.rename(f, os.path.join(backup, os.path.basename(f)))
    log("forced refresh: moved %d %s set files to backup" % (len(files), lang))
    return bool(files)


def _restore_backup(lang):
    """Put backup files back after a failed snapshot stage. Sets the
    snapshot already re-fetched are kept (backup copy dropped); missing
    ones are restored, so the tree is whole again."""
    d, backup = _sets_dir(lang), _backup_dir(lang)
    restored = kept = 0
    for f in glob.glob(os.path.join(backup, "*.json")):
        dest = os.path.join(d, os.path.basename(f))
        if os.path.isfile(dest):
            os.remove(f)
            kept += 1
        else:
            os.rename(f, dest)
            restored += 1
    log("backup restored: %d %s files back, %d already re-fetched" % (restored, lang, kept))


def _drop_backup(lang):
    backup = _backup_dir(lang)
    for f in glob.glob(os.path.join(backup, "*.json")):
        os.remove(f)
    log("backup dropped for %s" % lang)


def _snapshot_with_backup(lang, cmd):
    if _force_refresh_set_files(lang):
        try:
            run(cmd)
        except Exception:
            _restore_backup(lang)
            raise
        _drop_backup(lang)
    else:
        run(cmd)


def stage_snapshot_en(ctx):
    cmd = [sys.executable, "scripts/snapshot-tcgdex.py", "--all", "--workers", "2"]
    if ctx["full"]:
        _snapshot_with_backup("en", cmd)
    else:
        run(cmd)


def stage_30thc(ctx):
    # Cache-only re-vendor of EN 30th Anniversary card images (30th-c has no
    # TCGdex scans; 30th is missing 3 promo-numbered Mews). The EN snapshot
    # would otherwise wipe the vendored imageSmall/imageLarge on re-fetch.
    run([sys.executable, "scripts/build-30thc-pkmngg.py"])


def stage_snapshot_ja(ctx):
    cmd = [sys.executable, "scripts/snapshot-tcgdex.py", "--all", "--workers", "2", "--lang", "ja"]
    if ctx["full"]:
        _snapshot_with_backup("ja", cmd)
    else:
        run(cmd)


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


def _index_shrink_errors(entries):
    """Pure: entries are (rel_path, new_len, head_len) triples. Fail when a
    catalog index shrank more than 3% vs HEAD — absolute floors can't catch
    a provider returning truncated-but-above-floor data (2026-09-25 audit).
    Exported for unit tests."""
    errors = []
    for rel, n, old in entries:
        if old and n < old * 0.97:
            errors.append("%s shrank %d -> %d (>3%% vs HEAD)" % (rel, old, n))
    return errors


def _coverage_drop_error(priced, total, old_priced, old_total):
    """Pure: a >5-point JA pricing coverage drop vs HEAD is an error, not a
    warning — the backfill runs before the sanity gate, so a drop means it
    didn't complete. Exported for unit tests."""
    if total and old_total:
        cov_now, cov_old = 100.0 * priced / total, 100.0 * old_priced / old_total
        if cov_old - cov_now > 5:
            return ("JA pricing coverage dropped %.1f%% -> %.1f%% (>5 pts vs HEAD)"
                    % (cov_old, cov_now))
    return None


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
    old_priced, old_total = 0, 0
    if total:
        log("JA pricing coverage: %d/%d (%.1f%%)" % (priced, total, 100.0 * priced / total))
        old_priced, old_total = _coverage("HEAD")
        if old_total and priced < old_priced:
            warnings.append("JA pricing coverage regressed: %d < %d at HEAD" % (priced, old_priced))

    for w in warnings:
        log("SANITY WARNING: " + w)

    # 8. relative regression bounds vs HEAD. Absolute floors (checks 3+6)
    # can't catch a provider returning truncated-but-above-floor data, so
    # fail when the catalog shrinks materially against the last commit.
    # (2026-09-25 audit: a degraded-but-above-floor snapshot would previously
    # commit and auto-deploy.)
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
            n = len(_load(os.path.join(REPO, rel)))
        except Exception:
            n = 0
        old = _head_len(rel)
        if old:
            log("%s: %d entries (HEAD: %d)" % (rel, n, old))
        entries.append((rel, n, old))
    errors.extend(_index_shrink_errors(entries))

    # 9. JA pricing coverage: a >5-point drop vs HEAD is an error, not a
    # warning — the backfill runs before this gate, so a drop means it
    # didn't complete (previously advisory-only).
    cov_err = _coverage_drop_error(priced, total, old_priced, old_total)
    if cov_err:
        errors.append(cov_err)

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


def _curl_json(url):
    """GET url, parse JSON. Falls back to the local egress relay when direct
    DNS fails (vercel.app is sinkholed on some workers — 2026-09-25 audit)."""
    for proxy in (None, "http://127.0.0.1:8888"):
        cmd = ["curl", "-sf", "--max-time", "40", url]
        if proxy:
            cmd[1:1] = ["-x", proxy]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            continue
        try:
            return json.loads(r.stdout)
        except ValueError:
            continue  # block page or truncated body — try the next route
    return None


def _prod_counts():
    out = {}
    for name in ("sets.json", "sets-ja.json"):
        data = _curl_json("%s/data/tcgdex/%s" % (PROD_BASE, name))
        if not isinstance(data, list):
            return None
        out[name] = len(data)
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
    "30thc": stage_30thc,
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
                    help="force re-fetch: move per-set JSON to a backup dir before each snapshot (restored on failure)")
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
