/* VaultDex unit tests — the 2026-09-24 graded exact-attribution fix.
 *
 * gradedPrice() is documented as "only attribution 'exact' rows feed the
 * price, everything else is ignored" — but the code fell back to ALL comps
 * when no exact-attribution comp existed. Latias & Latios GX PSA 10
 * returned six unknown-attribution German eBay listings at €1,313–€14,999
 * and the row was priced at their median: €5,496.45. Fantasy money.
 *
 * The fix: only exact-attribution comps feed the price. With no exact
 * comp gradedPrice() returns null and callers fall back to the raw Near
 * Mint price with its explicit label. A one-shot repair
 * (gradedAttributionNeedsRepair) clears pre-fix pkmnprices-graded prices
 * so poisoned rows reprice under the fixed lookup.
 *
 * These tests pin:
 *   1. gradedPrice returns null when every comp is unknown-attribution
 *      (the live Latias & Latios GX response).
 *   2. gradedPrice ignores unknown/shared comps when exact comps exist.
 *   3. gradedPrice still returns the median of exact comps (unchanged).
 *   4. gradedAttributionNeedsRepair flags exactly the rows the old
 *      fallback could have poisoned.
 */
import { describe, test, expect, afterEach } from "vitest";
import "../js/util.js";
import "../js/pkmn.js";
import "../js/collection.js";

const P = window.App.pkmn;
const C = window.App.collection;

function stubListings(rows) {
  window.App.util.fetchWithTimeout = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: rows }),
  });
}
const realFetchWithTimeout = window.App.util.fetchWithTimeout;
afterEach(() => {
  window.App.util.fetchWithTimeout = realFetchWithTimeout;
});

function comp(price, attribution, extra) {
  return Object.assign(
    {
      id: "x",
      title: "Latias & Latios GX PSA 10",
      price: price,
      currency: "EUR",
      grader: "PSA",
      grade: "10",
      attribution: attribution,
      sold_at: "2026-09-13T00:00:00Z",
      ingested_at: "2026-09-14T00:00:00Z",
    },
    extra || {}
  );
}

/* The live 2026-09-24 response for /v1/cards/163023/listings/ebay
 * (graded=true&grader=PSA&grade=10): six rows, ALL unknown attribution. */
const LATIAS_UNKNOWN = [
  comp(4812.43, "unknown"),
  comp(14999.0, "unknown"),
  comp(14999.0, "unknown"),
  comp(6180.47, "unknown"),
  comp(4802.71, "unknown"),
  comp(1313.01, "unknown"),
];

describe("gradedPrice exact-attribution", () => {
  test("returns null when every comp is unknown-attribution (Latias & Latios GX)", async () => {
    stubListings(LATIAS_UNKNOWN);
    expect(await P.gradedPrice(163023, "PSA", "10")).toBeNull();
  });

  test("returns null when every comp is shared-attribution", async () => {
    stubListings([comp(500, "shared"), comp(600, "shared")]);
    expect(await P.gradedPrice(163023, "PSA", "10")).toBeNull();
  });

  test("ignores unknown comps when exact comps exist (median of exact only)", async () => {
    stubListings([
      comp(14999.0, "unknown"),
      comp(400, "exact", { sold_at: "2026-09-12T00:00:00Z" }),
      comp(600, "exact", { sold_at: "2026-09-10T00:00:00Z" }),
      comp(1313.01, "unknown"),
    ]);
    const g = await P.gradedPrice(163023, "PSA", "10");
    expect(g).not.toBeNull();
    expect(g.price).toBe(500); /* median of [400, 600], unknowns ignored */
    expect(g.source).toBe("pkmnprices-graded");
  });

  test("median of exact comps is unchanged (normal case)", async () => {
    stubListings([
      comp(300, "exact", { currency: "USD", sold_at: "2026-09-13T00:00:00Z" }),
      comp(500, "exact", { currency: "USD", sold_at: "2026-09-12T00:00:00Z" }),
      comp(400, "exact", { currency: "USD", sold_at: "2026-09-11T00:00:00Z" }),
    ]);
    const g = await P.gradedPrice(163023, "PSA", "10");
    expect(g.price).toBe(400);
    expect(g.currency).toBe("USD");
  });

  test("returns null on empty listings", async () => {
    stubListings([]);
    expect(await P.gradedPrice(163023, "PSA", "10")).toBeNull();
  });
});

describe("gradedAttributionNeedsRepair", () => {
  const OLD = "2026-09-24T00:11:32Z"; /* Latias poisoned price, pre-fix */
  const NEW = "2026-09-25T02:00:00Z"; /* after the graded fix deploys */

  test("flags a pre-fix pkmnprices-graded price", () => {
    expect(
      C.gradedAttributionNeedsRepair({
        price_source: "pkmnprices-graded",
        market_price: 5496.45,
        price_updated_at: OLD,
      })
    ).toBe(true);
  });

  test("ignores a post-fix pkmnprices-graded price (never re-cleared)", () => {
    expect(
      C.gradedAttributionNeedsRepair({
        price_source: "pkmnprices-graded",
        market_price: 500,
        price_updated_at: NEW,
      })
    ).toBe(false);
  });

  test("ignores non-graded price sources", () => {
    expect(
      C.gradedAttributionNeedsRepair({
        price_source: "pkmnprices",
        market_price: 5496.45,
        price_updated_at: OLD,
      })
    ).toBe(false);
  });

  test("ignores rows with no price", () => {
    expect(
      C.gradedAttributionNeedsRepair({
        price_source: "pkmnprices-graded",
        market_price: null,
        price_updated_at: OLD,
      })
    ).toBe(false);
  });

  test("treats a null timestamp as old (fail toward clearing)", () => {
    expect(
      C.gradedAttributionNeedsRepair({
        price_source: "pkmnprices-graded",
        market_price: 100,
        price_updated_at: null,
      })
    ).toBe(true);
  });
});

/* The 2026-09-25 one-shot regression: the first version of the repair was
 * guarded by the timestamp cutoff alone, so a price the FIXED code wrote
 * before the cutoff passed (Latias & Latios GX at $16,338.17, written
 * 00:27Z with a 01:00Z cutoff) was re-cleared on the next collection
 * read — wipe-looping every graded price until the top of the hour. The
 * repair is now one-shot via a localStorage flag: after a successful pass
 * later runs are a no-op, so fresh fixed prices are never re-cleared.
 *
 * The 2026-09-25 continuity guardrail: the repair no longer deletes the
 * displayed price at all — it clears the poisoned pkmn_id and forces the
 * row stale, keeping the old price until the refresh overwrites it in a
 * single write, so the collection total and value graph never dip
 * mid-repair. */
describe("repairGradedAttributionPrices one-shot flag", () => {
  const FLAG = "vd_graded_attribution_repaired_v1";

  function stubApp() {
    const realAuth = window.App.auth;
    const realSb = window.App.sb;
    window.App.auth = { user: { id: "user-1" } };
    const updates = [];
    window.App.sb = {
      from: () => ({
        select: () => ({ limit: async () => ({ error: null }) }),
        update: (patch) => ({
          eq: () => ({
            eq: async () => {
              updates.push(patch);
              return { error: null };
            },
          }),
        }),
      }),
    };
    return { realAuth, realSb, updates };
  }

  function badRow() {
    return {
      id: "row-1",
      card_name: "Latias & Latios GX",
      price_source: "pkmnprices-graded",
      market_price: 5496.45,
      price_updated_at: "2026-09-24T00:00:00Z",
      pkmn_id: 163023,
      grading_company: "PSA",
      grade: "10",
    };
  }

  test("forces reprice once (keeping the displayed price), then leaves fresh prices alone", async () => {
    window.localStorage.removeItem(FLAG);
    const { realAuth, realSb, updates } = stubApp();
    try {
      const row = badRow();
      await C.repairGradedAttributionPrices([row]);
      expect(updates.length).toBe(1);
      // Continuity: the displayed price is never in the patch.
      expect("market_price" in updates[0]).toBe(false);
      expect("price_source" in updates[0]).toBe(false);
      expect(updates[0].pkmn_id).toBe(null);
      expect(updates[0].price_updated_at).toBe("2000-01-01T00:00:00.000Z");
      expect(row.market_price).toBe(5496.45);
      expect(row.pkmn_id).toBe(null);
      expect(window.localStorage.getItem(FLAG)).toBe("1");

      // Second run: a freshly repriced row (fixed lookup, post-cutoff
      // timestamp) must NOT be cleared again.
      updates.length = 0;
      await C.repairGradedAttributionPrices([
        {
          id: "row-1",
          card_name: "Latias & Latios GX",
          price_source: "pkmnprices-graded",
          market_price: 16338.17,
          price_updated_at: "2026-09-25T00:27:13.349+00:00",
          pkmn_id: 21693,
          grading_company: "PSA",
          grade: "10",
        },
      ]);
      expect(updates.length).toBe(0);
    } finally {
      window.App.auth = realAuth;
      window.App.sb = realSb;
      window.localStorage.removeItem(FLAG);
    }
  });

  test("retries on the next boot when the clear fails", async () => {
    window.localStorage.removeItem(FLAG);
    const { realAuth, realSb } = stubApp();
    window.App.sb = {
      from: () => ({
        select: () => ({ limit: async () => ({ error: null }) }),
        update: () => ({ eq: () => ({ eq: async () => ({ error: new Error("boom") }) }) }),
      }),
    };
    try {
      await C.repairGradedAttributionPrices([badRow()]);
      expect(window.localStorage.getItem(FLAG)).toBe(null);
    } finally {
      window.App.auth = realAuth;
      window.App.sb = realSb;
      window.localStorage.removeItem(FLAG);
    }
  });
});
