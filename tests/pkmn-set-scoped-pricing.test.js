/* VaultDex unit tests — the 2026-09-24 set_id-scoped pricing fix.
 *
 * The number-only fallback in findCardId()/findVariantPrice() cross-priced
 * cards whenever the provider's set name didn't normalize to ours:
 * "SV01: Scarlet & Violet Base Set" never matched "Scarlet & Violet", so
 * Professor's Research #190 ($0.13) was priced as the $36.23 Professor
 * Program promo, and those fake prices topped the movers as gainers.
 *
 * The fix scopes the /v1/cards search with the mapped PkmnPrices set id
 * (data/pkmn-set-ids.json, built by scripts/build-pkmn-set-map.py), so
 * every candidate is the right set and the card number alone decides.
 * When scoped, the number-only fallback is gone: a miss is an honest
 * miss, never another set's printing.
 *
 * These tests pin:
 *   1. ppSetEntry resolves app set ids to provider entries (EN + JA).
 *   2. findCardId sends set_id when mapped and returns the in-set hit.
 *   3. A scoped search with no number hit returns null (no fallback).
 *   4. Unmapped sets keep the legacy name-matching path (unchanged).
 *   5. oldNormSetName replicates the pre-fix normalization (accents kept).
 *   6. setMatchNeedsRepair flags exactly the rows the old matcher could
 *      only have priced via the number-only fallback.
 */
import { describe, test, expect, afterEach } from "vitest";
import "../js/util.js";
import "../js/tcg-api.js"; // real normVLabel
import "../js/pkmn.js";
import "../js/collection.js";

const P = window.App.pkmn;
const C = window.App.collection;

const SET_MAP = {
  sv01: { pp: 511, ppName: "SV01: Scarlet & Violet Base Set" },
  fo: { pp: 437, ppName: "Fossil" },
  "ja-M4": { pp: 1001, ppName: "M4: Ninja Spinner" },
  sm9: { pp: 543, ppName: "SM - Team Up" },
};

/* Serves the baked set-id map for the JSON fetch and the proxy handler
 * for /v1/* calls. The handler sees the full query params, so tests can
 * assert set_id was sent and emulate the provider's set filtering. */
function stubApiWithMap(handler, map) {
  window.App.util.fetchWithTimeout = async (url) => {
    const u = new URL(url, "https://x.test");
    const path = u.searchParams.get("path");
    if (!path) return { ok: true, status: 200, json: async () => map };
    const payload = handler(path, Object.fromEntries(u.searchParams));
    return { ok: true, status: 200, json: async () => payload };
  };
}
const realFetchWithTimeout = window.App.util.fetchWithTimeout;
afterEach(() => {
  window.App.util.fetchWithTimeout = realFetchWithTimeout;
});

describe("ppSetEntry", () => {
  test("resolves an English app set id", async () => {
    stubApiWithMap(() => ({ data: [] }), SET_MAP);
    expect(await P.ppSetEntry("sv01")).toEqual({
      pp: 511,
      ppName: "SV01: Scarlet & Violet Base Set",
    });
  });
  test("resolves a Japanese app set id", async () => {
    stubApiWithMap(() => ({ data: [] }), SET_MAP);
    expect(await P.ppSetEntry("ja-M4")).toEqual({
      pp: 1001,
      ppName: "M4: Ninja Spinner",
    });
  });
  test("returns null for unmapped set ids", async () => {
    stubApiWithMap(() => ({ data: [] }), SET_MAP);
    expect(await P.ppSetEntry("sm1")).toBe(null);
    expect(await P.ppSetEntry(null)).toBe(null);
  });
});

describe("findCardId with set_id scoping (the Professor's Research reproduction)", () => {
  /* Real 2026-09-24 shape: the unscoped name+number search returns the
   * Professor Program promo FIRST (it sorts first), which is what the old
   * number-only fallback grabbed ($36.23 vs the correct $0.13). */
  const PROMO_190 = { id: "10385", set: { name: "Professor Program Promos" }, number: "190", name: "Professor's Research - 190/198" };
  const SV01_190 = { id: "18106", set: { name: "SV01: Scarlet & Violet Base Set" }, number: "190", name: "Professor's Research - 190/198" };

  function scopedHandler(path, params) {
    if (path !== "/v1/cards") return { data: [] };
    // Emulate the provider: set_id filters to that set's cards.
    if (params.set_id === "511") return { data: [SV01_190] };
    return { data: [PROMO_190, SV01_190] };
  }

  test("sends set_id and returns the in-set printing, not the promo", async () => {
    let seenParams = null;
    stubApiWithMap((path, params) => {
      seenParams = params;
      return scopedHandler(path, params);
    }, SET_MAP);
    const id = await P.findCardId({
      name: "Professor's Research",
      setName: "Scarlet & Violet",
      number: "190",
      lang: "en",
      setId: "sv01",
    });
    expect(seenParams.set_id).toBe("511");
    expect(id).toBe("18106");
  });

  test("scoped miss returns null — never another set's printing", async () => {
    stubApiWithMap((path, params) => {
      if (path === "/v1/cards" && params.set_id === "511") return { data: [] };
      return { data: [PROMO_190] };
    }, SET_MAP);
    const id = await P.findCardId({
      name: "Professor's Research",
      setName: "Scarlet & Violet",
      number: "999",
      lang: "en",
      setId: "sv01",
    });
    expect(id).toBe(null);
  });

  test("scoped search composes with Japanese language scoping", async () => {
    let seenParams = null;
    stubApiWithMap((path, params) => {
      seenParams = params;
      if (path === "/v1/cards" && params.set_id === "1001") {
        return { data: [{ id: "777001", set: { name: "M4: Ninja Spinner" }, number: "001" }] };
      }
      return { data: [] };
    }, SET_MAP);
    const id = await P.findCardId({
      name: "Weedle",
      setName: "Ninja Spinner",
      number: "001",
      lang: "ja",
      setId: "ja-M4",
    });
    expect(seenParams.set_id).toBe("1001");
    expect(seenParams.language).toBe("Japanese");
    expect(id).toBe("777001");
  });
});

describe("findCardId scoped set-id verification (the Latias & Latios GX reproduction)", () => {
  /* Live 2026-09-24: the provider returned the German "Teams Sind Trumpf"
   * printing (set 2653, id 163023) for a scoped sm9/Team Up query, and the
   * row was priced from its comps. The scoped branch now verifies the
   * hit's set id when the result carries one. */
  const GERMAN_170 = { id: "163023", set: { id: 2653, name: "Teams Sind Trumpf" }, number: "170", name: "Latias & Latios GX" };
  const EN_170 = { id: "21693", set: { id: 543, name: "SM - Team Up" }, number: "170", name: "Latias & Latios GX (Alternate Full Art)" };

  const latiasOpts = {
    name: "Latias & Latios GX",
    setName: "Team Up",
    number: "170",
    lang: "en",
    setId: "sm9",
  };

  test("skips a foreign-set number match for the in-set printing", async () => {
    stubApiWithMap((path, params) => {
      if (path === "/v1/cards" && params.set_id === "543") return { data: [GERMAN_170, EN_170] };
      return { data: [] };
    }, SET_MAP);
    expect(await P.findCardId(latiasOpts)).toBe("21693");
  });

  test("foreign-set-only results resolve to null, never the wrong printing", async () => {
    stubApiWithMap((path, params) => {
      if (path === "/v1/cards" && params.set_id === "543") return { data: [GERMAN_170] };
      return { data: [] };
    }, SET_MAP);
    expect(await P.findCardId({ ...latiasOpts, number: "171" })).toBe(null);
  });

  test("results without a set id still match by number (verification skipped)", async () => {
    stubApiWithMap((path, params) => {
      if (path === "/v1/cards" && params.set_id === "543") {
        return { data: [{ id: "21693", set: { name: "SM - Team Up" }, number: "172" }] };
      }
      return { data: [] };
    }, SET_MAP);
    expect(await P.findCardId({ ...latiasOpts, number: "172" })).toBe("21693");
  });
});

describe("findCardId without a mapping keeps the legacy path", () => {
  test("exact normalized set+number match still wins unscoped", async () => {
    stubApiWithMap((path) => {
      if (path === "/v1/cards") {
        return {
          data: [
            { id: "99999", set: { name: "Some Other Set" }, number: "12" },
            { id: "10699", set: { name: "Fossil" }, number: "12" },
          ],
        };
      }
      return { data: [] };
    }, SET_MAP);
    const id = await P.findCardId({
      name: "Moltres",
      setName: "Fossil",
      number: "12",
      lang: "en",
      // no setId: unmapped set, legacy path
    });
    expect(id).toBe("10699");
  });

  test("no set_id is sent when the set is unmapped", async () => {
    let seenParams = null;
    stubApiWithMap((path, params) => {
      seenParams = params;
      return { data: [] };
    }, SET_MAP);
    await P.findCardId({
      name: "Pikachu",
      setName: "Sun & Moon",
      number: "1",
      lang: "en",
      setId: "sm1", // unmapped: provider has no Sun & Moon base set
    });
    expect(seenParams.set_id).toBe(undefined);
  });
});

describe("oldNormSetName", () => {
  test("cuts the provider code prefix", () => {
    expect(C.oldNormSetName("SV01: Scarlet & Violet Base Set")).toBe("scarlet & violet base set");
  });
  test("keeps accents (that was the pre-fix behavior)", () => {
    expect(C.oldNormSetName("Pokémon GO")).toBe("pokémon go");
  });
  test("plain names pass through lowercased", () => {
    expect(C.oldNormSetName("Fossil")).toBe("fossil");
  });
});

describe("setMatchNeedsRepair", () => {
  const SV01 = { pp: 511, ppName: "SV01: Scarlet & Violet Base Set" };
  const FOSSIL = { pp: 437, ppName: "Fossil" };
  const POGO = { pp: 999, ppName: "Pokemon GO" };

  test("flags the SV Professor's Research cross-set price", () => {
    const row = {
      card_name: "Professor's Research",
      set_name: "Scarlet & Violet",
      number: "190",
      pkmn_id: "10385",
      market_price: 36.23,
    };
    expect(C.setMatchNeedsRepair(row, SV01)).toBe(true);
  });

  test("flags rows priced with only a market_price and no pkmn_id", () => {
    const row = {
      card_name: "Professor's Research",
      set_name: "Scarlet & Violet",
      number: "189",
      pkmn_id: null,
      market_price: 13.58,
    };
    expect(C.setMatchNeedsRepair(row, SV01)).toBe(true);
  });

  test("flags the accented Pokémon GO mismatch too", () => {
    const row = {
      card_name: "Moltres",
      set_name: "Pokémon GO",
      number: "12",
      pkmn_id: "10699",
      market_price: 196.25,
    };
    expect(C.setMatchNeedsRepair(row, POGO)).toBe(true);
  });

  test("does not flag a set the old matcher could match", () => {
    const row = {
      card_name: "Moltres",
      set_name: "Fossil",
      number: "12",
      pkmn_id: "10699",
      market_price: 1.5,
    };
    expect(C.setMatchNeedsRepair(row, FOSSIL)).toBe(false);
  });

  test("does not flag unpriced rows", () => {
    const row = {
      card_name: "Professor's Research",
      set_name: "Scarlet & Violet",
      number: "190",
      pkmn_id: null,
      market_price: null,
    };
    expect(C.setMatchNeedsRepair(row, SV01)).toBe(false);
  });

  test("does not flag unmapped sets", () => {
    const row = {
      card_name: "Pikachu",
      set_name: "Sun & Moon",
      number: "1",
      pkmn_id: "12345",
      market_price: 9.99,
    };
    expect(C.setMatchNeedsRepair(row, null)).toBe(false);
  });

  test("never re-clears a price written after the set-scoped deploy (151 wipe loop)", () => {
    const entry151 = { pp: 620, ppName: "SV: Scarlet & Violet 151" };
    const row = {
      card_name: "Pikachu",
      set_name: "151",
      number: "173",
      pkmn_id: null,
      market_price: 79.69,
      price_updated_at: "2026-09-24T03:46:08.42+00:00",
    };
    expect(C.setMatchNeedsRepair(row, entry151)).toBe(false);
  });

  test("still flags a stale pre-fix price in a mismatched set", () => {
    const entry151 = { pp: 620, ppName: "SV: Scarlet & Violet 151" };
    const row = {
      card_name: "Pikachu",
      set_name: "151",
      number: "173",
      pkmn_id: null,
      market_price: 79.69,
      price_updated_at: "2026-09-23T06:57:18.000+00:00",
    };
    expect(C.setMatchNeedsRepair(row, entry151)).toBe(true);
  });
});
