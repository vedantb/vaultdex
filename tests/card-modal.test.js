/* VaultDex unit tests — App.cardModal.findBoundRow (js/components/card-modal.js).
 *
 * The live stepper binds to the exact collection row addItem would bump:
 * (normalized variant label, pkmn_id, grading company, grade). */
import { describe, test, expect } from "vitest";
import "../js/util.js"; // loaded first, matching the browser script order
import "../js/tcg-api.js"; // findBoundRow matches via the real App.tcg.normVLabel
import "../js/components/card-modal.js";

const { findBoundRow } = window.App.cardModal;

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
