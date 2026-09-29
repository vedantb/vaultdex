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
import "../js/views/binders-view.js";

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

describe("pickMoveSource (card-modal.js) — picker switch means move", () => {
  const { pickMoveSource } = window.App.cardModal;
  const A = "binder-a", B = "binder-b";

  test("returns the source row when copies sit under the old binder", () => {
    const rows = [brow({ id: 1, binder_id: null, quantity: 2 })];
    expect(pickMoveSource(rows, "Holo", null, null, A).id).toBe(1);
  });

  test("returns null when switching to the same binder", () => {
    const rows = [brow({ id: 1, binder_id: A, quantity: 2 })];
    expect(pickMoveSource(rows, "Holo", null, A, A)).toBeNull();
  });

  test("returns null when nothing is shelved under the old binder", () => {
    const rows = [brow({ id: 1, binder_id: B, quantity: 2 })];
    expect(pickMoveSource(rows, "Holo", null, null, A)).toBeNull();
  });

  test("treats empty-string and null binders as the same unshelved slot", () => {
    const rows = [brow({ id: 1, binder_id: null, quantity: 2 })];
    expect(pickMoveSource(rows, "Holo", null, "", "")).toBeNull();
    expect(pickMoveSource(rows, "Holo", null, null, A).id).toBe(1);
  });

  test("respects variant and grading isolation", () => {
    const rows = [brow({ id: 1, binder_id: null, quantity: 2, variant: "Reverse Holo" })];
    expect(pickMoveSource(rows, "Holo", null, null, A)).toBeNull();
    const graded = [brow({ id: 2, binder_id: null, quantity: 1, grading_company: "PSA", grade: "10" })];
    expect(pickMoveSource(graded, "Holo", null, null, A)).toBeNull();
    expect(pickMoveSource(graded, "Holo", { company: "PSA", grade: "10" }, null, A).id).toBe(2);
  });
});

describe("splitRow (collection.js) — transactional RPC", () => {
  const { splitRow } = window.App.collection;

  function stubApp(rpcImpl) {
    window.App.auth = { user: { id: "user-1" } };
    window.App.emit = function () {};
    const calls = [];
    window.App.sb = {
      rpc: async function (fn, args) {
        calls.push({ fn: fn, args: args });
        return rpcImpl(args);
      },
    };
    return calls;
  }

  test("calls move_binder_copies with row id, qty and target", async () => {
    const calls = stubApp(async () => ({ data: { ok: true }, error: null }));
    const ok = await splitRow("row-1", 2, "binder-a");
    expect(ok).toBe(true);
    expect(calls).toEqual([
      { fn: "move_binder_copies", args: { p_row_id: "row-1", p_move_qty: 2, p_target_binder_id: "binder-a" } },
    ]);
  });

  test("null target means unshelve", async () => {
    const calls = stubApp(async () => ({ data: { ok: true }, error: null }));
    await splitRow("row-1", 1, null);
    expect(calls[0].args.p_target_binder_id).toBeNull();
  });

  test("rejects zero/negative quantities client-side", async () => {
    stubApp(async () => ({ data: { ok: true }, error: null }));
    await expect(splitRow("row-1", 0, "binder-a")).rejects.toThrow("Move at least 1 copy");
    await expect(splitRow("row-1", -3, "binder-a")).rejects.toThrow("Move at least 1 copy");
  });

  test("falls back to the legacy two-write move when the RPC is missing", async () => {
    window.App.auth = { user: { id: "user-1" } };
    window.App.emit = function () {};
    const writes = [];
    const srcRow = brow({ id: "row-1", quantity: 2, binder_id: null });
    window.App.sb = {
      rpc: async () => ({
        data: null,
        error: { code: "PGRST202", status: 404, message: "Could not find the function public.move_binder_copies" },
      }),
      from: function () {
        const b = {
          _op: null,
          select: function () { if (!this._op) this._op = "select"; return this; },
          insert: function (row) { writes.push(["insert", row]); this._op = "insert"; return this; },
          update: function (patch) { writes.push(["update", patch]); this._op = "update"; return this; },
          eq: function () { return this; },
          single: async function () {
            if (this._op === "insert") {
              return { data: Object.assign({}, srcRow, { id: "row-2", quantity: 1, binder_id: "binder-a" }), error: null };
            }
            return { data: srcRow, error: null };
          },
        };
        /* supabase-js builders are thenable: plain await works on update() */
        b.then = function (resolve) { resolve({ data: null, error: null }); };
        return b;
      },
    };
    const res = await splitRow("row-1", 1, "binder-a");
    expect(res.id).toBe("row-2");
    expect(writes[0][0]).toBe("insert");
    expect(writes[0][1].quantity).toBe(1);
    expect(writes[0][1].binder_id).toBe("binder-a");
    expect(writes[1][0]).toBe("update");
    expect(writes[1][1]).toEqual({ quantity: 1 });
  });

  test("real RPC errors are not swallowed by the fallback", async () => {
    stubApp(async () => ({ data: null, error: { code: "42501", message: "Not your collection." } }));
    await expect(splitRow("row-1", 1, "binder-a")).rejects.toThrow("Not your collection.");
  });
});

describe("groupUnshelvedBySet (binders-view.js) — Add-cards modal", () => {
  const { groupUnshelvedBySet } = window.App.views.binderDetail;

  test("groups unshelved rows by set and sums copies", () => {
    const rows = [
      brow({ id: 1, set_id: "ja-M6a", set_name: "30th Celebration", quantity: 2 }),
      brow({ id: 2, set_id: "ja-M6a", set_name: "30th Celebration", quantity: 1 }),
      brow({ id: 3, set_id: "30th", set_name: "30th Celebration", quantity: 4 }),
    ];
    const groups = groupUnshelvedBySet(rows);
    expect(groups).toHaveLength(2);
    const m6a = groups.filter((g) => g.set_id === "ja-M6a")[0];
    expect(m6a.rows).toHaveLength(2);
    expect(m6a.copies).toBe(3);
  });

  test("excludes rows already shelved in any binder", () => {
    const rows = [
      brow({ id: 1, set_id: "ja-M6a", binder_id: null }),
      brow({ id: 2, set_id: "ja-M6a", binder_id: "binder-a" }),
    ];
    const groups = groupUnshelvedBySet(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((r) => r.id)).toEqual([1]);
  });

  test("sorts groups by set name, case-insensitive", () => {
    const rows = [
      brow({ id: 1, set_id: "sv01", set_name: "Scarlet & Violet" }),
      brow({ id: 2, set_id: "ja-M6a", set_name: "30th Celebration" }),
    ];
    expect(groupUnshelvedBySet(rows).map((g) => g.set_id)).toEqual(["ja-M6a", "sv01"]);
  });

  test("falls back to set_id when the set name is missing", () => {
    const rows = [brow({ id: 1, set_id: "ja-M6a", set_name: null })];
    const groups = groupUnshelvedBySet(rows);
    expect(groups[0].set_name).toBe("ja-M6a");
  });

  test("empty collection yields no groups", () => {
    expect(groupUnshelvedBySet([])).toEqual([]);
    expect(groupUnshelvedBySet(null)).toEqual([]);
  });
});

describe("binderTier + sortBinderDefault (binders.js) — binder ordering", () => {
  test("tiers follow the owner's order", () => {
    expect(B.binderTier("Common")).toBe(0);
    expect(B.binderTier("uncommon")).toBe(0);
    expect(B.binderTier("Rare")).toBe(1);
    expect(B.binderTier("Rare Holo")).toBe(1);
    expect(B.binderTier("Double Rare")).toBe(2);
    expect(B.binderTier("Ultra Rare")).toBe(3);
    expect(B.binderTier("Special Illustration Rare")).toBe(4);
    expect(B.binderTier("Illustration Rare")).toBe(5);
    expect(B.binderTier("Hyper Rare")).toBe(5);
    expect(B.binderTier(null)).toBe(5);
  });

  test("single-set binder sorts by set number", () => {
    const rows = [
      brow({ id: 1, set_id: "ja-M6a", number: "103" }),
      brow({ id: 2, set_id: "ja-M6a", number: "9" }),
      brow({ id: 3, set_id: "ja-M6a", number: "25" }),
    ];
    expect(B.sortBinderDefault(rows).map((r) => r.id)).toEqual([2, 3, 1]);
  });

  test("single-set binder falls back to card_id when number is missing", () => {
    const rows = [
      brow({ id: 1, set_id: "ja-M6a", number: null, card_id: "M6a-104" }),
      brow({ id: 2, set_id: "ja-M6a", number: null, card_id: "M6a-099" }),
    ];
    expect(B.sortBinderDefault(rows).map((r) => r.id)).toEqual([2, 1]);
  });

  test("mixed-set binder sorts by tier, then set, then number", () => {
    const rows = [
      brow({ id: 1, set_id: "sv01", set_name: "Scarlet & Violet", rarity: "Ultra Rare", number: "1" }),
      brow({ id: 2, set_id: "ja-M6a", set_name: "30th Celebration", rarity: "Common", number: "50" }),
      brow({ id: 3, set_id: "sv01", set_name: "Scarlet & Violet", rarity: "Common", number: "10" }),
      brow({ id: 4, set_id: "sv01", set_name: "Scarlet & Violet", rarity: "Common", number: "2" }),
      brow({ id: 5, set_id: "ja-M6a", set_name: "30th Celebration", rarity: "Special Illustration Rare", number: "150" }),
      brow({ id: 6, set_id: "sv01", set_name: "Scarlet & Violet", rarity: "Double Rare", number: "3" }),
    ];
    expect(B.sortBinderDefault(rows).map((r) => r.id)).toEqual([2, 4, 3, 6, 1, 5]);
  });

  test("sortByBinderRarity always uses tiers, even for a single set", () => {
    const rows = [
      brow({ id: 1, set_id: "ja-M6a", rarity: "Ultra Rare", number: "1" }),
      brow({ id: 2, set_id: "ja-M6a", rarity: "Common", number: "99" }),
    ];
    expect(B.sortByBinderRarity(rows).map((r) => r.id)).toEqual([2, 1]);
  });
});

describe("expandSlots (binders-view.js) — one sleeve per copy", () => {
  const { expandSlots } = window.App.views.binderDetail;

  test("a x3 row becomes three adjacent slots", () => {
    const row = brow({ id: 7, quantity: 3 });
    const slots = expandSlots([row]);
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.copy)).toEqual([1, 2, 3]);
    expect(slots.every((s) => s.of === 3)).toBe(true);
    expect(slots.every((s) => s.row === row)).toBe(true);
  });

  test("a x1 row becomes a single slot", () => {
    const slots = expandSlots([brow({ id: 1, quantity: 1 })]);
    expect(slots).toHaveLength(1);
    expect(slots[0].copy).toBe(1);
    expect(slots[0].of).toBe(1);
  });

  test("missing or zero quantity is treated as one copy", () => {
    expect(expandSlots([brow({ id: 1, quantity: 0 })])).toHaveLength(1);
    expect(expandSlots([brow({ id: 2, quantity: null })])).toHaveLength(1);
  });

  test("rows keep their order with copies adjacent", () => {
    const slots = expandSlots([
      brow({ id: 1, quantity: 2 }),
      brow({ id: 2, quantity: 1 }),
    ]);
    expect(slots.map((s) => s.row.id)).toEqual([1, 1, 2]);
  });

  test("empty input yields no slots", () => {
    expect(expandSlots([])).toEqual([]);
    expect(expandSlots(null)).toEqual([]);
  });
});

describe("chunkPages / spreadCount / spreadSides (binders-view.js)", () => {
  const v = window.App.views.binderDetail;

  test("chunkPages splits slots into 9s", () => {
    const slots = Array.from({ length: 20 }, (_, i) => ({ copy: i + 1 }));
    expect(v.chunkPages(slots).map((p) => p.length)).toEqual([9, 9, 2]);
  });

  test("chunkPages keeps order and handles empty", () => {
    const slots = Array.from({ length: 9 }, (_, i) => ({ copy: i + 1 }));
    const pages = v.chunkPages(slots);
    expect(pages).toHaveLength(1);
    expect(pages[0][0].copy).toBe(1);
    expect(v.chunkPages([])).toEqual([]);
  });

  test("spreadCount includes the cover spread", () => {
    expect(v.spreadCount(0)).toBe(1); // cover + blank
    expect(v.spreadCount(1)).toBe(1); // cover | p0
    expect(v.spreadCount(2)).toBe(2); // cover|p0, p1|blank
    expect(v.spreadCount(3)).toBe(2);
    expect(v.spreadCount(4)).toBe(3);
  });

  test("spreadSides maps spreads to cover/pages", () => {
    expect(v.spreadSides(0, 0)).toEqual({ left: "cover", right: null });
    expect(v.spreadSides(0, 2)).toEqual({ left: "cover", right: 0 });
    expect(v.spreadSides(1, 2)).toEqual({ left: 1, right: null });
    expect(v.spreadSides(1, 3)).toEqual({ left: 1, right: 2 });
    expect(v.spreadSides(2, 5)).toEqual({ left: 3, right: 4 });
  });
});

describe("neighborPages (binders-view.js) — adjacent-page preload targets", () => {
  const { neighborPages } = window.App.views.binderDetail;

  test("wide: middle spread warms both neighbors, cover excluded", () => {
    // 5 pages -> spreads: [cover|0] [1|2] [3|4]
    expect(neighborPages(true, 1, 5)).toEqual([0, 3, 4]);
  });

  test("wide: first spread warms only the next spread", () => {
    expect(neighborPages(true, 0, 5)).toEqual([1, 2]);
  });

  test("wide: last spread warms only the previous spread", () => {
    expect(neighborPages(true, 2, 5)).toEqual([1, 2]);
  });

  test("wide: empty binder has no neighbors", () => {
    expect(neighborPages(true, 0, 0)).toEqual([]);
  });

  test("mobile: middle page warms both neighbors", () => {
    expect(neighborPages(false, 2, 5)).toEqual([0, 2]);
  });

  test("mobile: cover has only the next page", () => {
    expect(neighborPages(false, 0, 5)).toEqual([0]);
  });

  test("mobile: last page has only the previous page", () => {
    expect(neighborPages(false, 5, 5)).toEqual([3]);
  });
});

describe("seedSlotOrder (binders-view.js) — default pocket order", () => {
  const { seedSlotOrder } = window.App.views.binderDetail;

  test("single-set binder seeds in card-number order", () => {
    const rows = [
      brow({ id: "a", set_id: "s1", number: "010", quantity: 1 }),
      brow({ id: "b", set_id: "s1", number: "002", quantity: 1 }),
      brow({ id: "c", set_id: "s1", number: "001", quantity: 1 }),
    ];
    expect(seedSlotOrder(rows)).toEqual(["c", "b", "a"]);
  });

  test("one entry per copy, copies adjacent", () => {
    const rows = [brow({ id: "a", set_id: "s1", number: "001", quantity: 2 })];
    expect(seedSlotOrder(rows)).toEqual(["a", "a"]);
  });

  test("mixed-set binder seeds in rarity-tier order", () => {
    const rows = [
      brow({ id: "rare", set_id: "s1", number: "001", rarity: "Rare Holo", card_name: "Zed", quantity: 1 }),
      brow({ id: "common", set_id: "s2", number: "001", rarity: "Common", card_name: "Alf", quantity: 1 }),
    ];
    expect(seedSlotOrder(rows)).toEqual(["common", "rare"]);
  });

  test("empty input seeds empty", () => {
    expect(seedSlotOrder([])).toEqual([]);
  });
});

describe("reconcileSlotOrder (binders-view.js) — stored order vs shelved rows", () => {
  const { reconcileSlotOrder } = window.App.views.binderDetail;
  const rows123 = () => [
    brow({ id: "r1", set_id: "s1", number: "001", quantity: 1 }),
    brow({ id: "r2", set_id: "s1", number: "002", quantity: 1 }),
    brow({ id: "r3", set_id: "s1", number: "003", quantity: 1 }),
  ];

  test("null stored order seeds the default order", () => {
    expect(reconcileSlotOrder(null, rows123())).toEqual(["r1", "r2", "r3"]);
  });

  test("keeps the owner's custom arrangement untouched", () => {
    expect(reconcileSlotOrder(["r3", "r1", "r2"], rows123())).toEqual(["r3", "r1", "r2"]);
  });

  test("unknown ids become empty sleeves, not crashes", () => {
    expect(reconcileSlotOrder(["gone", "r1"], rows123())).toEqual([null, "r1", "r2", "r3"]);
  });

  test("copies past a row's current quantity become empty sleeves", () => {
    // r1 shelved x1 but the stored order still holds two copies of it
    expect(reconcileSlotOrder(["r1", "r1", "r2"], rows123())).toEqual(["r1", null, "r2", "r3"]);
  });

  test("newly shelved rows append at the end in default order", () => {
    const rows = rows123();
    expect(reconcileSlotOrder(["r3"], rows)).toEqual(["r3", "r1", "r2"]);
  });

  test("new copies of an existing row append after the kept ones", () => {
    const rows = [brow({ id: "r1", set_id: "s1", number: "001", quantity: 3 })];
    expect(reconcileSlotOrder(["r1"], rows)).toEqual(["r1", "r1", "r1"]);
  });

  test("interior holes are preserved, trailing empties trimmed", () => {
    expect(reconcileSlotOrder(["r1", null, "r2", null, null], rows123()))
      .toEqual(["r1", null, "r2", null, null, "r3"]);
    expect(reconcileSlotOrder(["r1", "r2", "r3", null, null], rows123()))
      .toEqual(["r1", "r2", "r3"]);
  });

  test("a fully emptied binder reconciles to no slots", () => {
    expect(reconcileSlotOrder(["r9", null], [])).toEqual([]);
  });
});

describe("applyDrop (binders-view.js) — swap vs move", () => {
  const { applyDrop } = window.App.views.binderDetail;

  test("dropping on an occupied pocket swaps the two cards", () => {
    expect(applyDrop(["a", "b", "c"], 0, 2)).toEqual(["c", "b", "a"]);
  });

  test("dropping on an empty pocket moves, leaving the old sleeve empty", () => {
    expect(applyDrop(["a", "b"], 0, 4)).toEqual([null, "b", null, null, "a"]);
  });

  test("dropping on its own pocket is a no-op", () => {
    expect(applyDrop(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  test("dragging from an empty sleeve is a no-op", () => {
    expect(applyDrop(["a"], 3, 0)).toEqual(["a"]);
    expect(applyDrop([null, "a"], 0, 1)).toEqual([null, "a"]);
  });

  test("moving the last card off the end trims trailing empties", () => {
    expect(applyDrop(["a", "b", "c"], 2, 0)).toEqual(["c", "b", "a"]);
    expect(applyDrop(["a", "b"], 1, 5)).toEqual(["a", null, null, null, null, "b"]);
  });

  test("does not mutate the input order", () => {
    const order = ["a", "b", "c"];
    applyDrop(order, 0, 2);
    expect(order).toEqual(["a", "b", "c"]);
  });
});
