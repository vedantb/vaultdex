/* VaultDex unit tests — js/games.js pure game helpers. */
import { describe, test, expect } from "vitest";
import "../js/games.js";

const G = window.App.games;

function row(name, price, set, img) {
  return {
    card_name: name,
    market_price: price,
    set_name: set || "Base Set",
    image_small: img === undefined ? "https://img/" + name + ".png" : img,
    rarity: "Rare",
  };
}

const ROWS = [
  row("Pikachu", 10, "Set A"),
  row("Charizard", 100, "Set A"),
  row("Bulbasaur", 11, "Set A"),
  row("Squirtle", 50, "Set B"),
  row("Mewtwo", 55, "Set B"),
  row("Gengar", 200, "Set C"),
  row("Alakazam", null, "Set C"),          // no price
  row("Machamp", 0, "Set C"),              // zero price = unusable
  row("Imageless", 75, "Set C", null),     // no image
];

describe("dailyIndex / pickForDate", () => {
  test("same date -> same index (deterministic)", () => {
    expect(G.dailyIndex(100, "2026-09-19")).toBe(G.dailyIndex(100, "2026-09-19"));
  });
  test("varies across dates", () => {
    const seen = new Set();
    for (let d = 1; d <= 30; d++) {
      seen.add(G.dailyIndex(997, "2026-09-" + String(d).padStart(2, "0")));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
  test("index is in range", () => {
    for (let d = 1; d <= 10; d++) {
      const i = G.dailyIndex(50, "2026-01-" + String(d).padStart(2, "0"));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(50);
    }
  });
  test("pickForDate is deterministic and only picks imaged rows", () => {
    const a = G.pickForDate(ROWS, "2026-09-19");
    const b = G.pickForDate(ROWS, "2026-09-19");
    expect(a).toBe(b);
    expect(a.image_small).toBeTruthy();
    expect(a.card_name).not.toBe("Imageless");
  });
  test("pickForDate returns null for empty pool", () => {
    expect(G.pickForDate([], "2026-09-19")).toBeNull();
    expect(G.pickForDate([{ card_name: "x" }], "2026-09-19")).toBeNull();
  });
});

describe("pickHigherLowerPair", () => {
  test("pair has a >=10% price gap, distinct rows, both priced", () => {
    const rand = G.mulberry32(42);
    for (let t = 0; t < 20; t++) {
      const pair = G.pickHigherLowerPair(ROWS, rand);
      expect(pair).toHaveLength(2);
      expect(pair[0]).not.toBe(pair[1]);
      const pa = G.priceOf(pair[0]);
      const pb = G.priceOf(pair[1]);
      expect(pa).not.toBeNull();
      expect(pb).not.toBeNull();
      const lo = Math.min(pa, pb), hi = Math.max(pa, pb);
      expect((hi - lo) / lo).toBeGreaterThanOrEqual(0.10);
    }
  });
  test("never picks rows without usable prices", () => {
    const rand = G.mulberry32(7);
    for (let t = 0; t < 30; t++) {
      const pair = G.pickHigherLowerPair(ROWS, rand);
      for (const r of pair) expect(["Alakazam", "Machamp", "Imageless"]).not.toContain(r.card_name);
    }
  });
  test("returns null when fewer than two priced rows", () => {
    expect(G.pickHigherLowerPair([row("A", 5)])).toBeNull();
    expect(G.pickHigherLowerPair([])).toBeNull();
  });
  test("returns null when every price sits within a 10% band", () => {
    const flat = [row("A", 100), row("B", 105), row("C", 108), row("D", 109)];
    expect(G.pickHigherLowerPair(flat, G.mulberry32(1))).toBeNull();
  });
  test("fallback finds the extreme pair when random draws miss", () => {
    // rand always returns 0 -> same index twice -> random loop never succeeds
    const pair = G.pickHigherLowerPair(ROWS, () => 0);
    expect(pair).not.toBeNull();
    const names = pair.map((r) => r.card_name).sort();
    expect(names).toEqual(["Gengar", "Pikachu"]);
  });
});

describe("buildQuizOptions", () => {
  test("returns 4 unique shuffled options containing the correct card", () => {
    const correct = ROWS[0]; // Pikachu, Set A
    const opts = G.buildQuizOptions(correct, ROWS, G.mulberry32(3));
    expect(opts).toHaveLength(4);
    const names = opts.map((o) => o.row.card_name);
    expect(new Set(names).size).toBe(4);
    expect(opts.filter((o) => o.correct)).toHaveLength(1);
    expect(opts.find((o) => o.correct).row).toBe(correct);
  });
  test("prefers distractors from the same set", () => {
    // Set A has Pikachu + Charizard + Bulbasaur (3 others besides correct)
    const correct = ROWS[1]; // Charizard, Set A
    const opts = G.buildQuizOptions(correct, ROWS, G.mulberry32(11));
    const distractSets = opts.filter((o) => !o.correct).map((o) => o.row.set_name);
    // at least the two other Set A cards should be preferred
    expect(distractSets.filter((s) => s === "Set A").length).toBeGreaterThanOrEqual(2);
  });
  test("falls back to other sets when the set is too small", () => {
    const correct = ROWS[5]; // Gengar, Set C (only itself + priceless/imageless mates)
    const opts = G.buildQuizOptions(correct, ROWS, G.mulberry32(5));
    expect(opts).toHaveLength(4);
  });
  test("returns null when the collection is too small", () => {
    expect(G.buildQuizOptions(ROWS[0], [ROWS[0], ROWS[1]], G.mulberry32(1))).toBeNull();
    expect(G.buildQuizOptions(null, ROWS)).toBeNull();
  });
  test("never duplicates the correct card's name", () => {
    const dupes = [row("Pikachu", 10, "Set A"), row("Pikachu", 99, "Set Z"), row("A", 1), row("B", 2), row("C", 3)];
    const opts = G.buildQuizOptions(dupes[0], dupes, G.mulberry32(9));
    expect(opts.filter((o) => o.row.card_name === "Pikachu")).toHaveLength(1);
  });
});

describe("valueRank", () => {
  test("ranks 1-based by price desc, ignoring unpriced rows", () => {
    expect(G.valueRank(ROWS[5], ROWS)).toBe(1); // Gengar 200
    expect(G.valueRank(ROWS[1], ROWS)).toBe(2); // Charizard 100
    expect(G.valueRank(ROWS[0], ROWS)).toBe(7); // Pikachu 10 (Imageless at 75 counts: priced)
  });
  test("returns null for unpriced rows", () => {
    expect(G.valueRank(ROWS[6], ROWS)).toBeNull();
  });
});

describe("todayStr", () => {
  test("formats YYYY-MM-DD in local time", () => {
    expect(G.todayStr(new Date(2026, 8, 19))).toBe("2026-09-19");
    expect(G.todayStr(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("localStorage bests", () => {
  test("getBest falls back quietly, setBest round-trips", () => {
    expect(G.getBest("vaultdex:test:missing", 7)).toBe(7);
    G.setBest("vaultdex:test:best", 12);
    expect(G.getBest("vaultdex:test:best", 0)).toBe(12);
    localStorage.removeItem("vaultdex:test:best");
  });
});
