/* VaultDex unit tests — App.ownedQty.buildIndex / breakdownText (js/owned-qty.js). */
import { describe, test, expect } from "vitest";
import "../js/util.js"; // loaded first, matching the browser script order
import "../js/tcg-api.js"; // buildIndex merges via the real App.tcg.normVLabel
import "../js/owned-qty.js";

const { buildIndex, breakdownText, valueByCurrency, collectionValueText, priceSourceNote } = window.App.ownedQty;

describe("buildIndex", () => {
  test("sums quantities across rows of one card", () => {
    const map = buildIndex([
      { card_id: "sv01-001", variant: "Holo", quantity: 2 },
      { card_id: "sv01-001", variant: "Normal", quantity: 1 }
    ]);
    expect(map["sv01-001"].qty).toBe(3);
  });

  test("merges label spellings of the same variant", () => {
    const map = buildIndex([
      { card_id: "sv01-001", variant: "Holo", quantity: 1 },
      { card_id: "sv01-001", variant: "holofoil", quantity: 2 }
    ]);
    const e = map["sv01-001"];
    expect(e.qty).toBe(3);
    expect(e.variants).toHaveLength(1);
    expect(e.variants[0].qty).toBe(3);
  });

  test("keeps distinct printings separate", () => {
    const map = buildIndex([
      { card_id: "sv01-001", variant: "Holo", quantity: 1 },
      { card_id: "sv01-001", variant: "Reverse Holo", quantity: 1 }
    ]);
    expect(map["sv01-001"].variants).toHaveLength(2);
  });

  test("skips rows with no card id or zero quantity", () => {
    const map = buildIndex([
      { card_id: "", variant: "Holo", quantity: 5 },
      { card_id: "sv01-002", variant: "Holo", quantity: 0 },
      { card_id: "sv01-002", variant: "Holo", quantity: null }
    ]);
    expect(map[""]).toBeUndefined();
    expect(map["sv01-002"]).toBeUndefined();
  });

  test("pretty-prints TCGdex variant keys", () => {
    const map = buildIndex([{ card_id: "sv01-001", variant: "reverseHolofoil", quantity: 1 }]);
    expect(map["sv01-001"].variants[0].label).toBe("Reverse Holo");
  });
});

describe("breakdownText", () => {
  test("joins label × qty pairs with middots", () => {
    expect(
      breakdownText([
        { label: "Holo", qty: 2 },
        { label: "Reverse Holo", qty: 1 }
      ])
    ).toBe("Holo ×2 · Reverse Holo ×1");
  });

  test("empty variants render as an empty string", () => {
    expect(breakdownText([])).toBe("");
  });
});

describe("buildIndex collection values", () => {
  test("accumulates market_price × qty per variant with currency", () => {
    const map = buildIndex([
      { card_id: "sv01-001", variant: "Holo", quantity: 2, market_price: 12.5, price_currency: "USD" },
      { card_id: "sv01-001", variant: "Normal", quantity: 1, market_price: 3, price_currency: "EUR" }
    ]);
    const holo = map["sv01-001"].variants[0];
    expect(holo.value).toBe(25);
    expect(holo.currency).toBe("USD");
    const normal = map["sv01-001"].variants[1];
    expect(normal.value).toBe(3);
    expect(normal.currency).toBe("EUR");
  });

  test("unpriced rows carry no value; currency defaults to USD", () => {
    const map = buildIndex([
      { card_id: "sv01-001", variant: "Holo", quantity: 1 },
      { card_id: "sv01-002", variant: "Holo", quantity: 1, market_price: 5, price_currency: null }
    ]);
    expect(map["sv01-001"].variants[0].value).toBeUndefined();
    expect(map["sv01-002"].variants[0].value).toBe(5);
    expect(map["sv01-002"].variants[0].currency).toBe("USD");
  });

  test("tracks price source and latest refresh per variant", () => {
    const map = buildIndex([
      { card_id: "sv01-001", variant: "Holo", quantity: 1, market_price: 10,
        price_source: "pkmnprices", price_updated_at: "2026-09-20T00:00:00Z" },
      { card_id: "sv01-001", variant: "Holo", quantity: 1, market_price: 12,
        price_source: "pkmnprices-graded", price_updated_at: "2026-09-23T00:00:00Z" }
    ]);
    const v = map["sv01-001"].variants[0];
    expect(v.value).toBe(22);
    expect(v.priceUpdatedAt).toBe("2026-09-23T00:00:00Z");
  });
});

describe("breakdownText with values", () => {
  test("appends the per-variant value when priced", () => {
    expect(
      breakdownText([
        { label: "Holo", qty: 1, value: 25, currency: "USD" },
        { label: "Reverse Holo", qty: 2, value: 7.5, currency: "EUR" }
      ])
    ).toBe("Holo ×1 · $25.00 · Reverse Holo ×2 · €7.50");
  });

  test("keeps the old rendering for unpriced variants", () => {
    expect(breakdownText([{ label: "Holo", qty: 1 }])).toBe("Holo ×1");
  });

  test("mixes priced and unpriced variants", () => {
    expect(
      breakdownText([
        { label: "Holo", qty: 1, value: 25, currency: "USD" },
        { label: "Normal", qty: 3 }
      ])
    ).toBe("Holo ×1 · $25.00 · Normal ×3");
  });
});

describe("valueByCurrency / collectionValueText", () => {
  test("groups subtotals by currency", () => {
    expect(
      valueByCurrency([
        { label: "Holo", qty: 1, value: 25, currency: "USD" },
        { label: "Reverse Holo", qty: 1, value: 10, currency: "USD" },
        { label: "Normal", qty: 1, value: 7.5, currency: "EUR" }
      ])
    ).toEqual([
      { currency: "USD", value: 35 },
      { currency: "EUR", value: 7.5 }
    ]);
  });

  test("collectionValueText renders one or many currency subtotals", () => {
    expect(collectionValueText([{ label: "Holo", qty: 1, value: 25, currency: "USD" }])).toBe("$25.00");
    expect(
      collectionValueText([
        { label: "Holo", qty: 1, value: 25, currency: "USD" },
        { label: "Normal", qty: 1, value: 7.5, currency: "EUR" }
      ])
    ).toBe("$25.00 · €7.50");
    expect(collectionValueText([{ label: "Holo", qty: 1 }])).toBe("");
  });
});

describe("priceSourceNote", () => {
  const NOW = Date.parse("2026-09-23T12:00:00Z");

  test("names PkmnPrices Near Mint with a refresh age", () => {
    expect(
      priceSourceNote(
        [{ label: "Holo", qty: 1, value: 25, currency: "USD",
           priceSource: "pkmnprices", priceUpdatedAt: "2026-09-21T12:00:00Z" }],
        NOW
      )
    ).toBe("PkmnPrices · Near Mint · refreshed 2d ago");
  });

  test("graded rows name eBay sold listings", () => {
    expect(
      priceSourceNote(
        [{ label: "Holo", qty: 1, value: 250, currency: "USD",
           priceSource: "pkmnprices-graded", priceUpdatedAt: "2026-09-23T11:00:00Z" }],
        NOW
      )
    ).toBe("eBay sold listings · refreshed 1h ago");
  });

  test("empty when nothing is priced", () => {
    expect(priceSourceNote([{ label: "Holo", qty: 1 }], NOW)).toBe("");
    expect(priceSourceNote([], NOW)).toBe("");
  });
});
