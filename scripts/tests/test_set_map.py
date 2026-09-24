"""Unit tests for scripts/build-pkmn-set-map.py.

The set-id map is what keeps pricing scoped to the right printing:
PkmnPrices set names carry code prefixes ("SV01: ", "SM - ", "XY - ") and
subset suffixes ("Base Set", "Trainer Gallery") that defeat normalized
name matching, so the app's number-only fallback used to price cards as
another set's printing (SV Professor's Research #190 as the $36.23
Professor Program promo). These tests pin the matcher to the provider
set that actually holds the set's cards — a missing mapping (status quo)
is always preferable to a wrong one.
"""
import importlib.util
import os
import sys
import unittest

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name):
    modname = "vd_" + name.replace("-", "_")
    spec = importlib.util.spec_from_file_location(
        modname, os.path.join(SCRIPTS, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[modname] = mod
    spec.loader.exec_module(mod)
    return mod


setmap = load("build-pkmn-set-map")


def pp(id_, name, card_count=None):
    return {"id": id_, "name": name, "card_count": card_count}


# A slice of the real provider catalog (ids/names as of 2026-09-24).
PP = [
    pp(511, "SV01: Scarlet & Violet Base Set", 258),
    pp(473, "SVE: Scarlet & Violet Energies", 8),
    pp(505, "SV: Scarlet & Violet Promo Cards", 200),
    pp(512, "SV02: Paldea Evolved", 279),
    pp(514, "SV03: Obsidian Flames", 230),
    pp(500, "SV: Scarlet & Violet 151", 207),
    pp(521, "SWSH01: Sword & Shield Base Set", 216),
    pp(520, "SWSH: Sword & Shield Promo Cards", 150),
    pp(530, "SM - Guardians Rising", 180),
    pp(531, "SM - Burning Shadows", 177),
    pp(437, "Fossil", 62),
    pp(999, "XY - Evolutions", 113),
    pp(11690 - 0, "Pokemon GO", 88),  # id value irrelevant here
]


class NormTests(unittest.TestCase):
    def test_colon_code_prefix_stripped(self):
        self.assertEqual(setmap.norm("SV01: Scarlet & Violet Base Set"),
                         "scarlet & violet base set")

    def test_dash_code_prefix_stripped(self):
        self.assertEqual(setmap.norm("SM - Guardians Rising"),
                         "guardians rising")

    def test_accents_stripped(self):
        self.assertEqual(setmap.norm("Pokémon GO"), "pokemon go")

    def test_inner_colons_dropped(self):
        self.assertEqual(
            setmap.norm("SWSH: Crown Zenith: Galarian Gallery"),
            "crown zenith galarian gallery")

    def test_plain_name_untouched(self):
        self.assertEqual(setmap.norm("Fossil"), "fossil")


class CodeTests(unittest.TestCase):
    def test_code_of_colon(self):
        self.assertEqual(setmap.code_of("SV01: Scarlet & Violet Base Set"),
                         "sv01")

    def test_code_of_dash(self):
        self.assertEqual(setmap.code_of("SM - Guardians Rising"), "sm")

    def test_code_of_none(self):
        self.assertIsNone(setmap.code_of("Fossil"))
        self.assertIsNone(setmap.code_of("Pokemon GO"))

    def test_code_norm_zero_padding(self):
        self.assertEqual(setmap.code_norm("sv01"), "sv1")
        self.assertEqual(setmap.code_norm("SWSH01"), "swsh1")
        self.assertEqual(setmap.code_norm("s10b"), "s10b")


class BestMatchTests(unittest.TestCase):
    def match(self, our_id, our_name):
        ps, method = setmap.best_match(our_id, our_name, PP)
        return (ps["id"] if ps else None), method

    def test_sv01_picks_base_set_not_energies(self):
        # The regression that motivated the map: "Scarlet & Violet" must
        # resolve to SV01 (258 cards), never SVE Energies (8 cards).
        pid, method = self.match("sv01", "Scarlet & Violet")
        self.assertEqual(pid, 511)
        self.assertEqual(method, "code")

    def test_swsh1_picks_base_set_not_promos(self):
        pid, method = self.match("swsh1", "Sword & Shield")
        self.assertEqual(pid, 521)

    def test_sm_dash_prefix_exact(self):
        pid, method = self.match("sm2", "Guardians Rising")
        self.assertEqual(pid, 530)
        self.assertEqual(method, "exact")

    def test_accent_exact(self):
        pid, method = self.match("swsh10.5", "Pokémon GO")
        self.assertEqual(pid, 11690)
        self.assertEqual(method, "exact")

    def test_plain_exact(self):
        pid, _ = self.match("fo", "Fossil")
        self.assertEqual(pid, 437)

    def test_151_containment(self):
        # "151" is contained in "SV: Scarlet & Violet 151".
        pid, method = self.match("sv03.5", "151")
        self.assertEqual(pid, 500)
        self.assertEqual(method, "containment")

    def test_xy_base_does_not_match_xy_evolutions(self):
        # Ambiguous: no provider set is just "XY". A wrong mapping would
        # cross-price every XY base card as Evolutions — None is correct.
        pid, _ = self.match("xy1", "XY")
        self.assertIsNone(pid)

    def test_galarian_gallery_exact_after_colon_drop(self):
        gal = pp(566, "SWSH: Crown Zenith: Galarian Gallery", 70)
        cz = pp(160, "SWSH: Crown Zenith", 160)
        ps, method = setmap.best_match(
            "swsh12.5gg", "Crown Zenith Galarian Gallery", PP + [gal, cz])
        self.assertEqual(ps["id"], 566)
        self.assertEqual(method, "exact")

    def test_svp_needs_override(self):
        # "Scarlet & Violet Promos" shares no words with "SV: Scarlet &
        # Violet Promo Cards" — containment picks SV01 by accident ("scarlet
        # & violet" is contained), so this set stays override-only.
        pid, method = self.match("svp", "Scarlet & Violet Promos")
        self.assertNotEqual(pid, 505)


if __name__ == "__main__":
    unittest.main()
