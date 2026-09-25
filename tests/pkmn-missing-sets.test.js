/* VaultDex unit tests — the 2026-09-22 M6a cross-set pricing fix.
 *
 * PkmnPrices carries no Japanese M6a (30th Celebration), MC, or SM1p cards.
 * The number-only fallbacks in findCardId()/findVariantPrice() used to
 * silently match a DIFFERENT set's card with the same number — M6a Pikachu
 * #017 was priced as SV2D Clay Burst #017, which ranked false ~$800 cards
 * at the top of the collection. These tests pin the guard:
 *   1. Unsupported Japanese sets never match via the number-only fallback.
 *   2. Unsupported Japanese rows always come back unpriced.
 *   3. Supported sets still resolve exact printings (no regression).
 *   4. English pricing is never substituted for Japanese cards.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import "../js/util.js";
import "../js/pkmn.js";
import "../js/tcg-api.js"; // real normVLabel for collection.js's pure seams
import "../js/collection.js";

const P = window.App.pkmn;
const C = window.App.collection;

/* Fake the /v1/cards search response the way the proxy returns it:
 * { data: [{ id, set: { name }, number, ... }] }. */
function cardsApiResponse(cards) {
  return { data: cards.map((c) => ({ id: c.id, set: { name: c.set }, number: c.num })) };
}

const CLAY_BURST_PIKACHU_017 = { id: "52452", set: "SV2D: Clay Burst", num: "017" };
const M4_PIKACHU = { id: "90001", set: "M4: Mega Evolution", num: "023" };

/* pkmn.js's api() uses App.util.fetchWithTimeout(PROXY + "?" + q...).
 * Swap in a stub that routes /v1/cards to canned payloads. */
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
  // idCache lives inside the module closure; bypass it with fresh args per test.
});

describe("pkmnMissingSet", () => {
  test("flags the three unsupported Japanese sets", () => {
    expect(P.pkmnMissingSet("30th Celebration", "ja")).toBe(true); // M6a
    expect(P.pkmnMissingSet("Starter Decks 100 Battle Collection", "ja")).toBe(true); // MC
    expect(P.pkmnMissingSet("Sun and Moon Plus", "ja")).toBe(true); // SM1p
  });
  test("leaves supported Japanese sets alone", () => {
    expect(P.pkmnMissingSet("Mega Evolution", "ja")).toBe(false);
  });
  test("leaves English sets alone", () => {
    expect(P.pkmnMissingSet("30th Celebration", "en")).toBe(false);
    expect(P.pkmnMissingSet("Clay Burst", "en")).toBe(false);
  });
});

describe("findCardId — unsupported Japanese sets", () => {
  beforeEach(() => {
    // Provider knows Clay Burst #017 and M4 #023, but nothing for M6a.
    stubApi(() => cardsApiResponse([CLAY_BURST_PIKACHU_017, M4_PIKACHU]));
  });
  test("M6a Pikachu #017 does NOT resolve to Clay Burst #017", async () => {
    const id = await P.findCardId({ name: "Pikachu", setName: "30th Celebration", number: "017", lang: "ja" });
    expect(id).toBeNull();
  });
  test("M6a lookup returns null instead of any cross-set number hit", async () => {
    const id = await P.findCardId({ name: "Pikachu", setName: "30th Celebration", number: "023", lang: "ja" });
    expect(id).toBeNull();
  });
  test("MC cards never match another set's card", async () => {
    const id = await P.findCardId({ name: "Charizard", setName: "Starter Decks 100 Battle Collection", number: "017", lang: "ja" });
    expect(id).toBeNull();
  });
});

describe("findCardId — supported sets still resolve exactly", () => {
  beforeEach(() => {
    stubApi(() => cardsApiResponse([CLAY_BURST_PIKACHU_017, M4_PIKACHU]));
  });
  test("exact set+number match still wins for a supported set", async () => {
    const id = await P.findCardId({ name: "Pikachu", setName: "Mega Evolution", number: "023", lang: "ja" });
    expect(id).toBe("90001");
  });
});

describe("findVariantPrice — unsupported Japanese sets stay unpriced", () => {
  beforeEach(() => {
    stubApi(() => cardsApiResponse([CLAY_BURST_PIKACHU_017, M4_PIKACHU]));
  });
  test("M6a Pikachu #017 returns null, not Clay Burst's price", async () => {
    const m = await P.findVariantPrice({
      name: "Pikachu", setName: "30th Celebration", number: "017", lang: "ja",
      pkmnLabel: "holofoil", priceVariant: "holofoil"
    });
    expect(m).toBeNull();
  });
});

describe("priceForRow — unsupported Japanese rows stay unpriced", () => {
  test("a row with a stale pkmn_id is not priced off it", async () => {
    stubApi(() => {
      throw new Error("should never be called");
    });
    const p = await P.priceForRow({
      card_name: "Pikachu",
      set_name: "30th Celebration",
      number: "017",
      variant: "Holo",
      lang: "ja",
      pkmn_id: "52452", // poisoned residue from the old fallback
    });
    expect(p).toBeNull();
  });
  test("a row with no pkmn_id never looks the provider up", async () => {
    stubApi(() => {
      throw new Error("should never be called");
    });
    const p = await P.priceForRow({
      card_name: "Pikachu",
      set_name: "30th Celebration",
      number: "017",
      variant: "Holo",
      lang: "ja",
      pkmn_id: null,
    });
    expect(p).toBeNull();
  });
});

describe("needsMissingSetRepair — repair predicate (2026-09-25 hardening)", () => {
  const m6a = { set_name: "30th Celebration", set_id: "ja-M6a" };
  const m4 = { set_name: "Mega Evolution", set_id: "ja-M4" };
  const PRE_CUTOFF = "2026-09-20T00:00:00.000Z"; // before MISSINGSET_REPAIR_CUTOFF_MS
  const POST_CUTOFF = "2026-09-26T00:00:00.000Z"; // after the cutoff
  test("flags an M6a row with pkmnprices residue from the old fallback", () => {
    expect(C.needsMissingSetRepair({ ...m6a, pkmn_id: null, market_price: 800, price_source: "pkmnprices", price_updated_at: PRE_CUTOFF })).toBe(true);
  });
  test("flags an M6a row with a stored pkmn_id", () => {
    expect(C.needsMissingSetRepair({ ...m6a, pkmn_id: "52452", market_price: 800 })).toBe(true);
  });
  test("flags a pkmn_id regardless of timestamp (fixed code never writes one here)", () => {
    expect(C.needsMissingSetRepair({ ...m6a, pkmn_id: "52452", market_price: null, price_updated_at: POST_CUTOFF })).toBe(true);
  });
  test("leaves a clean M6a row alone (no id, no price)", () => {
    expect(C.needsMissingSetRepair({ ...m6a, pkmn_id: null, market_price: null })).toBe(false);
  });
  test("leaves a priced supported-set row alone", () => {
    expect(C.needsMissingSetRepair({ ...m4, pkmn_id: "90001", market_price: 12.5, price_source: "pkmnprices" })).toBe(false);
  });
  test("PRESERVES an honest legacy catalog price (price_source null)", () => {
    // Newly added M6a/MC/SM1p cards get real TCGdex catalog prices via
    // legacyMarket — the old predicate erased them on every load.
    expect(C.needsMissingSetRepair({ ...m6a, pkmn_id: null, market_price: 5, price_source: null })).toBe(false);
    expect(C.needsMissingSetRepair({ set_name: "Starter Decks 100 Battle Collection", set_id: "ja-MC", pkmn_id: null, market_price: 5, price_source: null })).toBe(false);
    expect(C.needsMissingSetRepair({ set_name: "Sun and Moon Plus", set_id: "ja-SM1p", pkmn_id: null, market_price: 5, price_source: null })).toBe(false);
  });
  test("trusts a pkmnprices price written after the cutoff", () => {
    expect(C.needsMissingSetRepair({ ...m6a, pkmn_id: null, market_price: 800, price_source: "pkmnprices", price_updated_at: POST_CUTOFF })).toBe(false);
  });
  test("does not null a graded-source price without a pkmn_id", () => {
    expect(C.needsMissingSetRepair({ ...m6a, pkmn_id: null, market_price: 1200, price_source: "pkmnprices-graded" })).toBe(false);
  });
});

describe("repairMissingSetPrices — one-shot, preserves honest prices", () => {
  const FLAG = "vd_missingset_repair_v1";
  const PRE_CUTOFF = "2026-09-20T00:00:00.000Z";
  let realAuth, realSb;
  const updates = [];
  beforeEach(() => {
    realAuth = window.App.auth;
    realSb = window.App.sb;
    updates.length = 0;
    window.App.auth = { user: { id: "user-1" } };
    window.App.sb = {
      from: () => ({
        update: (patch) => ({
          eq: () => ({
            eq: async (k, v) => {
              updates.push(patch);
              return { error: null };
            },
          }),
        }),
      }),
    };
    window.localStorage.removeItem(FLAG);
  });
  afterEach(() => {
    window.App.auth = realAuth;
    window.App.sb = realSb;
    window.localStorage.removeItem(FLAG);
  });

  test("clears poisoned residue, keeps honest catalog prices, then never re-runs", async () => {
    const poisoned = { id: "r1", card_name: "Pikachu", set_name: "30th Celebration", set_id: "ja-M6a", pkmn_id: "52452", market_price: 800, price_source: "pkmnprices", price_updated_at: PRE_CUTOFF, quantity: 1 };
    const honest = { id: "r2", card_name: "Mew", set_name: "30th Celebration", set_id: "ja-M6a", pkmn_id: null, market_price: 5, price_source: null, price_updated_at: PRE_CUTOFF, quantity: 1 };
    await C.repairMissingSetPrices([poisoned, honest]);
    // One write: the poisoned row. The honest row is never touched.
    expect(updates.length).toBe(1);
    expect(updates[0].market_price).toBe(null);
    expect(updates[0].pkmn_id).toBe(null);
    expect(poisoned.market_price).toBe(null);
    expect(poisoned.quantity).toBe(1); // ownership untouched
    expect(honest.market_price).toBe(5); // honest catalog price survives
    expect(window.localStorage.getItem(FLAG)).toBe("1");
    // Second run is a no-op even with residue-looking rows.
    updates.length = 0;
    await C.repairMissingSetPrices([poisoned, honest]);
    expect(updates.length).toBe(0);
  });

  test("a failed write does not set the flag (retries next boot)", async () => {
    window.App.sb = {
      from: () => ({
        update: () => ({ eq: () => ({ eq: async () => ({ error: new Error("boom") }) }) }),
      }),
    };
    await C.repairMissingSetPrices([
      { id: "r9", card_name: "Pikachu", set_name: "30th Celebration", set_id: "ja-M6a", pkmn_id: "52452", market_price: 800, price_source: "pkmnprices", price_updated_at: PRE_CUTOFF },
    ]);
    expect(window.localStorage.getItem(FLAG)).toBe(null);
  });
});
