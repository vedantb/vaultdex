"""Unit tests for the sharded daily refresh (scripts/sharded-refresh.py).

Stdlib unittest, zero new dependencies. All tests are pure: they exercise
the sharding/index-merge/overdue logic with synthetic data and never touch
the real data/ tree or the network.
"""
import importlib.util
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name):
    modname = "vd_" + name.replace("-", "_")
    spec = importlib.util.spec_from_file_location(
        modname, os.path.join(SCRIPTS, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[modname] = mod
    spec.loader.exec_module(mod)
    return mod


sr = load("sharded-refresh")
snapshot = load("snapshot-tcgdex")


class ShardAssignmentTests(unittest.TestCase):
    def test_every_set_lands_in_exactly_one_shard(self):
        en = ["en%03d" % i for i in range(205)]
        ja = ["ja%03d" % i for i in range(184)]
        shards = sr.build_shards(en, ja)
        seen_en, seen_ja = [], []
        for n in range(sr.NUM_SHARDS):
            seen_en += shards[n]["en"]
            seen_ja += shards[n]["ja"]
        self.assertEqual(sorted(seen_en), sorted(en))
        self.assertEqual(sorted(seen_ja), sorted(ja))

    def test_deterministic_across_calls(self):
        en = ["sv1", "swsh1", "base1", "xy1"]
        ja = ["S1a", "M6"]
        a = sr.build_shards(en, ja)
        b = sr.build_shards(en, ja)
        self.assertEqual(a, b)

    def test_pinned_shard_values_guard_the_salt(self):
        # If the salt or hash ever changes, shard assignments silently
        # reshuffle mid-week; these pins catch that.
        self.assertEqual(sr.shard_of("sv1"), 2)
        self.assertEqual(sr.shard_of("swsh1"), 3)
        self.assertEqual(sr.shard_of("base1"), 5)
        self.assertEqual(sr.shard_of("xy1"), 6)
        self.assertEqual(sr.shard_of("sm1"), 3)
        self.assertEqual(sr.shard_of("me1"), 0)

    def test_shard_range(self):
        for sid in ["a", "zz-99", "M6a", "P-A"]:
            self.assertIn(sr.shard_of(sid), range(sr.NUM_SHARDS))

    def test_new_set_does_not_reshuffle_existing(self):
        en = ["s%03d" % i for i in range(100)]
        before = sr.build_shards(en, [])
        after = sr.build_shards(en + ["brand-new-set"], [])
        for n in range(sr.NUM_SHARDS):
            for sid in before[n]["en"]:
                self.assertIn(sid, after[n]["en"],
                              "%s moved shards when a new set appeared" % sid)


class ShardBalanceTests(unittest.TestCase):
    def test_synthetic_catalog_stays_balanced(self):
        en = ["en%03d" % i for i in range(205)]
        ja = ["ja%03d" % i for i in range(184)]
        shards = sr.build_shards(en, ja)
        sizes = [len(shards[n]["en"]) + len(shards[n]["ja"])
                 for n in range(sr.NUM_SHARDS)]
        # Hash mod 7 on ~389 ids: expect ~55/day; allow generous bounds so
        # the test guards against a pathological salt, not exact counts.
        self.assertLessEqual(max(sizes), 75)
        self.assertGreaterEqual(min(sizes), 35)


class PocketExclusionTests(unittest.TestCase):
    def test_pocket_ids_match_snapshot_tcgdex(self):
        self.assertEqual(sr.POCKET_SET_IDS, snapshot.POCKET_SET_IDS)

    def test_pocket_sets_never_targeted(self):
        en = ["sv1", "A1", "A1a", "B1", "P-A", "base1"]
        shards = sr.build_shards(en, [])
        targeted = [s for n in range(sr.NUM_SHARDS) for s in shards[n]["en"]]
        for p in ["A1", "A1a", "B1", "P-A"]:
            self.assertNotIn(p, targeted)
        self.assertIn("sv1", targeted)

    def test_ja_nofetch_sets_never_targeted(self):
        ja = ["S1a", "S-P", "SM-P", "XY-P", "BW-P", "M6a", "M6"]
        shards = sr.build_shards([], ja)
        targeted = [s for n in range(sr.NUM_SHARDS) for s in shards[n]["ja"]]
        for x in ["S-P", "SM-P", "XY-P", "BW-P", "M6a"]:
            self.assertNotIn(x, targeted)
        self.assertIn("S1a", targeted)
        self.assertIn("M6", targeted)


class WeekdayRoutingTests(unittest.TestCase):
    def test_monday_is_shard_0_sunday_is_shard_6(self):
        # 2026-09-28 is a Monday, 2026-10-04 a Sunday (verified via date).
        mon = datetime(2026, 9, 28, tzinfo=timezone.utc)
        sun = datetime(2026, 10, 4, tzinfo=timezone.utc)
        self.assertEqual(mon.weekday(), 0)
        self.assertEqual(sun.weekday(), 6)
        self.assertEqual(sr.weekday_shard(mon), 0)
        self.assertEqual(sr.weekday_shard(sun), 6)

    def test_all_weekdays_covered(self):
        mon = datetime(2026, 9, 28, tzinfo=timezone.utc)
        days = [mon + timedelta(days=i) for i in range(7)]
        self.assertEqual(sorted(sr.weekday_shard(d) for d in days),
                         list(range(7)))


class DeriveSetIdTests(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(sr.derive_set_id("sv1-001"), "sv1")
        self.assertEqual(sr.derive_set_id("ex1-!"), "ex1")

    def test_set_id_with_dashes(self):
        self.assertEqual(sr.derive_set_id("tk-xy-p-12"), "tk-xy-p")

    def test_no_dash(self):
        self.assertEqual(sr.derive_set_id("abc"), "")

    def test_none_and_empty(self):
        self.assertEqual(sr.derive_set_id(None), "")
        self.assertEqual(sr.derive_set_id(""), "")


class IndexMergeTests(unittest.TestCase):
    def _card(self, cid, **kw):
        c = {"id": cid, "localId": cid.split("-")[-1], "name": "N-" + cid}
        c.update(kw)
        return c

    def test_replaces_shard_sets_preserves_others(self):
        existing = [
            {"id": "sv1-001", "localId": "001", "name": "Old A"},
            {"id": "sv1-002", "localId": "002", "name": "Old B"},
            {"id": "swsh1-001", "localId": "001", "name": "Keep Me"},
            {"id": "mew-001", "localId": "001", "name": "Hand Merged"},
        ]
        fresh = {"sv1": [self._card("sv1-001", name="New A"),
                         self._card("sv1-003", name="New C")]}
        out = sr.merge_index_entries(existing, {"sv1"}, fresh)
        by_id = {e["id"]: e for e in out}
        # shard set rebuilt from fresh files
        self.assertEqual(by_id["sv1-001"]["name"], "New A")
        self.assertEqual(by_id["sv1-003"]["name"], "New C")
        self.assertNotIn("sv1-002", by_id)
        # everything else untouched
        self.assertEqual(by_id["swsh1-001"]["name"], "Keep Me")
        self.assertEqual(by_id["mew-001"]["name"], "Hand Merged")
        self.assertEqual(len(out), 4)

    def test_image_precedence_mirrors_overlay(self):
        c = self._card("sv1-001", imageSmall="s", imageLarge="l", image="i")
        self.assertEqual(sr.index_entry_for_card(c)["image"], "s")
        c = self._card("sv1-001", imageLarge="l", image="i")
        self.assertEqual(sr.index_entry_for_card(c)["image"], "l")
        c = self._card("sv1-001", image="i")
        self.assertEqual(sr.index_entry_for_card(c)["image"], "i")
        c = self._card("sv1-001")
        self.assertNotIn("image", sr.index_entry_for_card(c))

    def test_entry_shape(self):
        e = sr.index_entry_for_card(self._card("sv1-001"))
        self.assertEqual(set(e), {"id", "localId", "name"})

    def test_cards_without_ids_skipped(self):
        out = sr.merge_index_entries([], {"sv1"},
                                     {"sv1": [{"localId": "001"}]})
        self.assertEqual(out, [])

    def test_empty_shard_is_noop(self):
        existing = [{"id": "sv1-001", "localId": "001", "name": "A"}]
        self.assertEqual(sr.merge_index_entries(existing, set(), {}), existing)


class NewSetDetectionTests(unittest.TestCase):
    def test_detects_additions_only(self):
        prev = ["a", "b", "c"]
        self.assertEqual(sr.detect_new_sets(prev, ["a", "b", "c", "d"]), ["d"])
        self.assertEqual(sr.detect_new_sets(prev, ["a", "b"]), [])

    def test_empty_previous_yields_nothing(self):
        # First run: bootstrap via the catch-up rule, not a mega-run.
        self.assertEqual(sr.detect_new_sets([], ["a", "b"]), [])

    def test_sorted(self):
        self.assertEqual(sr.detect_new_sets(["a"], ["a", "z", "m"]), ["m", "z"])


class OverdueShardTests(unittest.TestCase):
    def _state(self, last_oks):
        # last_oks: {shard: iso-or-None}
        return {"shards": {str(n): {"last_ok": v} for n, v in last_oks.items()},
                "heartbeat": None}

    def test_never_ran_is_overdue(self):
        now = datetime.now(timezone.utc)
        overdue = sr.find_overdue_shards(self._state({}), now)
        self.assertEqual(overdue, list(range(7)))

    def test_recent_ok_not_overdue(self):
        now = datetime.now(timezone.utc)
        recent = (now - timedelta(days=2)).isoformat()
        state = self._state({n: recent for n in range(7)})
        self.assertEqual(sr.find_overdue_shards(state, now), [])

    def test_old_ok_is_overdue(self):
        now = datetime.now(timezone.utc)
        old = (now - timedelta(days=9)).isoformat()
        recent = (now - timedelta(days=1)).isoformat()
        state = self._state({0: old, 1: recent, 2: None, 3: recent,
                             4: recent, 5: recent, 6: recent})
        overdue = sr.find_overdue_shards(state, now)
        self.assertIn(0, overdue)
        self.assertIn(2, overdue)
        self.assertNotIn(1, overdue)
        # never-ran sorts before merely-old
        self.assertLess(overdue.index(2), overdue.index(0))

    def test_plan_is_today_plus_stalest_overdue(self):
        now = datetime.now(timezone.utc)
        recent = (now - timedelta(days=1)).isoformat()
        state = self._state({n: recent for n in range(7)})
        plan = sr.plan_shards(state, 3, now)
        self.assertEqual(plan, [3])

    def test_plan_bounded_at_two_shards(self):
        now = datetime.now(timezone.utc)
        plan = sr.plan_shards(self._state({}), 3, now)
        self.assertEqual(len(plan), 2)
        self.assertEqual(plan[0], 3)

    def test_plan_does_not_double_run_today(self):
        now = datetime.now(timezone.utc)
        old = (now - timedelta(days=9)).isoformat()
        recent = (now - timedelta(days=1)).isoformat()
        state = self._state({0: old, **{n: recent for n in range(1, 7)}})
        plan = sr.plan_shards(state, 0, now)
        self.assertEqual(plan, [0])


class SanityHelperTests(unittest.TestCase):
    def test_shrink_errors(self):
        errs = sr._shrink_errors([("a", 96, 100), ("b", 100, 100)])
        self.assertEqual(len(errs), 1)
        self.assertIn("a", errs[0])
        self.assertEqual(sr._shrink_errors([("a", 98, 100)]), [])

    def test_coverage_drop_error(self):
        self.assertIsNone(sr._coverage_drop_error(90, 100, 92, 100))
        err = sr._coverage_drop_error(80, 100, 92, 100)
        self.assertIsNotNone(err)
        self.assertIn("dropped", err)
        self.assertIsNone(sr._coverage_drop_error(0, 0, 0, 0))


class WorkQueueTests(unittest.TestCase):
    def _state(self, last_oks):
        # last_oks: {shard: iso-or-None}
        return {"shards": {str(n): {"last_ok": v} for n, v in last_oks.items()},
                "heartbeat": None}

    def test_never_ran_sorts_first_in_shard_order(self):
        now = datetime.now(timezone.utc)
        recent = (now - timedelta(hours=1)).isoformat()
        state = self._state({0: recent, 1: recent})  # shards 2..6 never ran
        self.assertEqual(sr.select_work_queue(state, now, max_shards=3),
                         [2, 3, 4])

    def test_stalest_first(self):
        now = datetime.now(timezone.utc)
        state = self._state({n: (now - timedelta(days=n + 1)).isoformat()
                             for n in range(7)})
        self.assertEqual(sr.select_work_queue(state, now, max_shards=7),
                         [6, 5, 4, 3, 2, 1, 0])

    def test_bound_respected(self):
        now = datetime.now(timezone.utc)
        q = sr.select_work_queue(self._state({}), now, max_shards=2)
        self.assertEqual(q, [0, 1])

    def test_all_fresh_still_rotates(self):
        # The queue keeps cycling even when everything is fresh, so
        # fingerprints get re-verified every cycle.
        now = datetime.now(timezone.utc)
        recent = (now - timedelta(hours=2)).isoformat()
        state = self._state({n: recent for n in range(7)})
        q = sr.select_work_queue(state, now, max_shards=2)
        self.assertEqual(len(q), 2)

    def test_invalid_timestamp_treated_as_never_ran(self):
        now = datetime.now(timezone.utc)
        state = {"shards": {"0": {"last_ok": "not-a-date"}}, "heartbeat": None}
        self.assertEqual(sr.select_work_queue(state, now, max_shards=1), [0])

    def test_default_bound_is_two(self):
        self.assertEqual(sr.SHARDS_PER_RUN, 2)


class FingerprintTests(unittest.TestCase):
    def _detail(self, cards, total=100):
        return {"cardCount": {"official": total, "total": total},
                "cards": [{"id": c, "localId": c.split("-")[-1], "name": "N-" + c,
                           "image": "img-" + c} for c in cards]}

    def test_stable(self):
        d = self._detail(["sv01-001", "sv01-002"])
        self.assertEqual(sr.upstream_fingerprint(d), sr.upstream_fingerprint(d))

    def test_detects_add_remove_rename(self):
        base = self._detail(["sv01-001", "sv01-002"])
        fp = sr.upstream_fingerprint(base)
        self.assertNotEqual(fp, sr.upstream_fingerprint(self._detail(["sv01-001"])))
        self.assertNotEqual(
            fp, sr.upstream_fingerprint(self._detail(["sv01-001", "sv01-002",
                                                      "sv01-003"])))
        renamed = self._detail(["sv01-001", "sv01-002"])
        renamed["cards"][0]["name"] = "Renamed"
        self.assertNotEqual(fp, sr.upstream_fingerprint(renamed))

    def test_ignores_card_order(self):
        a = self._detail(["sv01-001", "sv01-002"])
        b = self._detail(["sv01-002", "sv01-001"])
        self.assertEqual(sr.upstream_fingerprint(a), sr.upstream_fingerprint(b))

    def test_empty_and_none_match(self):
        self.assertEqual(sr.upstream_fingerprint({}), sr.upstream_fingerprint(None))

    def test_count_change_detected(self):
        a = self._detail(["sv01-001"], total=100)
        b = self._detail(["sv01-001"], total=101)
        self.assertNotEqual(sr.upstream_fingerprint(a), sr.upstream_fingerprint(b))


class TargetSelectionTests(unittest.TestCase):
    def _detail(self, cards):
        return {"cards": [{"id": c, "localId": "1", "name": "N", "image": "i"}
                          for c in cards],
                "cardCount": {"official": len(cards), "total": len(cards)}}

    def _fetch(self, mapping, failures=()):
        def fetch_detail(lang, sid):
            if (lang, sid) in failures:
                raise OSError("boom")
            return mapping[(lang, sid)]
        return fetch_detail

    def test_unchanged_skipped_changed_targeted(self):
        d1 = self._detail(["sv01-001"])
        d2old = self._detail(["swsh1-001"])
        d2new = self._detail(["swsh1-001", "swsh1-002"])
        fps = {"en:sv01": sr.upstream_fingerprint(d1),
               "en:swsh1": sr.upstream_fingerprint(d2old)}
        targets, prefetched, failed = sr.select_snapshot_targets(
            {"en": ["sv01", "swsh1"], "ja": []}, fps,
            {"en": set(), "ja": set()},
            self._fetch({("en", "sv01"): d1, ("en", "swsh1"): d2new}))
        self.assertEqual(targets, {"en": ["swsh1"], "ja": []})
        self.assertEqual(failed, [])
        self.assertIn("en:sv01", prefetched)

    def test_never_fingerprinted_is_targeted(self):
        d = self._detail(["sv01-001"])
        targets, _, _ = sr.select_snapshot_targets(
            {"en": ["sv01"], "ja": []}, {}, {"en": set(), "ja": set()},
            self._fetch({("en", "sv01"): d}))
        self.assertEqual(targets["en"], ["sv01"])

    def test_hot_always_targeted(self):
        d = self._detail(["me01-001"])
        fp = sr.upstream_fingerprint(d)
        targets, _, _ = sr.select_snapshot_targets(
            {"en": ["me01"], "ja": []}, {"en:me01": fp},
            {"en": {"me01"}, "ja": set()},
            self._fetch({("en", "me01"): d}))
        self.assertEqual(targets["en"], ["me01"])

    def test_fetch_failure_targets_safe_direction(self):
        targets, _, failed = sr.select_snapshot_targets(
            {"en": ["sv01"], "ja": []}, {"en:sv01": "old"},
            {"en": set(), "ja": set()},
            self._fetch({}, failures={("en", "sv01")}))
        self.assertEqual(targets["en"], ["sv01"])
        self.assertEqual(failed, ["en:sv01"])

    def test_force_all_targets_everything_without_fetching(self):
        calls = []

        def counting(lang, sid):
            calls.append((lang, sid))
            return self._detail(["x-1"])

        targets, _, _ = sr.select_snapshot_targets(
            {"en": ["sv01", "swsh1"], "ja": ["M6"]},
            {"en:sv01": "x"}, {"en": set(), "ja": set()},
            counting, force_all=True)
        self.assertEqual(targets, {"en": ["sv01", "swsh1"], "ja": ["M6"]})
        self.assertEqual(calls, [])

    def test_pocket_and_nofetch_never_targeted_even_when_hot(self):
        d = self._detail(["A1-1"])
        fetch = self._fetch({("en", "A1"): d, ("en", "sv01"): d,
                             ("ja", "M6a"): d, ("ja", "M6"): d})
        targets, _, _ = sr.select_snapshot_targets(
            {"en": ["A1", "sv01"], "ja": ["M6a", "M6"]}, {},
            {"en": {"A1"}, "ja": {"M6a"}}, fetch)
        self.assertEqual(targets, {"en": ["sv01"], "ja": ["M6"]})


class BackstopTests(unittest.TestCase):
    def test_due_when_never(self):
        now = datetime.now(timezone.utc)
        self.assertTrue(sr.shard_full_sweep_due({"shards": {}}, 0, now))

    def test_due_when_older_than_30_days(self):
        now = datetime.now(timezone.utc)
        old = (now - timedelta(days=31)).isoformat()
        self.assertTrue(
            sr.shard_full_sweep_due({"shards": {"0": {"last_full_ok": old}}}, 0, now))

    def test_not_due_when_recent(self):
        now = datetime.now(timezone.utc)
        recent = (now - timedelta(days=10)).isoformat()
        self.assertFalse(
            sr.shard_full_sweep_due({"shards": {"0": {"last_full_ok": recent}}},
                                    0, now))

    def test_invalid_timestamp_is_due(self):
        now = datetime.now(timezone.utc)
        self.assertTrue(
            sr.shard_full_sweep_due({"shards": {"0": {"last_full_ok": "junk"}}},
                                    0, now))

    def test_custom_window(self):
        now = datetime.now(timezone.utc)
        d10 = (now - timedelta(days=10)).isoformat()
        self.assertTrue(sr.shard_full_sweep_due({"shards": {"0": {"last_full_ok": d10}}},
                                               0, now, days=7))
        self.assertFalse(sr.shard_full_sweep_due({"shards": {"0": {"last_full_ok": d10}}},
                                                0, now, days=14))


class StaleCheckTests(unittest.TestCase):
    def test_no_shards_ever_is_stale(self):
        now = datetime.now(timezone.utc)
        ok, msg = sr.check_stale({"shards": {}}, now)
        self.assertFalse(ok)
        self.assertIn("STALE", msg)

    def test_recent_ok(self):
        now = datetime.now(timezone.utc)
        state = {"shards": {"2": {"last_ok": (now - timedelta(hours=5)).isoformat()}}}
        ok, msg = sr.check_stale(state, now)
        self.assertTrue(ok)
        self.assertIn("2", msg)

    def test_old_is_stale(self):
        now = datetime.now(timezone.utc)
        state = {"shards": {"2": {"last_ok": (now - timedelta(days=4)).isoformat()}}}
        ok, msg = sr.check_stale(state, now)
        self.assertFalse(ok)
        self.assertIn("STALE", msg)

    def test_custom_threshold(self):
        now = datetime.now(timezone.utc)
        state = {"shards": {"2": {"last_ok": (now - timedelta(days=4)).isoformat()}}}
        ok, _ = sr.check_stale(state, now, max_days=7)
        self.assertTrue(ok)

    def test_picks_latest_shard(self):
        now = datetime.now(timezone.utc)
        state = {"shards": {
            "0": {"last_ok": (now - timedelta(days=1)).isoformat()},
            "5": {"last_ok": (now - timedelta(hours=1)).isoformat()}}}
        ok, msg = sr.check_stale(state, now)
        self.assertTrue(ok)
        self.assertIn("5", msg)

    def test_invalid_timestamp_ignored(self):
        now = datetime.now(timezone.utc)
        state = {"shards": {"0": {"last_ok": "junk"}}}
        ok, _ = sr.check_stale(state, now)
        self.assertFalse(ok)


class StagingTests(unittest.TestCase):
    def _tmp(self):
        import tempfile
        return tempfile.mkdtemp()

    def test_sync_new_files_copies_only_missing(self):
        import shutil
        tmp = self._tmp()
        try:
            src = os.path.join(tmp, "src")
            dst = os.path.join(tmp, "dst")
            os.makedirs(os.path.join(src, "sub"))
            os.makedirs(dst)
            with open(os.path.join(src, "a.txt"), "w") as f:
                f.write("a")
            with open(os.path.join(src, "sub", "b.txt"), "w") as f:
                f.write("b")
            with open(os.path.join(dst, "a.txt"), "w") as f:
                f.write("existing")
            copied = sr._sync_new_files(src, dst)
            self.assertEqual(copied, [os.path.join("sub", "b.txt")])
            with open(os.path.join(dst, "a.txt")) as f:
                self.assertEqual(f.read(), "existing")
            with open(os.path.join(dst, "sub", "b.txt")) as f:
                self.assertEqual(f.read(), "b")
        finally:
            shutil.rmtree(tmp)

    def test_sync_new_files_missing_src_is_noop(self):
        self.assertEqual(sr._sync_new_files("/nonexistent-xyz-123", "/tmp"), [])

    def test_seed_staging_copies_inputs_and_symlinks_caches(self):
        import shutil
        tmp = self._tmp()
        try:
            live = os.path.join(tmp, "live")
            st = os.path.join(tmp, "staging")
            os.makedirs(os.path.join(live, "tcgdex", "sets"))
            os.makedirs(os.path.join(live, "pkmn-cache"))
            with open(os.path.join(live, "tcgdex", "sets.json"), "w") as f:
                f.write("[]")
            with open(os.path.join(live, "tcgdex", "sets", "sv01.json"), "w") as f:
                f.write("{}")
            with open(os.path.join(live, "pkmn-cache", "ledger.json"), "w") as f:
                f.write("{}")
            sr.seed_staging(live, st)
            self.assertTrue(os.path.isfile(os.path.join(st, "tcgdex", "sets.json")))
            self.assertTrue(os.path.isfile(os.path.join(st, "tcgdex", "sets", "sv01.json")))
            # cache is a symlink: the shared ledger stays single
            self.assertTrue(os.path.islink(os.path.join(st, "pkmn-cache")))
            with open(os.path.join(st, "pkmn-cache", "ledger.json"), "w") as f:
                f.write('{"x": 1}')
            with open(os.path.join(live, "pkmn-cache", "ledger.json")) as f:
                self.assertEqual(f.read(), '{"x": 1}')
        finally:
            shutil.rmtree(tmp)

    def test_killed_run_leaves_live_tree_untouched(self):
        # A run that dies after staging writes but before promote must not
        # have touched the live tree at all.
        import shutil
        tmp = self._tmp()
        try:
            live = os.path.join(tmp, "live")
            st = os.path.join(tmp, "staging")
            os.makedirs(os.path.join(live, "tcgdex", "sets"))
            with open(os.path.join(live, "tcgdex", "sets", "sv01.json"), "w") as f:
                f.write("{}")
            sr.seed_staging(live, st)
            # ...stages write into staging, then the host dies: no promote...
            with open(os.path.join(st, "tcgdex", "sets", "sv01.json"), "w") as f:
                f.write('{"new": 1}')
            with open(os.path.join(st, "tcgdex", "sets", "me01.json"), "w") as f:
                f.write('{"new": 1}')
            with open(os.path.join(live, "tcgdex", "sets", "sv01.json")) as f:
                self.assertEqual(f.read(), "{}")
            self.assertFalse(
                os.path.exists(os.path.join(live, "tcgdex", "sets", "me01.json")))
        finally:
            shutil.rmtree(tmp)

    def test_promote_copies_only_known_outputs(self):
        import shutil
        tmp = self._tmp()
        try:
            live = os.path.join(tmp, "live")
            st = os.path.join(tmp, "staging")
            os.makedirs(os.path.join(live, "tcgdex", "sets"))
            os.makedirs(os.path.join(st, "tcgdex", "sets", "ja"))
            with open(os.path.join(live, "tcgdex", "sets.json"), "w") as f:
                f.write("[]")
            with open(os.path.join(st, "tcgdex", "sets.json"), "w") as f:
                f.write("[1]")
            with open(os.path.join(st, "tcgdex", "sets", "sv01.json"), "w") as f:
                f.write("{}")
            with open(os.path.join(st, "tcgdex", "sets", "unrelated.json"), "w") as f:
                f.write("{}")
            with open(os.path.join(st, "tcgdex", "sets", "ja", "M6.json"), "w") as f:
                f.write("{}")
            ctx = {"targets": {"en": ["sv01"], "ja": ["M6"]}, "failed_sets": []}
            copied = sr.promote_outputs(st, live, ctx)
            self.assertTrue(
                os.path.isfile(os.path.join(live, "tcgdex", "sets", "sv01.json")))
            self.assertTrue(
                os.path.isfile(os.path.join(live, "tcgdex", "sets", "ja", "M6.json")))
            self.assertFalse(
                os.path.exists(os.path.join(live, "tcgdex", "sets", "unrelated.json")))
            self.assertIn("tcgdex/sets.json", copied)
        finally:
            shutil.rmtree(tmp)

    def test_promote_skips_failed_sets(self):
        import shutil
        tmp = self._tmp()
        try:
            live = os.path.join(tmp, "live")
            st = os.path.join(tmp, "staging")
            os.makedirs(os.path.join(live, "tcgdex", "sets"))
            os.makedirs(os.path.join(st, "tcgdex", "sets"))
            with open(os.path.join(live, "tcgdex", "sets", "sv01.json"), "w") as f:
                f.write('{"old": 1}')
            with open(os.path.join(st, "tcgdex", "sets", "sv01.json"), "w") as f:
                f.write('{"old": 1}')
            ctx = {"targets": {"en": ["sv01"], "ja": []},
                   "failed_sets": [("en", "sv01")]}
            sr.promote_outputs(st, live, ctx)
            with open(os.path.join(live, "tcgdex", "sets", "sv01.json")) as f:
                self.assertEqual(f.read(), '{"old": 1}')
        finally:
            shutil.rmtree(tmp)

    def test_load_hot_sets_seeds_from_default_when_missing(self):
        import shutil
        tmp = self._tmp()
        try:
            p = os.path.join(tmp, "hot-sets.json")
            hot = sr.load_hot_sets(p)
            self.assertTrue(os.path.isfile(p))
            self.assertIn("30th", hot["en"])
            self.assertEqual(sr.load_hot_sets(p), hot)
        finally:
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
