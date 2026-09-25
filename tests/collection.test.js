/* VaultDex unit tests — js/collection.js pure seams.
 *
 * collection.js is Supabase-coupled, so the async DB paths stay behind the
 * smoke tests. What's tested here are the pure helpers the collection
 * mutations depend on — the exact spots where the real historical bugs
 * lived (duplicate rows, quantity handling, mover history, ja set ids).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import "../js/util.js";
import "../js/tcg-api.js"; // real normVLabel for findMatchingRow tests
import "../js/collection.js";

const C = window.App.collection;
const realNormVLabel = window.App.tcg.normVLabel;

beforeEach(() => {
  window.App.tcg = {
    variantsOf: () => [],
    marketOf: () => null,
    normVLabel: realNormVLabel,
  };
});

describe("clampQuantity (addItem quantity guard)", () => {
  test("floors at 1", () => {
    expect(C.clampQuantity(0)).toBe(1);
    expect(C.clampQuantity(-5)).toBe(1);
    expect(C.clampQuantity(undefined)).toBe(1);
    expect(C.clampQuantity(null)).toBe(1);
    expect(C.clampQuantity(NaN)).toBe(1);
  });

  test("caps at 99", () => {
    expect(C.clampQuantity(100)).toBe(99);
    expect(C.clampQuantity(1000)).toBe(99);
  });

  test("passes through the valid range", () => {
    expect(C.clampQuantity(1)).toBe(1);
    expect(C.clampQuantity(50)).toBe(50);
    expect(C.clampQuantity(99)).toBe(99);
  });
});

describe("rowSetId (ja- prefixing for pricing)", () => {
  const card = (id, lang) => ({ set: { id, lang } });

  test("leaves English ids alone", () => {
    expect(C.rowSetId(card("sv01", "en"))).toEqual({ setId: "sv01", setLang: "en" });
  });

  test("prefixes bare Japanese ids", () => {
    expect(C.rowSetId(card("M4", "ja"))).toEqual({ setId: "ja-M4", setLang: "ja" });
  });

  test("does not double-prefix", () => {
    expect(C.rowSetId(card("ja-M4", "ja"))).toEqual({ setId: "ja-M4", setLang: "ja" });
  });

  test("neo1 stays language-distinct", () => {
    expect(C.rowSetId(card("neo1", "en")).setId).toBe("neo1");
    expect(C.rowSetId(card("neo1", "ja")).setId).toBe("ja-neo1");
  });

  test("missing set degrades gracefully", () => {
    expect(C.rowSetId({})).toEqual({ setId: null, setLang: "en" });
  });
});

describe("needsPriceRefresh (24h incremental filter)", () => {
  const H = 60 * 60 * 1000;
  const now = Date.now();
  const ago = (h) => new Date(now - h * H).toISOString();

  test("refreshes rows with no timestamp", () => {
    expect(C.needsPriceRefresh({}, now)).toBe(true);
    expect(C.needsPriceRefresh({ price_updated_at: null }, now)).toBe(true);
  });

  test("refreshes rows older than 24h", () => {
    expect(C.needsPriceRefresh({ price_updated_at: ago(25) }, now)).toBe(true);
  });

  test("skips rows refreshed within 24h", () => {
    expect(C.needsPriceRefresh({ price_updated_at: ago(23) }, now)).toBe(false);
    expect(C.needsPriceRefresh({ price_updated_at: ago(0) }, now)).toBe(false);
  });

  test("unparseable timestamps refresh rather than stall", () => {
    expect(C.needsPriceRefresh({ price_updated_at: "not-a-date" }, now)).toBe(true);
  });
});

describe("moverUpdate (prev_price semantics)", () => {
  const now = new Date().toISOString();

  test("returns null for a non-numeric price", () => {
    expect(C.moverUpdate({}, null, "pkmnprices", now)).toBeNull();
    expect(C.moverUpdate({}, undefined, "pkmnprices", now)).toBeNull();
  });

  test("first-time price records no mover data", () => {
    const u = C.moverUpdate({}, 5.0, "pkmnprices", now);
    expect(u).toEqual({ market_price: 5.0, price_source: "pkmnprices", price_updated_at: now });
    expect("prev_price" in u).toBe(false);
  });

  test("unchanged price records no mover data", () => {
    const row = { market_price: 5.0, price_updated_at: "2026-09-01T00:00:00Z" };
    const u = C.moverUpdate(row, 5.0, "pkmnprices", now);
    expect("prev_price" in u).toBe(false);
  });

  test("changed price records the old price", () => {
    const row = { market_price: 5.0, price_updated_at: "2026-09-01T00:00:00Z" };
    const u = C.moverUpdate(row, 7.5, "pkmnprices", now);
    expect(u.prev_price).toBe(5.0);
    expect(u.prev_price_at).toBe("2026-09-01T00:00:00Z");
    expect(u.market_price).toBe(7.5);
  });

  test("changed price with no prior timestamp still records prev_price", () => {
    const u = C.moverUpdate({ market_price: 5.0 }, 7.5, "pkmnprices-graded", now);
    expect(u.prev_price).toBe(5.0);
    expect(u.prev_price_at).toBeNull();
    expect(u.price_source).toBe("pkmnprices-graded");
  });
});

describe("moverUpdate price_currency", () => {
  const now = new Date().toISOString();

  test("omits price_currency when the column is unsupported (pre-migration)", () => {
    C._setPriceCurrencySupport(false);
    const u = C.moverUpdate({}, 5.0, "pkmnprices", now, "EUR");
    expect("price_currency" in u).toBe(false);
    expect(u.market_price).toBe(5.0);
  });

  test("includes the price currency when supported", () => {
    C._setPriceCurrencySupport(true);
    const u = C.moverUpdate({}, 5.0, "pkmnprices", now, "EUR");
    expect(u.price_currency).toBe("EUR");
    C._setPriceCurrencySupport(false);
  });

  test("defaults a missing currency to USD", () => {
    C._setPriceCurrencySupport(true);
    const u = C.moverUpdate({}, 5.0, "pkmnprices", now, null);
    expect(u.price_currency).toBe("USD");
    C._setPriceCurrencySupport(false);
  });
});

describe("totals", () => {
  test("sums value x quantity and counts copies", () => {
    const t = C.totals([
      { quantity: 2, market_price: 5 },
      { quantity: 1, market_price: 10 },
    ]);
    expect(t).toEqual({ value: 20, count: 3 });
  });

  test("skips unpriced rows in value but counts them", () => {
    const t = C.totals([{ quantity: 3 }, { quantity: 1, market_price: 4 }]);
    expect(t).toEqual({ value: 4, count: 4 });
  });

  test("empty collection is zero", () => {
    expect(C.totals([])).toEqual({ value: 0, count: 0 });
    expect(C.totals(null)).toEqual({ value: 0, count: 0 });
  });
});

describe("fetchAllPages (PostgREST 1000-row pagination)", () => {
  test("concatenates pages and stops on a short page", async () => {
    const calls = [];
    const qb = async (from, to) => {
      calls.push([from, to]);
      if (from === 0) return { data: new Array(1000).fill({}), error: null };
      return { data: [{}, {}], error: null };
    };
    const rows = await C.fetchAllPages(qb);
    expect(rows.length).toBe(1002);
    expect(calls).toEqual([[0, 999], [1000, 1999]]);
  });

  test("single short page needs one call", async () => {
    const qb = async () => ({ data: [{ a: 1 }], error: null });
    expect(await C.fetchAllPages(qb)).toEqual([{ a: 1 }]);
  });

  test("throws on query error", async () => {
    const qb = async () => ({ data: null, error: new Error("boom") });
    await expect(C.fetchAllPages(qb)).rejects.toThrow("boom");
  });
});

describe("legacyMarket (catalog-price fallback)", () => {
  const card = { id: "x" };

  test("uses the exact variant's market price", () => {
    window.App.tcg.variantsOf = () => [{ key: "holo", prices: { market: 5.5 } }];
    expect(C.legacyMarket(card, "holo")).toBe(5.5);
  });

  test("falls back to the card market price for unknown variants", () => {
    window.App.tcg.variantsOf = () => [];
    window.App.tcg.marketOf = () => 3.25;
    expect(C.legacyMarket(card, "holo")).toBe(3.25);
  });

  test("returns null when nothing is priced", () => {
    expect(C.legacyMarket(card, "holo")).toBeNull();
  });
});

describe("defaultVariant", () => {
  test("picks the first (highest-priced) variant", () => {
    window.App.tcg.variantsOf = () => [{ key: "holo" }, { key: "normal" }];
    expect(C.defaultVariant({})).toBe("holo");
  });

  test("falls back to normal", () => {
    expect(C.defaultVariant({})).toBe("normal");
  });
});

describe("findMatchingRow (2026-09-18)", () => {
  const F = () => window.App.collection.findMatchingRow;

  test("distinct printings sharing one PkmnPrices record stay separate", () => {
    // Holo and Cosmos Holo both price off the base record (provider has no
    // cosmos listing) — same pkmn_id, different printings, must NOT merge.
    const rows = [{ id: 1, variant: "Holo", pkmn_id: 24638, quantity: 1 }];
    expect(F()(rows, "Cosmos Holo", 24638)).toBeNull();
    expect(F()(rows, "Holo", 24638)).toEqual(rows[0]);
  });

  test("same printing under different label spellings still merges", () => {
    const rows = [{ id: 1, variant: "Holo", pkmn_id: 24638, quantity: 1 }];
    expect(F()(rows, "Holofoil", 24638)).toEqual(rows[0]);
    expect(F()(rows, "holo", 24638)).toEqual(rows[0]);
  });

  test("pkmn_id null only matches pkmn_id null", () => {
    const rows = [{ id: 1, variant: "Holo", pkmn_id: 24638, quantity: 1 }];
    expect(F()(rows, "Holo", null)).toBeNull();
    const nullRows = [{ id: 2, variant: "Holo", pkmn_id: null, quantity: 1 }];
    expect(F()(nullRows, "Holo", null)).toEqual(nullRows[0]);
    expect(F()(nullRows, "Holo", 24638)).toBeNull();
  });

  test("empty rows -> null", () => {
    expect(F()([], "Holo", 24638)).toBeNull();
    expect(F()(null, "Holo", 24638)).toBeNull();
  });
});

describe("backfillRowImages (collection image healing)", () => {
  const IMG = "https://images.pkmnprices.com/cards/c08cd7c4c5af5aa2.webp";
  const CATALOG = [
    { id: "svp-085", images: { small: IMG, large: IMG } },
    { id: "svp-500", images: { small: null, large: null } }, // deliberately imageless
  ];
  let calls, updates, prevAuth, prevSb;

  beforeEach(() => {
    calls = [];
    updates = [];
    prevAuth = window.App.auth;
    prevSb = window.App.sb;
    window.App.tcg = {
      variantsOf: () => [],
      marketOf: () => null,
      normVLabel: realNormVLabel,
      getSetCardList: async (appId) => { calls.push(appId); return CATALOG; },
    };
    window.App.auth = { user: { id: "u1" } };
    window.App.sb = {
      from: (table) => ({
        update: (patch) => {
          const builder = {
            eq: (col, val) => { updates.push({ table, patch, col, val }); return builder; },
          };
          builder.then = (resolve) => resolve({ error: null });
          return builder;
        },
      }),
    };
  });

  afterEach(() => {
    window.App.auth = prevAuth;
    window.App.sb = prevSb;
  });

  const row = (over) => Object.assign(
    { id: 7, card_id: "svp-085", card_name: "Pikachu with Grey Felt Hat", set_id: "svp", image_small: null, image_large: null },
    over
  );

  test("leaves rows that already have images alone (no catalog fetch)", async () => {
    const rows = [row({ image_small: "x" })];
    await C.backfillRowImages(rows, true);
    expect(calls).toEqual([]);
    expect(rows[0].image_small).toBe("x");
    expect(updates).toEqual([]);
  });

  test("fills missing images from the catalog in memory", async () => {
    const rows = [row()];
    await C.backfillRowImages(rows, false);
    expect(calls).toEqual(["svp"]);
    expect(rows[0].image_small).toBe(IMG);
    expect(rows[0].image_large).toBe(IMG);
    expect(updates).toEqual([]);
  });

  test("writes healed URLs back when persist is true", async () => {
    const rows = [row()];
    await C.backfillRowImages(rows, true);
    expect(updates.length).toBeGreaterThan(0);
    const up = updates.find((u) => u.col === "id");
    expect(up.patch).toEqual({ image_small: IMG, image_large: IMG });
    expect(updates.some((u) => u.col === "user_id" && u.val === "u1")).toBe(true);
  });

  test("leaves deliberately imageless cards alone (no write)", async () => {
    const rows = [row({ card_id: "svp-500", card_name: "Terapagos & Friends" })];
    await C.backfillRowImages(rows, true);
    expect(rows[0].image_small).toBeNull();
    expect(updates).toEqual([]);
  });

  test("skips rows without a set_id", async () => {
    const rows = [row({ set_id: null })];
    await C.backfillRowImages(rows, true);
    expect(calls).toEqual([]);
    expect(rows[0].image_small).toBeNull();
  });

  test("no-op on empty input", async () => {
    expect(await C.backfillRowImages([], true)).toEqual([]);
    expect(await C.backfillRowImages(null, true)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("sortRefreshQueue (refresh priority)", () => {
  const row = (o) => ({
    card_id: "x", card_name: "X", grading_company: null, grade: null,
    market_price: null, price_updated_at: null, ...o,
  });

  test("unpriced graded rows go before unpriced raw rows", () => {
    const raw = row({ card_id: "raw-1" });
    const graded = row({ card_id: "gr-1", grading_company: "PSA", grade: "10" });
    expect(C.sortRefreshQueue([raw, graded]).map((r) => r.card_id))
      .toEqual(["gr-1", "raw-1"]);
  });

  test("unpriced raw rows go before priced-but-stale rows", () => {
    const stale = row({ card_id: "stale-1", market_price: 5, price_updated_at: "2026-01-01T00:00:00Z" });
    const unpriced = row({ card_id: "raw-2" });
    expect(C.sortRefreshQueue([stale, unpriced]).map((r) => r.card_id))
      .toEqual(["raw-2", "stale-1"]);
  });

  test("priced graded rows are not treated as priority (already visible)", () => {
    const pricedGraded = row({ card_id: "gr-2", grading_company: "PSA", grade: "10",
      market_price: 100, price_updated_at: "2026-09-20T00:00:00Z" });
    const unpricedGraded = row({ card_id: "gr-3", grading_company: "PSA", grade: "10" });
    expect(C.sortRefreshQueue([pricedGraded, unpricedGraded]).map((r) => r.card_id))
      .toEqual(["gr-3", "gr-2"]);
  });

  test("stalest price refreshes first within the same priority class", () => {
    const newer = row({ card_id: "n", market_price: 5, price_updated_at: "2026-09-20T00:00:00Z" });
    const older = row({ card_id: "o", market_price: 5, price_updated_at: "2026-09-10T00:00:00Z" });
    expect(C.sortRefreshQueue([newer, older]).map((r) => r.card_id))
      .toEqual(["o", "n"]);
  });

  test("does not mutate the input array", () => {
    const a = row({ card_id: "a" });
    const b = row({ card_id: "b", grading_company: "PSA", grade: "10" });
    const input = [a, b];
    C.sortRefreshQueue(input);
    expect(input.map((r) => r.card_id)).toEqual(["a", "b"]);
  });

  test("empty input returns empty", () => {
    expect(C.sortRefreshQueue([])).toEqual([]);
  });
});
