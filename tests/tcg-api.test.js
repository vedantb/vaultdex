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

describe("printVariants (foil-collision fix, 2026-09-18)", () => {
  const { printVariants } = window.App.tcg;
  const vileplume = {
    variants_detailed: [
      { type: "holo", foil: null },
      { type: "reverse", foil: null },
      { type: "holo", foil: "cosmos" },
    ],
  };

  test("Vileplume me02-003: three boxes, three distinct vlabels", () => {
    const boxes = printVariants(vileplume);
    expect(boxes.map((b) => b.label)).toEqual(["Holo", "Reverse Holo", "Cosmos Holo"]);
    const vlabels = boxes.map((b) => b.vlabel);
    expect(new Set(vlabels).size).toBe(3);
  });

  test("foil holo carries PkmnPrices match hints", () => {
    const box = printVariants(vileplume)[2];
    expect(box.pkmnLabel).toBe("cosmos holo");
    expect(box.priceVariant).toBe("holofoil");
    expect(box.key).toBe("holo:cosmos");
  });

  test("normal + foil no longer collapses onto Normal", () => {
    const boxes = printVariants({
      variants_detailed: [
        { type: "normal", foil: null },
        { type: "normal", foil: "galaxy" },
      ],
    });
    expect(boxes.map((b) => b.label)).toEqual(["Normal", "Galaxy Foil"]);
    expect(new Set(boxes.map((b) => b.vlabel)).size).toBe(2);
  });

  test("reverse foils keep their existing labels", () => {
    const boxes = printVariants({
      variants_detailed: [
        { type: "reverse", foil: "pokeball" },
        { type: "reverse", foil: "masterball" },
        { type: "reverse", foil: null },
      ],
    });
    expect(boxes.map((b) => b.label)).toEqual(["Poké Ball", "Masterball", "Reverse Holo"]);
  });

  test("hyphenated foils read naturally", () => {
    const boxes = printVariants({ variants_detailed: [{ type: "holo", foil: "cracked-ice" }] });
    expect(boxes[0].label).toBe("Cracked Ice Holo");
    expect(boxes[0].vlabel).toBe("crackediceholo");
  });

  test("printVariantForLabel maps the new foil labels", () => {
    expect(printVariantForLabel("Cosmos Holo")).toEqual({
      pkmnLabel: "cosmos holo",
      priceVariant: "holofoil",
    });
    expect(printVariantForLabel("Galaxy Foil")).toEqual({
      pkmnLabel: "galaxy foil",
      priceVariant: "normal",
    });
    // Existing labels are untouched.
    expect(printVariantForLabel("Holo")).toEqual({ pkmnLabel: null, priceVariant: "holofoil" });
    expect(printVariantForLabel("Normal")).toEqual({ pkmnLabel: null, priceVariant: "normal" });
  });
});

describe("printVariants dedupe (2026-09-18)", () => {
  const { printVariants } = window.App.tcg;

  test("identical TCGdex entries collapse to one checkbox", () => {
    const boxes = printVariants({
      variants_detailed: [
        { type: "holo", foil: null },
        { type: "holo", foil: null },
        { type: "holo", foil: null },
        { type: "holo", foil: null },
      ],
    });
    expect(boxes.map((b) => b.label)).toEqual(["Holo"]);
  });

  test("distinct printings are all kept", () => {
    const boxes = printVariants({
      variants_detailed: [
        { type: "holo", foil: null },
        { type: "reverse", foil: null },
        { type: "holo", foil: "cosmos" },
      ],
    });
    expect(boxes.length).toBe(3);
  });
});

describe("getCard image backfill (2026-09-20)", () => {
  test("patches missing live images from the local snapshot", async () => {
    const liveCard = {
      id: "svp-085", name: "Pikachu with Grey Felt Hat", localId: "085",
      image: null, set: { id: "svp", name: "SVP Black Star Promos" },
    };
    const snapCard = {
      id: "svp-085", name: "Pikachu with Grey Felt Hat", localId: "085",
      image: null,
      imageSmall: "https://images.pkmnprices.com/cards/x.webp",
      imageLarge: "https://images.pkmnprices.com/cards/x.webp",
    };
    const orig = window.App.util.fetchWithTimeout;
    window.App.util.fetchWithTimeout = async (url) => {
      if (String(url).includes("/data/tcgdex/sets/svp.json")) {
        return { ok: true, json: async () => ({ set: { id: "svp", name: "SVP Black Star Promos" }, cards: [snapCard] }) };
      }
      return { ok: true, json: async () => liveCard };
    };
    try {
      const card = await window.App.tcg.getCard("svp-085", "en");
      expect(card.images.small).toBe("https://images.pkmnprices.com/cards/x.webp");
      expect(card.images.large).toBe("https://images.pkmnprices.com/cards/x.webp");
    } finally {
      window.App.util.fetchWithTimeout = orig;
    }
  });

  test("keeps live images when present (no snapshot lookup needed)", async () => {
    const liveCard = {
      id: "sv1-001", name: "Sprigatito", localId: "001",
      image: "https://assets.tcgdex.net/en/sv1/1", set: { id: "sv1", name: "Scarlet & Violet" },
    };
    let snapshotHit = false;
    const orig = window.App.util.fetchWithTimeout;
    window.App.util.fetchWithTimeout = async (url) => {
      if (String(url).includes("/data/tcgdex/")) {
        snapshotHit = true;
        return { ok: false };
      }
      return { ok: true, json: async () => liveCard };
    };
    try {
      const card = await window.App.tcg.getCard("sv1-001", "en");
      expect(card.images.small).toBe("https://assets.tcgdex.net/en/sv1/1/low.png");
      expect(card.images.large).toBe("https://assets.tcgdex.net/en/sv1/1/high.png");
      expect(snapshotHit).toBe(false);
    } finally {
      window.App.util.fetchWithTimeout = orig;
    }
  });
});
