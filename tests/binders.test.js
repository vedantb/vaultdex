/* VaultDex unit tests — physical binder tracking (js/binders.js) + the
 * split-copies row identity (collection.js findMatchingRow, card-modal
 * findBoundRow).
 *
 * Split copies: the same card+variant shelved in two binders is two rows
 * that never merge. binder_id is part of the identity, null-safe.
 */
import { describe, test, expect } from "vitest";
import "../js/util.js"; // loaded first, matching the browser script order
import "../js/tcg-api.js"; // real normVLabel for the row-identity tests
import "../js/binders.js";
import "../js/ui.js"; // App.esc, used by card-modal.js at load
import "../js/components/card-modal.js";
import "../js/collection.js";

const B = window.App.binders;
const { findMatchingRow } = window.App.collection;
const { findBoundRow } = window.App.cardModal;

function brow(over) {
  return Object.assign({
    id: 1,
    card_id: "sv01-001",
    card_name: "Pikachu",
    set_name: "Scarlet & Violet",
    variant: "Holo",
    quantity: 2,
    pkmn_id: null,
    grading_company: null,
    grade: null,
    binder_id: null,
    rarity: "Rare Holo",
    market_price: 5,
  }, over);
}

describe("rarityRank", () => {
  test("ranks common lowest, chase rarities highest", () => {
    expect(B.rarityRank("Common")).toBe(0);
    expect(B.rarityRank("Hyper Rare")).toBeGreaterThan(B.rarityRank("Rare Holo"));
    expect(B.rarityRank("Special Illustration Rare")).toBeGreaterThan(B.rarityRank("Illustration Rare"));
  });

  test("is case-insensitive and trims", () => {
    expect(B.rarityRank("  HYPER RARE ")).toBe(B.rarityRank("hyper rare"));
  });

  test("unknown / missing rarity sorts after every known rarity", () => {
    const last = B.RARITY_ORDER.length;
    expect(B.rarityRank("Something New")).toBe(last);
    expect(B.rarityRank(null)).toBe(last);
    expect(B.rarityRank("")).toBe(last);
  });
});

describe("sortByRarity", () => {
  test("sorts rarest first", () => {
    const rows = [
      brow({ id: 1, rarity: "Common" }),
      brow({ id: 2, rarity: "Hyper Rare" }),
      brow({ id: 3, rarity: "Rare Holo" }),
    ];
    expect(B.sortByRarity(rows).map((r) => r.id)).toEqual([2, 3, 1]);
  });

  test("ties break by set, then name — stable and browsable", () => {
    const rows = [
      brow({ id: 1, card_name: "Zebra", set_name: "B", rarity: "Rare" }),
      brow({ id: 2, card_name: "Apple", set_name: "B", rarity: "Rare" }),
      brow({ id: 3, card_name: "Mango", set_name: "A", rarity: "Rare" }),
    ];
    expect(B.sortByRarity(rows).map((r) => r.id)).toEqual([3, 2, 1]);
  });

  test("does not mutate the input array", () => {
    const rows = [brow({ id: 1, rarity: "Common" }), brow({ id: 2, rarity: "Hyper Rare" })];
    B.sortByRarity(rows);
    expect(rows[0].id).toBe(1);
  });
});

describe("findMatchingRow (collection.js) — binder-aware identity", () => {
  const A = "binder-a", C = "binder-c";

  test("same card+variant in two binders are distinct rows", () => {
    const rows = [brow({ id: 1, binder_id: A }), brow({ id: 2, binder_id: C })];
    expect(findMatchingRow(rows, "Holo", null, A).id).toBe(1);
    expect(findMatchingRow(rows, "Holo", null, C).id).toBe(2);
  });

  test("null binder matches only the unshelved row (null-safe)", () => {
    const rows = [brow({ id: 1, binder_id: A }), brow({ id: 2, binder_id: null })];
    expect(findMatchingRow(rows, "Holo", null, null).id).toBe(2);
    expect(findMatchingRow(rows, "Holo", null, undefined).id).toBe(2);
  });

  test("a binder id never matches the unshelved row", () => {
    const rows = [brow({ id: 1, binder_id: null })];
    expect(findMatchingRow(rows, "Holo", null, A)).toBeNull();
  });

  test("variant and pkmn_id still participate in the identity", () => {
    const rows = [brow({ id: 1, binder_id: A, variant: "Reverse Holo" })];
    expect(findMatchingRow(rows, "Holo", null, A)).toBeNull();
    expect(findMatchingRow(rows, "Reverse Holo", null, A).id).toBe(1);
  });
});

describe("findBoundRow (card-modal.js) — binder-aware binding", () => {
  const A = "binder-a", C = "binder-c";

  test("binds the selected binder's row", () => {
    const rows = [
      brow({ id: 1, binder_id: A, quantity: 3 }),
      brow({ id: 2, binder_id: C, quantity: 1 }),
    ];
    expect(findBoundRow(rows, "Holo", null, null, A).quantity).toBe(3);
    expect(findBoundRow(rows, "Holo", null, null, C).quantity).toBe(1);
  });

  test("null binder binds the unshelved row, not a shelved one", () => {
    const rows = [brow({ id: 1, binder_id: A }), brow({ id: 2, binder_id: null })];
    expect(findBoundRow(rows, "Holo", null, null, null).id).toBe(2);
  });

  test("returns null when the binder holds no row for this variant", () => {
    const rows = [brow({ id: 1, binder_id: A })];
    expect(findBoundRow(rows, "Holo", null, null, C)).toBeNull();
  });
});
