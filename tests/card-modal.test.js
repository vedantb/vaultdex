/* VaultDex unit tests — App.cardModal.findBoundRow (js/components/card-modal.js).
 *
 * The live stepper binds to the exact collection row addItem would bump:
 * (normalized variant label, pkmn_id, grading company, grade). */
import { describe, test, expect } from "vitest";
import "../js/util.js"; // loaded first, matching the browser script order
import "../js/ui.js"; // App.esc + App.ui.money, used by priceBoxHtml
import "../js/tcg-api.js"; // findBoundRow matches via the real App.tcg.normVLabel
import "../js/components/card-modal.js";

const { findBoundRow } = window.App.cardModal;
const { priceBoxHtml } = window.App.cardModal;

function row(over) {
  return Object.assign({
    id: 1,
    card_id: "me02-001",
    variant: "Holo",
    quantity: 2,
    pkmn_id: null,
    grading_company: null,
    grade: null
  }, over);
}

describe("findBoundRow", () => {
  test("matches by normalized variant label", () => {
    const rows = [row({ variant: "Holo", quantity: 2 }), row({ id: 2, variant: "Reverse Holo", quantity: 1 })];
    expect(findBoundRow(rows, "Holo", null, null).quantity).toBe(2);
    expect(findBoundRow(rows, "Reverse Holo", null, null).id).toBe(2);
  });

  test("merges label spellings of the same variant", () => {
    const rows = [row({ variant: "holofoil", quantity: 3 })];
    expect(findBoundRow(rows, "Holo", null, null).quantity).toBe(3);
  });

  test("returns null when nothing matches", () => {
    expect(findBoundRow([row()], "Reverse Holo", null, null)).toBeNull();
    expect(findBoundRow([], "Holo", null, null)).toBeNull();
    expect(findBoundRow(null, "Holo", null, null)).toBeNull();
  });

  test("keeps graded and ungraded copies of one variant separate", () => {
    const rows = [
      row({ id: 1, variant: "Holo", quantity: 1 }),
      row({ id: 2, variant: "Holo", quantity: 1, grading_company: "PSA", grade: "10" })
    ];
    expect(findBoundRow(rows, "Holo", null, null).id).toBe(1);
    expect(findBoundRow(rows, "Holo", null, { company: "PSA", grade: "10" }).id).toBe(2);
    // A different grade is not the same slab.
    expect(findBoundRow(rows, "Holo", null, { company: "PSA", grade: "9" })).toBeNull();
  });

  test("disambiguates same-label rows by pkmn_id", () => {
    const rows = [
      row({ id: 1, variant: "Holo", pkmn_id: null, quantity: 1 }),
      row({ id: 2, variant: "Holo", pkmn_id: "p-123", quantity: 4 })
    ];
    expect(findBoundRow(rows, "Holo", "p-123", null).id).toBe(2);
    expect(findBoundRow(rows, "Holo", null, null).id).toBe(1);
  });
});

describe("flipTransform (tile-to-modal FLIP, 2026-09-20)", () => {
  const { flipTransform } = window.App.cardModal;
  test("identity when rects match", () => {
    const r = { left: 10, top: 20, width: 100, height: 140 };
    expect(flipTransform(r, { ...r })).toEqual({ dx: 0, dy: 0, sx: 1, sy: 1 });
  });
  test("computes translate + scale from destination to source", () => {
    const t = flipTransform(
      { left: 50, top: 100, width: 60, height: 84 },
      { left: 400, top: 200, width: 300, height: 420 }
    );
    expect(t.dx).toBe(-350);
    expect(t.dy).toBe(-100);
    expect(t.sx).toBeCloseTo(0.2);
    expect(t.sy).toBeCloseTo(0.2);
  });
  test("guards zero-size destination", () => {
    const t = flipTransform({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 0, height: 0 });
    expect(t.sx).toBe(1);
    expect(t.sy).toBe(1);
  });
});

describe("priceBoxHtml (price loading skeletons, 2026-09-20)", () => {
  const vars = [
    { key: "normal", label: "Normal", prices: { market: 4.5 } },
    { key: "holofoil", label: "Holofoil", prices: { market: 12.99 } }
  ];
  test("loading with snapshot variants keeps labels, shimmers numbers", () => {
    const html = priceBoxHtml({ tcgVars: vars, prints: [], isJa: false, priceLoading: true });
    expect(html).toContain("Normal");
    expect(html).toContain("Holofoil");
    expect((html.match(/price-skel/g) || []).length).toBe(8); // 2 rows x 4 price cells
    expect(html).not.toContain("—");
    expect(html).not.toContain("$4.50"); // snapshot values hidden until live lands
  });
  test("loading without any price rows reserves best-guess rows", () => {
    const html = priceBoxHtml({ tcgVars: [], prints: [], isJa: false, priceLoading: true });
    const bodyRows = (html.split("<tbody>")[1].match(/<tr>/g) || []).length;
    expect(bodyRows).toBe(3);
    expect(html).toContain("label-skel");
    expect(html).not.toContain("No TCGPlayer price data");
  });
  test("loading without price rows uses the print count when known", () => {
    const html = priceBoxHtml({ tcgVars: [], prints: [{ label: "a" }, { label: "b" }], isJa: false, priceLoading: true });
    const bodyRows = (html.split("<tbody>")[1].match(/<tr>/g) || []).length;
    expect(bodyRows).toBe(2);
  });
  test("loading JA card shows a shimmer table inside #cm-ja-price", () => {
    const html = priceBoxHtml({ tcgVars: [], prints: [], isJa: true, priceLoading: true });
    expect(html).toContain('id="cm-ja-price"');
    expect(html).toContain("price-skel");
    expect(html).not.toContain("Looking up");
  });
  test("loaded state renders real money values, no skeletons", () => {
    const html = priceBoxHtml({
      tcgVars: [{ key: "normal", label: "Normal", prices: { low: 1, mid: 2, high: 3, market: 4.5 } }],
      prints: [], isJa: false, priceLoading: false
    });
    expect(html).toContain("$4.50");
    expect(html).not.toContain("skel");
  });
  test("idle JA card keeps the looking-up note", () => {
    const html = priceBoxHtml({ tcgVars: [], prints: [], isJa: true, priceLoading: false });
    expect(html).toContain("Looking up Japanese market price");
  });
  test("idle card with no prices keeps the no-data note", () => {
    const html = priceBoxHtml({ tcgVars: [], prints: [], isJa: false, priceLoading: false });
    expect(html).toContain("No TCGPlayer price data");
  });
});
