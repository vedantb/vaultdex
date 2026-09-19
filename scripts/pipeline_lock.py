"""VaultDex pipeline lock — advisory mutex for catalog writers.

Several scripts read-modify-write the same JSON catalog files
(data/tcgdex/sets/*.json, data/tcgdex/sets/ja/*.json). Running two of them
at once (e.g. ja-rarity-correct.py while ja-price-backfill.py is mid-run)
silently clobbers the other's writes. Every script that writes set files
must hold this lock around its main():

    from pipeline_lock import pipeline_lock
    def main():
        with pipeline_lock("ja-price-backfill"):
            ...do the work...

The lock is a file in the OS temp dir (never committed). Acquisition is
atomic (O_CREAT|O_EXCL). A lock older than STALE_AFTER is treated as
orphaned (crashed run) and reclaimed. Otherwise we wait up to WAIT_TIMEOUT
for it to release, then give up with exit code 2 instead of running blind.
"""
import errno
import os
import sys
import tempfile
import time

LOCK_PATH = os.path.join(tempfile.gettempdir(), "vaultdex-pipeline.lock")
STALE_AFTER = 6 * 3600      # a lock this old is from a crashed run
WAIT_TIMEOUT = 15 * 60      # give up waiting after 15 minutes
POLL_EVERY = 5


def _lock_age():
    try:
        return time.time() - os.stat(LOCK_PATH).st_mtime
    except OSError:
        return None


def _try_acquire(owner):
    """Attempt one atomic acquisition. Returns True on success."""
    try:
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except OSError as e:
        if e.errno != errno.EEXIST:
            raise
        return False
    with os.fdopen(fd, "w") as f:
        f.write("%s pid=%d started=%s\n" % (owner, os.getpid(),
                                           time.strftime("%Y-%m-%d %H:%M:%S")))
    return True


def acquire(owner="pipeline", wait_timeout=WAIT_TIMEOUT):
    """Block until the lock is held, reclaiming stale locks. Exits(2) on timeout."""
    if _try_acquire(owner):
        return
    age = _lock_age()
    if age is not None and age > STALE_AFTER:
        print("pipeline_lock: reclaiming stale lock (age %ds > %ds)" %
              (age, STALE_AFTER), file=sys.stderr)
        try:
            os.unlink(LOCK_PATH)
        except OSError:
            pass
        if _try_acquire(owner):
            return
    deadline = time.time() + wait_timeout
    print("pipeline_lock: waiting for lock held by another pipeline job "
          "(%s)..." % LOCK_PATH, file=sys.stderr)
    while time.time() < deadline:
        time.sleep(POLL_EVERY)
        if _try_acquire(owner):
            return
    print("pipeline_lock: timed out after %ds waiting for %s — "
          "another pipeline writer is still running. Not starting." %
          (wait_timeout, LOCK_PATH), file=sys.stderr)
    sys.exit(2)


def release():
    try:
        os.unlink(LOCK_PATH)
    except OSError:
        pass


class pipeline_lock:
    """Context manager: with pipeline_lock("my-script"): ..."""

    def __init__(self, owner="pipeline", wait_timeout=WAIT_TIMEOUT):
        self.owner = owner
        self.wait_timeout = wait_timeout

    def __enter__(self):
        acquire(self.owner, self.wait_timeout)
        return self

    def __exit__(self, exc_type, exc, tb):
        release()
        return False
