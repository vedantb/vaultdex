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
