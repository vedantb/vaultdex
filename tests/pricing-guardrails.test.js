/* VaultDex unit tests — the 2026-09-25 pricing guardrails.
 *
 * Vedant: "The graph we display becomes pointless if the collection value
 * keeps changing because of bugs like these." Three nights of pricing
 * bugs (cross-set fallbacks, unverified graded comps, wipe-looping
 * repairs) each moved the collection total and the value graph on zero
 * market movement. These tests pin the structural guardrails:
 *
 *   1. Continuity: a repair never deletes a displayed price — it clears
 *      the poisoned pkmn_id and forces the row stale, keeping the old
 *      price until the refresh overwrites it in one write.
 *   2. One-shot repairs: every data repair runs exactly once per browser
 *      via a persistent flag (a bare timestamp cutoff re-wipes fresh
 *      prices until the cutoff passes).
 *   3. Plausibility: a single write may never move a $5+ row 10x on
 *      first sight — the candidate is parked for confirmation and only
 *      written when a later pass agrees.
 *   4. Snapshot sanity: the value-history point is skipped when it would
 *      carve a fake cliff/spike into the graph.
 */
import { describe, test, expect } from "vitest";
import "../js/util.js";
import "../js/pkmn.js";
import "../js/collection.js";

const C = window.App.collection;

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
  return {
    updates,
    restore() {
      window.App.auth = realAuth;
      window.App.sb = realSb;
    },
  };
}

describe("pricePlausibility", () => {
  test("no baseline: first price always writes", () => {
    expect(C.pricePlausibility({ market_price: null }, 5496.45).hold).toBe(false);
    expect(C.pricePlausibility({}, 100).hold).toBe(false);
  });

  test("sub-$5 rows are exempt (bulk-bin noise can't move the total)", () => {
    expect(C.pricePlausibility({ market_price: 0.1 }, 1.5).hold).toBe(false);
    expect(C.pricePlausibility({ market_price: 4.99 }, 60).hold).toBe(false);
  });

  test("ordinary moves pass through", () => {
    expect(C.pricePlausibility({ market_price: 100 }, 200).hold).toBe(false);
    expect(C.pricePlausibility({ market_price: 100 }, 50).hold).toBe(false);
    expect(C.pricePlausibility({ market_price: 16338.17 }, 16500).hold).toBe(false);
  });

  test("a 10x spike on first sight is held", () => {
    const r = C.pricePlausibility({ market_price: 100 }, 1000);
    expect(r.hold).toBe(true);
  });

  test("a 90% crash on first sight is held", () => {
    expect(C.pricePlausibility({ market_price: 100 }, 10).hold).toBe(true);
    expect(C.pricePlausibility({ market_price: 100 }, 9).hold).toBe(true);
  });

  test("a wipe to zero is held", () => {
    expect(C.pricePlausibility({ market_price: 100 }, 0).hold).toBe(true);
  });

  test("the Latias fantasy median would have been held", () => {
    // €5,496.45 from unverified comps vs a sane stored graded price.
    expect(C.pricePlausibility({ market_price: 400 }, 5496.45).hold).toBe(true);
  });

  test("the same extreme twice running is confirmed and writes", () => {
    const row = { market_price: 100, price_pending: 1000 };
    const r = C.pricePlausibility(row, 1000);
    expect(r.hold).toBe(false);
    expect(r.confirmed).toBe(true);
  });

  test("a drifting extreme is held again (re-parked, never written)", () => {
    const row = { market_price: 100, price_pending: 1000 };
    expect(C.pricePlausibility(row, 1200).hold).toBe(true);
  });

  test("a return to normal clears the scare", () => {
    const row = { market_price: 100, price_pending: 1000 };
    expect(C.pricePlausibility(row, 105).hold).toBe(false);
  });
});

describe("snapshotLooksSane", () => {
  test("no previous point: always record", () => {
    expect(C.snapshotLooksSane(0, 0, 12669.87, 5201)).toBe(true);
    expect(C.snapshotLooksSane(null, null, 1, 1)).toBe(true);
  });

  test("ordinary movement records", () => {
    expect(C.snapshotLooksSane(25328.73, 5194, 23681.48, 5180)).toBe(true);
    expect(C.snapshotLooksSane(25328.73, 5194, 30000, 5194)).toBe(true);
  });

  test("the 2026-09-25 halving would have been skipped", () => {
    // $25,328.73 -> $12,669.87 on the graded-repair nulling, zero market movement.
    expect(C.snapshotLooksSane(25328.73, 5194, 12669.87, 5201)).toBe(false);
  });

  test("a 65% total still records; under 60% is skipped", () => {
    expect(C.snapshotLooksSane(10000, 100, 6500, 100)).toBe(true);
    expect(C.snapshotLooksSane(10000, 100, 5900, 100)).toBe(false);
  });

  test("a 3x spike with no card growth is skipped", () => {
    expect(C.snapshotLooksSane(10000, 100, 30000, 100)).toBe(false);
  });

  test("a spike backed by real card growth records", () => {
    expect(C.snapshotLooksSane(10000, 100, 30000, 120)).toBe(true);
  });
});

describe("repair continuity + one-shot flags", () => {
  const FLAG = "vd_accent_repair_v1";

  function accentRow() {
    return {
      id: "row-go-1",
      card_id: "pgo-12",
      card_name: "Moltres",
      set_id: "pgo",
      set_name: "Pokémon GO",
      pkmn_id: 999, // poisoned: Fossil Moltres from the number-only fallback
      market_price: 0.39,
      price_source: "pkmnprices",
      price_updated_at: "2026-09-23T00:00:00Z",
      prev_price: null,
      prev_price_at: null,
    };
  }

  test("accent repair keeps the displayed price, clears the id, forces stale, runs once", async () => {
    window.localStorage.removeItem(FLAG);
    const app = stubApp();
    try {
      const row = accentRow();
      await C.repairAccentFallbackPrices([row]);
      expect(app.updates.length).toBe(1);
      const patch = app.updates[0];
      // Continuity: the displayed price is never in the patch.
      expect("market_price" in patch).toBe(false);
      expect("price_source" in patch).toBe(false);
      expect(patch.pkmn_id).toBe(null);
      expect(patch.price_updated_at).toBe("2000-01-01T00:00:00.000Z");
      // In-memory row mirrors it.
      expect(row.market_price).toBe(0.39);
      expect(row.pkmn_id).toBe(null);
      expect(window.localStorage.getItem(FLAG)).toBe("1");

      // Second run: no-op, the fresh price is never re-touched.
      app.updates.length = 0;
      row.market_price = 0.41;
      row.price_updated_at = new Date().toISOString();
      await C.repairAccentFallbackPrices([row]);
      expect(app.updates.length).toBe(0);
      expect(row.market_price).toBe(0.41);
    } finally {
      app.restore();
      window.localStorage.removeItem(FLAG);
    }
  });

  test("set-match repair flag short-circuits (no re-wipe, ever)", async () => {
    const FLAG2 = "vd_setmatch_repair_v1";
    window.localStorage.setItem(FLAG2, "1");
    const app = stubApp();
    try {
      await C.repairSetMatchPrices([
        {
          id: "r1",
          card_name: "Professor's Research",
          set_id: "sv01",
          set_name: "Scarlet & Violet",
          pkmn_id: 123,
          market_price: 0.2,
          price_updated_at: "2026-09-23T00:00:00Z",
        },
      ]);
      expect(app.updates.length).toBe(0);
    } finally {
      app.restore();
      window.localStorage.removeItem(FLAG2);
    }
  });
});

describe("gradedMissFallback", () => {
  test("never-priced graded row falls back to raw Near Mint", () => {
    expect(C.gradedMissFallback({ market_price: null })).toBe("raw");
    expect(C.gradedMissFallback({})).toBe("raw");
    // Degenerate null row: conservative keep (the refresh never passes one).
    expect(C.gradedMissFallback(null)).toBe("keep");
  });

  test("priced graded row is never downgraded on a comp miss", () => {
    expect(C.gradedMissFallback({ market_price: 16338.17 })).toBe("keep");
    expect(C.gradedMissFallback({ market_price: 0 })).toBe("keep");
  });
});
