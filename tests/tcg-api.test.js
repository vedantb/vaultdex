/* VaultDex unit tests — App.tcg helpers (js/tcg-api.js):
 * parseSetId, normVLabel, printVariantForLabel. */
import { describe, test, expect } from "vitest";
import "../js/util.js"; // parseSetId needs App.util.isJa
import "../js/tcg-api.js";

const { parseSetId, normVLabel, printVariantForLabel } = window.App.tcg;

describe("parseSetId", () => {
  test("ja- prefix -> Japanese", () => {
    expect(parseSetId("ja-M4")).toEqual({ lang: "ja", id: "M4" });
  });

  test("plain id -> English", () => {
    expect(parseSetId("sv01")).toEqual({ lang: "en", id: "sv01" });
  });

  test("ids shared across languages stay distinct", () => {
    // neo1 exists in both languages; the appId prefix is what separates them.
    expect(parseSetId("ja-neo1")).toEqual({ lang: "ja", id: "neo1" });
    expect(parseSetId("neo1")).toEqual({ lang: "en", id: "neo1" });
  });
});

describe("normVLabel", () => {
  test("canonicalizes the standard print variants", () => {
    expect(normVLabel("Normal")).toBe("normal");
    expect(normVLabel("Standard")).toBe("normal");
    expect(normVLabel("Holofoil")).toBe("holo");
    expect(normVLabel("Reverse Holo")).toBe("reverse");
    expect(normVLabel("Reverse Holofoil")).toBe("reverse");
    expect(normVLabel("Poké Ball")).toBe("pokeball");
    expect(normVLabel("Energy Symbol Pattern")).toBe("energy");
  });

  test("lowercases/strips punctuation, empty -> empty", () => {
    expect(normVLabel("")).toBe("");
    expect(normVLabel(null)).toBe("");
  });
});

describe("printVariantForLabel", () => {
  test("maps print variants to PkmnPrices match hints", () => {
    expect(printVariantForLabel("Poké Ball")).toEqual({
      pkmnLabel: "poke ball",
      priceVariant: "reverseHolofoil",
    });
    expect(printVariantForLabel("Energy Symbol Pattern")).toEqual({
      pkmnLabel: "energy symbol pattern",
      priceVariant: "reverseHolofoil",
    });
    expect(printVariantForLabel("Reverse Holo")).toEqual({
      pkmnLabel: "reverse holo",
      priceVariant: "reverseHolofoil",
    });
    expect(printVariantForLabel("Holofoil")).toEqual({
      pkmnLabel: null,
      priceVariant: "holofoil",
    });
    expect(printVariantForLabel("Normal")).toEqual({
      pkmnLabel: null,
      priceVariant: "normal",
    });
  });

  test("unknown labels fall through to the normal variant", () => {
    expect(printVariantForLabel("Weird Foil")).toEqual({
      pkmnLabel: null,
      priceVariant: "normal",
    });
  });

  test("Japanese catalog rarity mislabels never match a real variant", () => {
    // The real JA mislabels from the review (TCGdex bulk-mislabeled many
    // Japanese cards as "Mega Hyper Rare"; the canonical correction
    // Art Rare -> "Illustration rare", Special Art Rare -> "Special
    // illustration rare", Super Rare -> "Ultra Rare" lives in
    // scripts/ja-pkmn-enrich.py PP_RARITY_FIX and runs at snapshot time,
    // not in this JS). Guard here: if such a label ever reaches the
    // variant pipeline, it must fall through to "normal" and must never
    // be mistaken for a real print variant (e.g. "holo").
    for (const label of ["Art Rare", "Special Art Rare", "Super Rare", "Mega Hyper Rare"]) {
      expect(normVLabel(label)).not.toBe("holo");
      expect(normVLabel(label)).not.toBe("reverse");
      expect(printVariantForLabel(label)).toEqual({
        pkmnLabel: null,
        priceVariant: "normal",
      });
    }
  });
});
