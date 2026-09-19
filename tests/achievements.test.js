/* VaultDex unit tests — js/achievements.js badge evaluators.
 *
 * The evaluators are pure functions of { rows, peakValue, completedSets,
 * speciesCount, speciesGroups }. Tests cover unlock and not-yet-unlocked
 * cases for every badge, plus closestLocked and ownedBySetFromRows. */
import { describe, test, expect } from "vitest";
import "../js/achievements.js";

const A = window.App.achievements;

function row(over) {
  return Object.assign(
    { card_name: "Pikachu", quantity: 1, variant: "Normal", rarity: "Common",
      market_price: 1, grading_company: null, set_id: "sv01", card_id: "sv01-001" },
    over || {}
  );
}
function evalAll(input) {
  return A.evaluate(Object.assign({ rows: [], peakValue: 0, completedSets: 0, speciesCount: 0, speciesGroups: {} }, input));
}
function badge(results, id) {
  return results.find(function (r) { return r.badge.id === id; });
}

describe("card-count milestones", () => {
  test("first-card unlocks at 1 copy, not at 0", () => {
    expect(badge(evalAll({ rows: [] }), "first-card").unlocked).toBe(false);
    expect(badge(evalAll({ rows: [row()] }), "first-card").unlocked).toBe(true);
  });
  test("quantity counts as copies", () => {
    const rows = [row({ quantity: 100 })];
    expect(badge(evalAll({ rows }), "century-club").unlocked).toBe(true);
    expect(badge(evalAll({ rows }), "kilocard").unlocked).toBe(false);
  });
  test("hoarder needs 4000 copies", () => {
    const almost = [row({ quantity: 3999 })];
    const enough = [row({ quantity: 4000 })];
    expect(badge(evalAll({ rows: almost }), "hoarder").unlocked).toBe(false);
    const r = badge(evalAll({ rows: almost }), "hoarder");
    expect(r.current).toBe(3999);
    expect(r.target).toBe(4000);
    expect(badge(evalAll({ rows: enough }), "hoarder").unlocked).toBe(true);
  });
});

describe("value milestones use peak value", () => {
  test("five-figures unlocks at peak 10000", () => {
    expect(badge(evalAll({ peakValue: 9999.99 }), "five-figures").unlocked).toBe(false);
    expect(badge(evalAll({ peakValue: 10000 }), "five-figures").unlocked).toBe(true);
  });
  test("grail-vault stays locked below 25000", () => {
    expect(badge(evalAll({ peakValue: 24999 }), "grail-vault").unlocked).toBe(false);
  });
});

describe("rarity badges", () => {
  test("holo-century counts holo variants only", () => {
    const rows = [row({ variant: "Holo", quantity: 99 }), row({ variant: "Reverse Holo", quantity: 1 })];
    expect(badge(evalAll({ rows }), "holo-century").unlocked).toBe(true);
    const plain = [row({ variant: "Normal", quantity: 500 })];
    const r = badge(evalAll({ rows: plain }), "holo-century");
    expect(r.unlocked).toBe(false);
    expect(r.current).toBe(0);
  });
  test("cosmos holo counts as holo", () => {
    const rows = [row({ variant: "Cosmos Holo", quantity: 100 })];
    expect(badge(evalAll({ rows }), "holo-century").unlocked).toBe(true);
  });
  test("art-connoisseur needs 10 illustration rares", () => {
    const rows = [row({ rarity: "Illustration rare", quantity: 6 }), row({ rarity: "Special illustration rare", quantity: 4 })];
    expect(badge(evalAll({ rows }), "art-connoisseur").unlocked).toBe(true);
    expect(badge(evalAll({ rows: [row({ rarity: "Rare Holo", quantity: 50 })] }), "art-connoisseur").unlocked).toBe(false);
  });
  test("chase-hunter covers secret/ultra/double/hyper", () => {
    const rows = [
      row({ rarity: "Secret Rare", quantity: 2 }),
      row({ rarity: "Ultra Rare", quantity: 1 }),
      row({ rarity: "Double rare", quantity: 1 }),
      row({ rarity: "Mega Hyper Rare", quantity: 1 }),
    ];
    expect(badge(evalAll({ rows }), "chase-hunter").unlocked).toBe(true);
  });
  test("slabbed needs a graded row", () => {
    expect(badge(evalAll({ rows: [row()] }), "slabbed").unlocked).toBe(false);
    expect(badge(evalAll({ rows: [row({ grading_company: "PSA" })] }), "slabbed").unlocked).toBe(true);
  });
  test("grail-keeper needs a $500+ row", () => {
    expect(badge(evalAll({ rows: [row({ market_price: 499 })] }), "grail-keeper").unlocked).toBe(false);
    expect(badge(evalAll({ rows: [row({ market_price: 500 })] }), "grail-keeper").unlocked).toBe(true);
  });
});

describe("species badges", () => {
  test("field-researcher at 100 species", () => {
    expect(badge(evalAll({ speciesCount: 99 }), "field-researcher").unlocked).toBe(false);
    expect(badge(evalAll({ speciesCount: 100 }), "field-researcher").unlocked).toBe(true);
  });
  test("pikachu-hoarder counts pikachu copies from species groups", () => {
    const mk = (n) => ({ speciesGroups: { pikachu: { copies: n, cards: [] } } });
    expect(badge(evalAll(mk(24)), "pikachu-hoarder").unlocked).toBe(false);
    const r = badge(evalAll(mk(24)), "pikachu-hoarder");
    expect(r.current).toBe(24);
    expect(r.target).toBe(25);
    expect(badge(evalAll(mk(25)), "pikachu-hoarder").unlocked).toBe(true);
    expect(badge(evalAll({}), "pikachu-hoarder").unlocked).toBe(false);
  });
});

describe("set-completion badges", () => {
  test("master-1/5/10 thresholds", () => {
    expect(badge(evalAll({ completedSets: 0 }), "master-1").unlocked).toBe(false);
    expect(badge(evalAll({ completedSets: 1 }), "master-1").unlocked).toBe(true);
    expect(badge(evalAll({ completedSets: 4 }), "master-5").unlocked).toBe(false);
    expect(badge(evalAll({ completedSets: 5 }), "master-5").unlocked).toBe(true);
    expect(badge(evalAll({ completedSets: 10 }), "master-10").unlocked).toBe(true);
  });
});

describe("closestLocked", () => {
  test("picks the highest completion ratio among locked badges", () => {
    // 99/100 holo (0.99) beats 6/10 art (0.6).
    const rows = [row({ variant: "Holo", quantity: 99 }), row({ rarity: "Illustration rare", quantity: 6 })];
    const next = A.closestLocked(evalAll({ rows }));
    expect(next.badge.id).toBe("holo-century");
  });
  test("returns null when everything is unlocked", () => {
    const rows = [
      row({ quantity: 5000, variant: "Holo", rarity: "Illustration rare", market_price: 600, grading_company: "PSA" }),
      row({ rarity: "Secret Rare", quantity: 5 })
    ];
    const groups = { pikachu: { copies: 30, cards: [] } };
    const results = evalAll({ rows, peakValue: 30000, completedSets: 12, speciesCount: 600, speciesGroups: groups });
    expect(results.every(function (r) { return r.unlocked; })).toBe(true);
    expect(A.closestLocked(results)).toBe(null);
  });
});

describe("ownedBySetFromRows", () => {
  test("counts distinct card_ids per set", () => {
    const rows = [
      row({ set_id: "sv01", card_id: "sv01-001" }),
      row({ set_id: "sv01", card_id: "sv01-001" }), // duplicate row, same card
      row({ set_id: "sv01", card_id: "sv01-002" }),
      row({ set_id: "sv02", card_id: "sv02-001" }),
      row({ set_id: null, card_id: "x-1" }),
    ];
    const m = A.ownedBySetFromRows(rows);
    expect(Object.keys(m.sv01)).toHaveLength(2);
    expect(Object.keys(m.sv02)).toHaveLength(1);
  });
});

describe("badge catalog sanity", () => {
  test("every badge has id, name, desc, icon, category, and a working eval", () => {
    expect(A.BADGES.length).toBeGreaterThanOrEqual(20);
    const ids = {};
    A.BADGES.forEach(function (b) {
      expect(b.id).toBeTruthy();
      expect(b.name).toBeTruthy();
      expect(b.desc).toBeTruthy();
      expect(b.icon).toBeTruthy();
      expect(b.category).toBeTruthy();
      expect(ids[b.id]).toBeUndefined();
      ids[b.id] = true;
      const r = b.eval({ rows: [], peakValue: 0, completedSets: 0, speciesCount: 0, speciesGroups: {} });
      expect(typeof r.unlocked).toBe("boolean");
      expect(r.target).toBeGreaterThan(0);
    });
  });
});
