/* VaultDex unit tests — App.ownedQty.buildIndex / breakdownText (js/owned-qty.js). */
import { describe, test, expect } from "vitest";
import "../js/util.js"; // loaded first, matching the browser script order
import "../js/tcg-api.js"; // buildIndex merges via the real App.tcg.normVLabel
import "../js/owned-qty.js";

const { buildIndex, breakdownText } = window.App.ownedQty;

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
