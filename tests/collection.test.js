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
    market_price: null, price_updated_at: null, quantity: 1, ...o,
  });

  test("highest position value (price x quantity) refreshes first", () => {
    const cheap = row({ card_id: "cheap", market_price: 5, quantity: 1 });
    const pricey = row({ card_id: "pricey", market_price: 100, quantity: 1 });
    expect(C.sortRefreshQueue([cheap, pricey]).map((r) => r.card_id))
      .toEqual(["pricey", "cheap"]);
  });

  test("quantity multiplies position value", () => {
    const single = row({ card_id: "single", market_price: 50, quantity: 1 });
    const stack = row({ card_id: "stack", market_price: 20, quantity: 10 }); // 200
    expect(C.sortRefreshQueue([single, stack]).map((r) => r.card_id))
      .toEqual(["stack", "single"]);
  });

  test("unpriced rows sort last", () => {
    const priced = row({ card_id: "priced", market_price: 1, quantity: 1 });
    const unpriced = row({ card_id: "unpriced" });
    expect(C.sortRefreshQueue([unpriced, priced]).map((r) => r.card_id))
      .toEqual(["priced", "unpriced"]);
  });

  test("graded status no longer affects priority", () => {
    const graded = row({ card_id: "gr", grading_company: "PSA", grade: "10", market_price: 5, quantity: 1 });
    const raw = row({ card_id: "raw", market_price: 50, quantity: 1 });
    expect(C.sortRefreshQueue([graded, raw]).map((r) => r.card_id))
      .toEqual(["raw", "gr"]);
  });

  test("does not mutate the input array", () => {
    const a = row({ card_id: "a", market_price: 1 });
    const b = row({ card_id: "b", market_price: 100 });
    const input = [a, b];
    C.sortRefreshQueue(input);
    expect(input.map((r) => r.card_id)).toEqual(["a", "b"]);
  });

  test("empty input returns empty", () => {
    expect(C.sortRefreshQueue([])).toEqual([]);
  });
});

describe("needsPriceRefresh with custom maxAgeMs", () => {
  const now = Date.now();
  const row = (updatedAt) => ({ price_updated_at: updatedAt });

  test("uses the default 24h window when maxAgeMs is omitted", () => {
    const justOver = row(new Date(now - 25 * 60 * 60 * 1000).toISOString());
    const justUnder = row(new Date(now - 23 * 60 * 60 * 1000).toISOString());
    expect(C.needsPriceRefresh(justOver, now)).toBe(true);
    expect(C.needsPriceRefresh(justUnder, now)).toBe(false);
  });

  test("honors the lazy (24h) threshold", () => {
    const twelveH = row(new Date(now - 12 * 60 * 60 * 1000).toISOString());
    const twoDays = row(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString());
    expect(C.needsPriceRefresh(twelveH, now, C.LAZY_REFRESH_MS)).toBe(false);
    expect(C.needsPriceRefresh(twoDays, now, C.LAZY_REFRESH_MS)).toBe(true);
  });

  test("LAZY_REFRESH_MS is 24h", () => {
    expect(C.LAZY_REFRESH_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("tierRefreshQueue", () => {
  const now = Date.now();
  const mkrow = (id, price, qty, ageH) => ({
    id: id, card_id: "c-" + id, card_name: "C",
    market_price: price, quantity: qty,
    price_updated_at: new Date(now - ageH * 60 * 60 * 1000).toISOString(),
  });
  // 120 rows: values 120..1, all stale 25h (tier-1 eligible by value rank).
  const many = [];
  for (var v = 120; v >= 1; v--) many.push(mkrow("r" + v, v, 1, 25));

  test("tier 1 is the top 100 by position value", () => {
    const out = C.tierRefreshQueue(many, now);
    expect(out.length).toBe(100);
    expect(out[0].id).toBe("r120");
    expect(out[99].id).toBe("r21");
  });

  test("fresh top-100 rows are skipped, tail fills from 30-day staleness", () => {
    // Top 100 (values 120..21) fresh at 1h; tail (values 20..1) stale 31 days.
    const t = [];
    for (var v = 120; v >= 1; v--) {
      t.push(v > 20 ? mkrow("r" + v, v, 1, 1) : mkrow("r" + v, v, 1, 31 * 24 + 1));
    }
    const out = C.tierRefreshQueue(t, now);
    // No tier-1 (all fresh); tail = rows 1..20 (values 20..1), value-ordered.
    expect(out.map(function (r) { return r.id; }))
      .toEqual(["r20", "r19", "r18", "r17", "r16", "r15", "r14", "r13", "r12", "r11",
                "r10", "r9", "r8", "r7", "r6", "r5", "r4", "r3", "r2", "r1"]);
  });

  test("tail rows fresher than 30 days are excluded", () => {
    const t = [];
    for (var v = 120; v >= 1; v--) {
      // Top 100 stale 25h (tier 1); rest stale 10 days (too fresh for tail).
      t.push(mkrow("r" + v, v, 1, v > 20 ? 25 : 10 * 24));
    }
    const out = C.tierRefreshQueue(t, now);
    expect(out.length).toBe(100); // tier 1 only
  });

  test("does not mutate the input array", () => {
    const input = many.slice();
    C.tierRefreshQueue(input, now);
    expect(input[0].id).toBe("r120");
    expect(input.length).toBe(120);
  });
});

describe("isCreditExhausted (429 classification, 2026-10-07)", () => {
  test("detects PkmnPrices credit_limit_exceeded", () => {
    expect(C.isCreditExhausted({ status: 429, message: "PkmnPrices error (HTTP 429). credit_limit_exceeded" })).toBe(true);
    expect(C.isCreditExhausted({ status: 429, message: "CREDIT_LIMIT_EXCEEDED" })).toBe(true);
  });

  test("proxy's own per-IP 429 is throttling, not budget", () => {
    expect(C.isCreditExhausted({ status: 429, message: "PkmnPrices error (HTTP 429). Too many requests." })).toBe(false);
  });

  test("non-429 and empty errors are not budget exhaustion", () => {
    expect(C.isCreditExhausted({ status: 500, message: "boom" })).toBe(false);
    expect(C.isCreditExhausted(null)).toBe(false);
    expect(C.isCreditExhausted({})).toBe(false);
  });
});
