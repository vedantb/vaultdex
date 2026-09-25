/* VaultDex unit tests — the 2026-09-23 Pokémon GO accent pricing fix.
 *
 * normSetName was accent-blind: TCGdex "Pokémon GO" never matched
 * PkmnPrices "Pokemon GO", so the exact set+number match always failed and
 * the number-only fallback priced the card as another set's printing —
 * Pokémon GO Moltres #12 Holo was priced as Fossil Moltres ($196.25 on a
 * $0.40 card), and it topped the movers as a fake gainer.
 *
 * These tests pin:
 *   1. normSetName strips accents ("Pokémon GO" -> "pokemon go").
 *   2. findCardId resolves the exact printing for accented sets (no
 *      cross-set fallback when the provider carries the set).
 *   3. variantMatches resolves display labels ("Holo") to the right finish
 *      instead of silently pricing the first variant of any finish.
 *   4. needsAccentRepair flags exactly the rows whose stored price could
 *      only have come from the accent-blind fallback.
 */
import { describe, test, expect, afterEach } from "vitest";
import "../js/util.js";
import "../js/tcg-api.js"; // real normVLabel
import "../js/pkmn.js";
import "../js/collection.js";

const P = window.App.pkmn;
const C = window.App.collection;

/* Fake the proxy the way pkmn-missing-sets.test.js does. */
function stubApi(handler) {
  window.App.util.fetchWithTimeout = async (url) => {
    const u = new URL(url, "https://x.test");
    const path = u.searchParams.get("path");
    const payload = handler(path, Object.fromEntries(u.searchParams));
    return { ok: true, status: 200, json: async () => payload };
  };
}
const realFetchWithTimeout = window.App.util.fetchWithTimeout;
afterEach(() => {
  window.App.util.fetchWithTimeout = realFetchWithTimeout;
});

describe("normSetName accent handling", () => {
  test('strips accents: "Pokémon GO" -> "pokemon go"', () => {
    expect(P.normSetName("Pokémon GO")).toBe("pokemon go");
  });
  test("colon cut still applies before stripping", () => {
    expect(P.normSetName("S10b: Pokemon GO")).toBe("pokemon go");
  });
  test("other accented sets normalize too", () => {
    expect(P.normSetName("McDonald's Pokémon-e Minimum Pack")).toBe(
      "mcdonald's pokemon-e minimum pack"
    );
  });
  test("plain ASCII names are unchanged", () => {
    expect(P.normSetName("Scarlet & Violet 151")).toBe("scarlet & violet 151");
    expect(P.normSetName("SV2D: Clay Burst")).toBe("clay burst");
  });
});

describe("findCardId on accented sets (the Moltres reproduction)", () => {
  /* The real 2026-09-23 PkmnPrices response shape for name=Moltres,
   * number=12: Fossil's Moltres sorts first, so the old accent-blind
   * matcher fell through to it via the number-only fallback. */
  const FOSSIL_MOLTRES_12 = { id: "10699", set: "Fossil", num: "12" };
  const POGO_MOLTRES_012 = { id: "11690", set: "Pokemon GO", num: "012" };

  test("resolves the Pokémon GO printing, not Fossil's", async () => {
    stubApi((path) => {
      if (path === "/v1/cards") {
        return {
          data: [FOSSIL_MOLTRES_12, POGO_MOLTRES_012].map((c) => ({
            id: c.id,
            set: { name: c.set },
            number: c.num,
          })),
        };
      }
      return { data: [] };
    });
    const id = await P.findCardId({
      name: "Moltres",
      setName: "Pokémon GO",
      number: "12",
      lang: "en",
    });
    expect(id).toBe("11690");
  });
});

describe("variantMatches", () => {
  test('row label "Holo" matches the Holofoil finish', () => {
    expect(P.variantMatches("Holofoil", "Holo")).toBe(true);
  });
  test('row label "Reverse Holo" matches Reverse Holofoil', () => {
    expect(P.variantMatches("Reverse Holofoil", "Reverse Holo")).toBe(true);
  });
  test('row label "normal" matches Normal', () => {
    expect(P.variantMatches("Normal", "normal")).toBe(true);
  });
  test("cross finishes never match", () => {
    expect(P.variantMatches("Reverse Holofoil", "Holo")).toBe(false);
    expect(P.variantMatches("Holofoil", "Reverse Holo")).toBe(false);
    expect(P.variantMatches("Normal", "Holo")).toBe(false);
    expect(P.variantMatches("Holofoil", "normal")).toBe(false);
  });
  test("missing/empty wantKey never matches", () => {
    expect(P.variantMatches("Holofoil", null)).toBe(false);
    expect(P.variantMatches("Holofoil", "")).toBe(false);
  });
});

describe("nearMintPrice variant selection", () => {
  test('picks the Holofoil row for a "Holo" row, not the first USD row', async () => {
    stubApi((path) => {
      if (path === "/v1/cards/424242") {
        return {
          prices: [
            { variant: "Reverse Holofoil", condition: "Near Mint", currency: "USD", market_price: 0.46 },
            { variant: "Holofoil", condition: "Near Mint", currency: "USD", market_price: 0.39 },
          ],
        };
      }
      return { data: [] };
    });
    const p = await P.nearMintPrice("424242", "Holo");
    expect(p.price).toBe(0.39);
    expect(p.variant).toBe("Holofoil");
  });

  test("returns null when the wanted finish has no listing (no wrong-finish guess)", async () => {
    stubApi((path) => {
      if (path === "/v1/cards/424243") {
        return {
          prices: [
            { variant: "Holofoil", condition: "Near Mint", currency: "USD", market_price: 1.25 },
          ],
        };
      }
      return { data: [] };
    });
    // A Reverse Holo row must NOT price off the Holofoil listing.
    expect(await P.nearMintPrice("424243", "Reverse Holo")).toBe(null);
  });

  test("prices Cosmos Holo off the Holofoil row (deliberate alias)", async () => {
    stubApi((path) => {
      if (path === "/v1/cards/424244") {
        return {
          prices: [
            { variant: "Holofoil", condition: "Near Mint", currency: "USD", market_price: 1.25 },
          ],
        };
      }
      return { data: [] };
    });
    // The provider carries no Cosmos Holo listing; Holo and Cosmos Holo
    // share the base record, so the alias is intentional.
    const p = await P.nearMintPrice("424244", "Cosmos Holo");
    expect(p.price).toBe(1.25);
    expect(p.variant).toBe("Holofoil");
  });

  test("ignores $0 provider rows (they would zero the card)", async () => {
    stubApi((path) => {
      if (path === "/v1/cards/424245") {
        return {
          prices: [
            { variant: "Holofoil", condition: "Near Mint", currency: "USD", market_price: 0 },
            { variant: "Holofoil", condition: "Near Mint", currency: "USD", market_price: 2.5 },
          ],
        };
      }
      if (path === "/v1/cards/424246") {
        return {
          prices: [
            { variant: "Holofoil", condition: "Near Mint", currency: "USD", market_price: 0 },
          ],
        };
      }
      return { data: [] };
    });
    const p = await P.nearMintPrice("424245", "Holo");
    expect(p.price).toBe(2.5);
    expect(await P.nearMintPrice("424246", "Holo")).toBe(null);
  });

  test("variant-agnostic callers (null variant) still price off any finish", async () => {
    stubApi((path) => {
      if (path === "/v1/cards/424247") {
        return {
          prices: [
            { variant: "Reverse Holofoil", condition: "Near Mint", currency: "USD", market_price: 0.46 },
          ],
        };
      }
      return { data: [] };
    });
    // rowFromCard prices a known pkmnId without re-resolving the finish.
    const p = await P.nearMintPrice("424247", null);
    expect(p.price).toBe(0.46);
  });
});

describe("needsAccentRepair", () => {
  test("flags a priced row in an accented set", () => {
    expect(C.needsAccentRepair({ set_name: "Pokémon GO", market_price: 196.25 })).toBe(true);
  });
  test("flags an unpriced row carrying a suspect pkmn_id", () => {
    expect(
      C.needsAccentRepair({ set_name: "Pokémon GO", market_price: null, pkmn_id: "10699" })
    ).toBe(true);
  });
  test("skips clean rows in accented sets (no price, no id)", () => {
    expect(
      C.needsAccentRepair({ set_name: "Pokémon GO", market_price: null, pkmn_id: null })
    ).toBe(false);
  });
  test("skips rows in plain-ASCII sets", () => {
    expect(C.needsAccentRepair({ set_name: "Scarlet & Violet 151", market_price: 5.5 })).toBe(false);
  });
  test("skips colon-prefixed sets whose name has no accents", () => {
    expect(C.needsAccentRepair({ set_name: "S10b: Pokemon GO", market_price: 1.25 })).toBe(false);
  });
  test("skips rows with no set name", () => {
    expect(C.needsAccentRepair({ set_name: null, market_price: 3 })).toBe(false);
    expect(C.needsAccentRepair({ market_price: 3 })).toBe(false);
  });
  test("never re-clears a price written after the accent fix deployed", () => {
    expect(
      C.needsAccentRepair({
        set_name: "Pokémon GO",
        market_price: 0.39,
        price_updated_at: "2026-09-24T03:46:08.00+00:00",
      })
    ).toBe(false);
  });
  test("still flags a stale pre-fix price in an accented set", () => {
    expect(
      C.needsAccentRepair({
        set_name: "Pokémon GO",
        market_price: 196.25,
        price_updated_at: "2026-09-23T06:57:18.000+00:00",
      })
    ).toBe(true);
  });
});
