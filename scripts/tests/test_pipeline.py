"""VaultDex pipeline unit tests (stdlib unittest — zero new dependencies).

Covers the tricky, historically fragile bits of the weekly catalog
pipeline: the credit ledger (shared by the enricher and the price
backfill, guarding the paid 20,000/day Pro cap), atomic JSON writes,
card-number/name normalization used for matching, price extraction
(USD preferred, EUR fallback), and TCGdex's flaky double-encoded JSON.

The scripts are imported as modules with CACHE pointed at a temp dir,
so no test touches the real data/ tree or the network.
"""
import importlib.util
import json
import os
import sys
import tempfile
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


enrich = load("ja-pkmn-enrich")
backfill = load("ja-price-backfill")
snapshot = load("snapshot-tcgdex")
en_backfill = load("en-image-backfill")


class TmpCacheTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._old = {}
        for mod in (enrich, backfill):
            self._old[mod] = mod.CACHE
            mod.CACHE = self.tmp.name

    def tearDown(self):
        for mod, cache in self._old.items():
            mod.CACHE = cache
        self.tmp.cleanup()

    def cache_file(self, name, obj):
        p = os.path.join(self.tmp.name, name)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        return p


class AtomicWriteTests(TmpCacheTestCase):
    def test_roundtrip(self):
        p = os.path.join(self.tmp.name, "x.json")
        enrich.atomic_write_json(p, {"a": [1, 2, 3]}, indent=1)
        self.assertEqual(json.load(open(p)), {"a": [1, 2, 3]})

    def test_no_tmp_residue(self):
        p = os.path.join(self.tmp.name, "x.json")
        enrich.atomic_write_json(p, {"a": 1})
        self.assertFalse(os.path.exists(p + ".tmp"))

    def test_overwrite_is_clean(self):
        p = os.path.join(self.tmp.name, "x.json")
        enrich.atomic_write_json(p, {"a": 1})
        enrich.atomic_write_json(p, {"a": 2, "b": "longer value here"})
        self.assertEqual(json.load(open(p))["a"], 2)


class LedgerTests(TmpCacheTestCase):
    def test_missing_ledger_is_empty(self):
        self.assertEqual(enrich.load_ledger(), {})
        self.assertEqual(enrich.spent_today({}), 0)

    def test_corrupt_ledger_is_a_cache_miss(self):
        p = os.path.join(self.tmp.name, "credit-ledger.json")
        with open(p, "w") as f:
            f.write("{not json!!!")
        self.assertEqual(enrich.load_ledger(), {})

    def test_add_spend_accumulates(self):
        ledger = {}
        enrich.add_spend(ledger, 100)
        enrich.add_spend(ledger, 50)
        self.assertEqual(enrich.spent_today(ledger), 150)
        # …and survives a reload from disk
        self.assertEqual(enrich.spent_today(enrich.load_ledger()), 150)

    def test_add_spend_never_loses_disk_counts(self):
        # Another process wrote 200 under the lock; our in-memory copy is
        # stale at 150. The merge keeps the max, then adds.
        today = enrich.utc_today()
        self.cache_file("credit-ledger.json", {today: 200})
        ledger = {today: 150}
        enrich.add_spend(ledger, 10)
        self.assertEqual(ledger[today], 210)

    def test_spent_today_ignores_other_days(self):
        yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
        ledger = {yesterday: 9999}
        self.assertEqual(enrich.spent_today(ledger), 0)


class NormNumTests(unittest.TestCase):
    def test_enrich_strips_leading_zeros(self):
        self.assertEqual(enrich.norm_num("001"), "1")
        self.assertEqual(enrich.norm_num("092"), "92")

    def test_enrich_strips_printed_total_suffix(self):
        self.assertEqual(enrich.norm_num("092/083"), "92")

    def test_enrich_keeps_non_numeric_tails(self):
        self.assertEqual(enrich.norm_num("TG03"), "TG03")
        self.assertEqual(enrich.norm_num("001a"), "1a")

    def test_backfill_matches_enrich(self):
        for s in ["001", "092", "25", "TG03", "001/102"]:
            self.assertEqual(backfill.norm_num(s), enrich.norm_num(s),
                             "norm_num diverged for %r" % s)


class CleanNameTests(unittest.TestCase):
    def test_strips_number_suffix(self):
        self.assertEqual(enrich.clean_name("Pikachu - 092/083"), "Pikachu")

    def test_strips_promo_suffix(self):
        self.assertEqual(enrich.clean_name("Pikachu - 227/S-P"), "Pikachu")

    def test_leaves_plain_names_alone(self):
        self.assertEqual(enrich.clean_name("Charizard ex"), "Charizard ex")

    def test_handles_empty(self):
        self.assertEqual(enrich.clean_name(""), "")
        self.assertEqual(enrich.clean_name(None), "")


class ExtractPricesTests(unittest.TestCase):
    def payload(self, *rows):
        return {"prices": [
            {"condition": c, "variant": v, "market_price": p, "currency": cur}
            for (c, v, p, cur) in rows
        ]}

    def test_usd_preferred_over_eur(self):
        card = self.payload(
            ("Near Mint", "Normal", 1.23, "EUR"),
            ("Near Mint", "Normal", 1.50, "USD"),
        )
        prices, currency = backfill.extract_prices(card)
        self.assertEqual(prices["normal"]["marketPrice"], 1.5)
        self.assertEqual(currency, "USD")

    def test_eur_fallback_when_no_usd(self):
        card = self.payload(("Near Mint", "Holofoil", 2.0, "EUR"))
        prices, currency = backfill.extract_prices(card)
        self.assertEqual(currency, "EUR")
        self.assertEqual(prices["holofoil"]["marketPrice"], 2.0)

    def test_ignores_non_near_mint_and_non_numeric(self):
        card = self.payload(
            ("Lightly Played", "Normal", 99.0, "USD"),
            ("Near Mint", "Normal", "n/a", "USD"),
            ("Near Mint", "Normal", 3.0, "USD"),
        )
        prices, currency = backfill.extract_prices(card)
        self.assertEqual(prices, {"normal": {"marketPrice": 3.0}})
        self.assertEqual(currency, "USD")

    def test_empty_payload(self):
        self.assertEqual(backfill.extract_prices({}), ({}, "USD"))
        self.assertEqual(backfill.extract_prices({"prices": []}), ({}, "USD"))


class NormVariantTests(unittest.TestCase):
    def test_reverse_holo(self):
        self.assertEqual(backfill.norm_variant("Reverse Holofoil"), "reverseHolofoil")

    def test_holo(self):
        self.assertEqual(backfill.norm_variant("Holo Rare"), "holofoil")

    def test_normal_fallback(self):
        self.assertEqual(backfill.norm_variant("Normal"), "normal")
        self.assertEqual(backfill.norm_variant(""), "normal")
        self.assertEqual(backfill.norm_variant(None), "normal")


class PricedRecentlyTests(unittest.TestCase):
    def card(self, days_ago=None):
        if days_ago is None:
            return {}
        ts = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
        return {"pricing": {"pricedAt": ts}}

    def test_recent(self):
        self.assertTrue(backfill.priced_recently(self.card(2), 6))

    def test_stale(self):
        self.assertFalse(backfill.priced_recently(self.card(10), 6))

    def test_missing_or_garbage_is_not_recent(self):
        self.assertFalse(backfill.priced_recently({}, 6))
        self.assertFalse(backfill.priced_recently(
            {"pricing": {"pricedAt": "garbage"}}, 6))


class PpidLookupTests(TmpCacheTestCase):
    def test_rebuilds_lookup_from_manifest_and_cache(self):
        self.cache_file("manifest.json", {"sets": [
            {"ourId": "M6", "ppSetId": "pp-1"},
            {"ourId": "M6a", "ppSetId": "pp-2"},  # no cache file: skipped
        ]})
        self.cache_file("cards-pp-1.json", {"cards": [
            {"id": 101, "number": "001"},
            {"id": 102, "number": "092/083"},
        ]})
        lookup = backfill.build_ppid_lookup()
        self.assertEqual(lookup[("M6", "1")], 101)
        self.assertEqual(lookup[("M6", "92")], 102)
        self.assertNotIn(("M6a", "1"), lookup)

    def test_corrupt_cache_file_is_skipped(self):
        self.cache_file("manifest.json", {"sets": [
            {"ourId": "M6", "ppSetId": "pp-1"},
        ]})
        p = os.path.join(self.tmp.name, "cards-pp-1.json")
        with open(p, "w") as f:
            f.write("{{{nope")
        self.assertEqual(backfill.build_ppid_lookup(), {})

    def test_missing_manifest_is_empty(self):
        self.assertEqual(backfill.build_ppid_lookup(), {})


class DeepUnwrapTests(unittest.TestCase):
    def test_unwraps_double_encoded_string(self):
        self.assertEqual(snapshot.deep_unwrap('{"a": 1}'), {"a": 1})

    def test_unwraps_nested(self):
        # TCGdex shape: an object encoded as a string, nested in a dict,
        # with another encoded string one level deeper.
        inner = json.dumps({"y": json.dumps([1, 2])})
        self.assertEqual(snapshot.deep_unwrap({"x": inner}), {"x": {"y": [1, 2]}})

    def test_leaves_plain_strings_alone(self):
        self.assertEqual(snapshot.deep_unwrap("hello"), "hello")
        # Looks like JSON but isn't parseable: left alone, never crashes
        self.assertEqual(snapshot.deep_unwrap("{oops"), "{oops")

    def test_leaves_non_strings_alone(self):
        self.assertEqual(snapshot.deep_unwrap(42), 42)
        self.assertIsNone(snapshot.deep_unwrap(None))


class EnBackfillMatcherTests(unittest.TestCase):
    def test_norm_num_strips_zeros_inside_digit_runs(self):
        self.assertEqual(en_backfill.norm_num("085"), "85")
        self.assertEqual(en_backfill.norm_num("BW05"), "BW5")
        self.assertEqual(en_backfill.norm_num("BW005"), "BW5")
        self.assertEqual(en_backfill.norm_num("TG25"), "TG25")
        self.assertEqual(en_backfill.norm_num("SVP 175"), "SVP175")

    def test_norm_name_folds_accents(self):
        self.assertEqual(en_backfill.norm_name("Café Master"), "cafemaster")
        self.assertEqual(en_backfill.norm_name("Cafe Master"), "cafemaster")
        self.assertEqual(en_backfill.norm_name("Pokémon Catcher"), "pokemoncatcher")

    def test_names_compatible(self):
        n = en_backfill.names_compatible
        self.assertTrue(n("Espeon ex - 175", "Espeon ex"))
        self.assertTrue(n("Poke Ball (Noivern)", "Poké Ball"))
        # single-char containment must not match
        self.assertFalse(n("Greninja ex", "N"))
        self.assertFalse(n("Pikachu", "Charizard"))


class PreserveBackfilledImagesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._old_out = snapshot.OUT
        snapshot.OUT = self.tmp.name
        os.makedirs(os.path.join(self.tmp.name, "sets"), exist_ok=True)
        old = {"cards": [
            {"id": "s-1", "image": None,
             "imageSmall": "https://images.pkmnprices.com/a.webp",
             "imageLarge": "https://images.pkmnprices.com/a.webp"},
            {"id": "s-2", "image": None,
             "imageSmall": "https://images.pkmnprices.com/b.webp",
             "imageLarge": "https://images.pkmnprices.com/b.webp"},
        ]}
        with open(os.path.join(self.tmp.name, "sets", "s.json"), "w") as f:
            json.dump(old, f)

    def tearDown(self):
        snapshot.OUT = self._old_out
        self.tmp.cleanup()

    def test_keeps_backfill_when_still_imageless(self):
        fresh = {"cards": [{"id": "s-1", "image": None}]}
        out = snapshot.preserve_backfilled_images(fresh, "sets/s.json")
        c = out["cards"][0]
        self.assertEqual(c["imageSmall"], "https://images.pkmnprices.com/a.webp")

    def test_drops_backfill_when_canonical_image_arrives(self):
        fresh = {"cards": [{"id": "s-2", "image": "https://t/x.jpg",
                            "imageSmall": "stale", "imageLarge": "stale"}]}
        out = snapshot.preserve_backfilled_images(fresh, "sets/s.json")
        c = out["cards"][0]
        self.assertNotIn("imageSmall", c)
        self.assertNotIn("imageLarge", c)

    def test_new_card_without_old_snapshot_entry_untouched(self):
        fresh = {"cards": [{"id": "s-9", "image": None}]}
        out = snapshot.preserve_backfilled_images(fresh, "sets/s.json")
        self.assertNotIn("imageSmall", out["cards"][0])

    def test_missing_old_file_is_noop(self):
        fresh = {"cards": [{"id": "s-1", "image": None}]}
        out = snapshot.preserve_backfilled_images(fresh, "sets/nope.json")
        self.assertNotIn("imageSmall", out["cards"][0])


plock = load("pipeline_lock")


class PipelineLockTests(unittest.TestCase):
    def setUp(self):
        # Point the lock at a temp path so tests never touch the real one.
        self.orig = plock.LOCK_PATH
        self.tmp = tempfile.mkdtemp(prefix="vd-lock-test-")
        plock.LOCK_PATH = os.path.join(self.tmp, "test.lock")

    def tearDown(self):
        plock.release()
        plock.LOCK_PATH = self.orig

    def test_acquire_and_release(self):
        with plock.pipeline_lock("test"):
            self.assertTrue(os.path.exists(plock.LOCK_PATH))
            # second acquire must fail atomically (O_EXCL), not overwrite
            self.assertFalse(plock._try_acquire("other"))
        self.assertFalse(os.path.exists(plock.LOCK_PATH))

    def test_lock_file_names_owner(self):
        with plock.pipeline_lock("ja-price-backfill"):
            body = open(plock.LOCK_PATH).read()
        self.assertIn("ja-price-backfill", body)

    def test_stale_lock_is_reclaimed(self):
        fd = os.open(plock.LOCK_PATH, os.O_CREAT | os.O_WRONLY)
        os.close(fd)
        ancient = plock.STALE_AFTER + 60
        st = os.stat(plock.LOCK_PATH)
        os.utime(plock.LOCK_PATH, (st.st_atime - ancient, st.st_mtime - ancient))
        with plock.pipeline_lock("test", wait_timeout=1):
            self.assertTrue(os.path.exists(plock.LOCK_PATH))

    def test_held_lock_times_out_cleanly(self):
        with plock.pipeline_lock("holder"):
            with self.assertRaises(SystemExit) as cm:
                plock.acquire("waiter", wait_timeout=0.05)
            self.assertEqual(cm.exception.code, 2)


class HiddenSeriesFilterTests(unittest.TestCase):
    """TCG Pocket cards must never reach the search index.

    Regression: snapshot_index() used to write the raw /cards response,
    so Pocket sets (A1 Genetic Apex, B1 Mega Rising, P-A promos, …) leaked
    into browse search even though the set list hid them.
    """

    def test_pocket_cards_detected(self):
        for sid in ("A1", "A1a", "A2b", "A4", "B1", "B1a", "B2", "P-A"):
            card = {"id": "%s-001" % sid,
                    "image": "https://assets.tcgdex.net/en/tcgp/%s/001" % sid}
            self.assertTrue(snapshot.is_hidden_card(card, snapshot.POCKET_SET_IDS),
                            sid)

    def test_real_cards_kept(self):
        for cid in ("sv03-035", "swshp-227", "me02-001", "base1-4"):
            self.assertFalse(
                snapshot.is_hidden_card({"id": cid}, snapshot.POCKET_SET_IDS),
                cid)

    def test_prefix_boundary(self):
        # A1 must not swallow A10-style ids; P-A must not swallow P-AX.
        self.assertFalse(
            snapshot.is_hidden_card({"id": "A10-001"}, {"A1"}))
        self.assertFalse(
            snapshot.is_hidden_card({"id": "P-AX-001"}, {"P-A"}))

    def test_fallback_covers_known_pocket_sets(self):
        # The static fallback is the safety net when /series/tcgp is
        # unreachable — it must name every Pocket set the API lists.
        for sid in ("A1", "P-A", "A1a", "A2", "A2a", "A2b", "A3", "A3a",
                    "A3b", "A4", "A4a", "B1", "B1a", "B2", "B2a"):
            self.assertIn(sid, snapshot.POCKET_SET_IDS, sid)


class IndexImageOverlayTests(unittest.TestCase):
    """snapshot_index() overlays per-set backfilled images onto the index.

    Regression: the raw /cards index has no backfilled images, so browse
    search showed imageless tiles for cards whose set pages had art.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="vd-overlay-")
        os.makedirs(os.path.join(self.tmp, "sets"))
        payload = {"cards": [
            {"id": "s1-001", "image": None,
             "imageSmall": "https://images.pkmnprices.com/cards/1.webp"},
            {"id": "s1-002", "image": "https://assets.tcgdex.net/en/s1/2",
             "imageSmall": None},
        ]}
        with open(os.path.join(self.tmp, "sets", "s1.json"), "w") as f:
            json.dump(payload, f)
        self.orig_out = snapshot.OUT
        snapshot.OUT = self.tmp

    def tearDown(self):
        snapshot.OUT = self.orig_out

    def test_fills_gaps_from_per_set_files(self):
        cards = [{"id": "s1-001", "image": ""},
                 {"id": "s1-002", "image": ""},
                 {"id": "s1-003", "image": ""}]
        filled = snapshot.overlay_set_images(cards)
        self.assertEqual(filled, 2)
        self.assertEqual(cards[0]["image"],
                         "https://images.pkmnprices.com/cards/1.webp")
        self.assertEqual(cards[1]["image"],
                         "https://assets.tcgdex.net/en/s1/2")
        self.assertEqual(cards[2]["image"], "")

    def test_canonical_index_image_wins(self):
        cards = [{"id": "s1-001",
                  "image": "https://assets.tcgdex.net/en/s1/1"}]
        filled = snapshot.overlay_set_images(cards)
        self.assertEqual(filled, 0)
        self.assertEqual(cards[0]["image"],
                         "https://assets.tcgdex.net/en/s1/1")


class IllustratorOverlayTests(unittest.TestCase):
    """snapshot_index() overlays per-set illustrators onto the index.

    The raw /cards index carries no illustrator, but the card scanner
    matches the printed "Illus. <name>" credit — so per-set snapshots
    (which do carry it) are overlaid on every snapshot run.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="vd-illus-")
        os.makedirs(os.path.join(self.tmp, "sets"))
        payload = {"cards": [
            {"id": "s1-001", "illustrator": "chibi"},
            {"id": "s1-002", "illustrator": ""},
        ]}
        with open(os.path.join(self.tmp, "sets", "s1.json"), "w") as f:
            json.dump(payload, f)
        self.orig_out = snapshot.OUT
        snapshot.OUT = self.tmp

    def tearDown(self):
        snapshot.OUT = self.orig_out

    def test_fills_gaps_from_per_set_files(self):
        cards = [{"id": "s1-001"}, {"id": "s1-002"}, {"id": "s1-003"}]
        filled = snapshot.overlay_illustrators(cards)
        self.assertEqual(filled, 1)
        self.assertEqual(cards[0]["illustrator"], "chibi")
        self.assertNotIn("illustrator", cards[1])
        self.assertNotIn("illustrator", cards[2])

    def test_existing_illustrator_wins(self):
        cards = [{"id": "s1-001", "illustrator": "OKACHEKE"}]
        filled = snapshot.overlay_illustrators(cards)
        self.assertEqual(filled, 0)
        self.assertEqual(cards[0]["illustrator"], "OKACHEKE")


if __name__ == "__main__":
    unittest.main()
