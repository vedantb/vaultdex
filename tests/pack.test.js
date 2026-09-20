/* VaultDex unit tests — App.packPick (js/views/home-view.js).
 * The pack easter egg pulls 3 unique random cards; the most valuable lands
 * in the middle of the fan (order [2nd, 1st, 3rd]) so the "hit" sits center. */
import { describe, test, expect } from "vitest";
import "../js/util.js"; // loaded first, matching the browser script order
import "../js/views/home-view.js";

const { packPick } = window.App;

function card(id, value) {
  return { card_id: id, card_name: id, market_price: value, quantity: 1, image_small: "x" };
}
const valueOf = (it) => (it.market_price || 0) * (it.quantity || 1);

describe("packPick", () => {
  test("picks n unique cards", () => {
    const pool = [card("a", 1), card("b", 2), card("c", 3), card("d", 4), card("e", 5)];
    const picks = packPick(pool, 3, valueOf);
    expect(picks.length).toBe(3);
    expect(new Set(picks.map((p) => p.card_id)).size).toBe(3);
  });

  test("returns the whole pool when smaller than n", () => {
    const pool = [card("a", 1), card("b", 2)];
    expect(packPick(pool, 3, valueOf).length).toBe(2);
  });

  test("most valuable pull lands in the middle", () => {
    const pool = [card("cheap", 1), card("hit", 99), card("mid", 50), card("junk", 2)];
    for (let k = 0; k < 20; k++) {
      const picks = packPick(pool, 3, valueOf);
      const vals = picks.map(valueOf);
      expect(Math.max(...vals)).toBe(vals[1]);
    }
  });

  test("does not mutate the pool", () => {
    const pool = [card("a", 3), card("b", 1), card("c", 2)];
    const before = pool.map((c) => c.card_id);
    packPick(pool, 3, valueOf);
    expect(pool.map((c) => c.card_id)).toEqual(before);
  });
});
