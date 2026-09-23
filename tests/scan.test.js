/* VaultDex unit tests — js/scan.js (OCR extraction + candidate ranking).
 *
 * Same pattern as the other view tests: jsdom loads the plain browser
 * scripts unchanged; scan.js only needs App.util (normNumber).
 */
import { describe, test, expect, beforeEach } from "vitest";
import "../js/util.js";
import "../js/scan.js";

const { extractCardInfo, scoreEntry, rankCandidates, searchIndexQuery, scanCapable } = window.App.scan;

/* Index-shaped entries the way data/tcgdex/index.json + index-ja.json look. */
const ENTRIES = [
  { id: "sv01-25", localId: "25", name: "Pikachu", nameJa: "ピカチュウ", rarity: "Common", set: "sv01" },
  { id: "sv01-60", localId: "60", name: "Charizard ex", nameJa: "リザードンex", rarity: "Double Rare", set: "sv01" },
  { id: "base1-58", localId: "58", name: "Pikachu", nameJa: "ピカチュウ", rarity: "Common", set: "base1" },
  { id: "ja-sv01-60", localId: "060", name: "Charizard ex", nameJa: "リザードンex", rarity: "Double Rare", set: "sv01" },
  { id: "sv03-200", localId: "200", name: "Bulbasaur", nameJa: "フシギダネ", rarity: "Common", set: "sv03" }
];

function ocrLine(text, yTop, yBottom) {
  return { text: text, bbox: { x0: 0, y0: yTop, x1: 100, y1: yBottom } };
}

describe("extractCardInfo", () => {
  test("reads the fraction-style card number with leading-zero normalization", () => {
    const info = extractCardInfo({
      text: "Pikachu ex\n060 / 198",
      lines: [ocrLine("Pikachu ex", 0, 20), ocrLine("060 / 198", 950, 980)]
    });
    expect(info.number).toBe("60");
    expect(info.name).toBe("Pikachu ex");
  });

  test("prefers bottom-of-card lines for the number (HP values are ignored)", () => {
    const info = extractCardInfo({
      text: "HP 120\nPikachu\n060/198",
      lines: [
        ocrLine("HP 120", 40, 60),
        ocrLine("Pikachu", 0, 30),
        ocrLine("060/198", 940, 975)
      ]
    });
    expect(info.number).toBe("60");
  });

  test("keeps multi-word names intact and strips junk tokens", () => {
    const info = extractCardInfo({
      text: "BASIC Pikachu ex HP 220",
      lines: [ocrLine("BASIC Pikachu ex HP 220", 0, 30)]
    });
    expect(info.name).toContain("Pikachu");
    expect(info.name).not.toMatch(/basic/i);
  });

  test("routes Japanese-script names to nameJa, not name", () => {
    const info = extractCardInfo({
      text: "リザードンex\n060/078",
      lines: [ocrLine("リザードンex", 0, 30), ocrLine("060/078", 940, 975)]
    });
    expect(info.nameJa).toBe("リザードンex");
    expect(info.name).toBe("");
    expect(info.number).toBe("60");
  });

  test("works without line boxes (plain-text OCR output)", () => {
    const info = extractCardInfo({ text: "Charizard ex\n025 / 197" });
    expect(info.number).toBe("25");
    expect(info.name).toContain("Charizard");
  });

  test("handles empty OCR output without throwing", () => {
    const info = extractCardInfo({ text: "", lines: [] });
    expect(info.number).toBe("");
    expect(info.name).toBe("");
    expect(info.nameJa).toBe("");
  });

  test("handles missing OCR payload entirely", () => {
    const info = extractCardInfo(null);
    expect(info).toEqual({ name: "", nameJa: "", number: "" });
  });
});

describe("scoreEntry", () => {
  test("a number-exact hit outscores a name-only hit", () => {
    const numHit = scoreEntry(ENTRIES[1], { name: "", number: "60" });
    const nameHit = scoreEntry(ENTRIES[0], { name: "Pikachu", number: "" });
    expect(numHit).toBeGreaterThan(nameHit);
  });

  test("zero means no evidence", () => {
    expect(scoreEntry(ENTRIES[0], { name: "", number: "" })).toBe(0);
  });
});

describe("rankCandidates", () => {
  test("number-exact beats name-only matches", () => {
    const ranked = rankCandidates(ENTRIES, { name: "Pikachu", number: "60" });
    expect(ranked[0].id).toMatch(/-60$/);
  });

  test("normalizes leading zeros so OCR '060' matches catalog '60'", () => {
    const ranked = rankCandidates(ENTRIES, { name: "", number: "060" });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].id).toMatch(/-60$/);
  });

  test("nameJa finds Japanese printings by their Japanese name", () => {
    const ranked = rankCandidates(ENTRIES, { nameJa: "リザードンex", number: "" });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].nameJa).toBe("リザードンex");
  });

  test("exact English name match ranks above partial token overlap", () => {
    const ranked = rankCandidates(ENTRIES, { name: "Pikachu", number: "" });
    expect(ranked[0].name).toBe("Pikachu");
  });

  test("returns nothing when there is no evidence at all", () => {
    expect(rankCandidates(ENTRIES, { name: "", number: "" })).toEqual([]);
    expect(rankCandidates(ENTRIES, { name: "xyzzy not a card", number: "" })).toEqual([]);
  });

  test("respects the limit", () => {
    const many = ENTRIES.concat(ENTRIES.map(function (e, i) {
      return { id: e.id + "-" + i, localId: e.localId, name: "Pikachu", nameJa: "", rarity: "", set: "" };
    }));
    expect(rankCandidates(many, { name: "Pikachu", number: "" }, 3).length).toBeLessThanOrEqual(3);
  });
});

describe("searchIndexQuery (manual fallback)", () => {
  test("typed English name finds candidates", () => {
    const ranked = searchIndexQuery(ENTRIES, "charizard ex");
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].name).toBe("Charizard ex");
  });

  test("typed Japanese name finds Japanese printings", () => {
    const ranked = searchIndexQuery(ENTRIES, "リザードンex");
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].nameJa).toBe("リザードンex");
  });

  test("a bare number is treated as a card-number guess", () => {
    const ranked = searchIndexQuery(ENTRIES, "60");
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].id).toMatch(/-60$/);
  });

  test("name plus number narrows to the exact printing", () => {
    const ranked = searchIndexQuery(ENTRIES, "Pikachu 58");
    expect(ranked[0].id).toBe("base1-58");
  });
});

describe("scanCapable", () => {
  beforeEach(() => {
    delete window.matchMedia;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "ontouchstart", { value: true, configurable: true });
  });

  test("phone-class device (coarse pointer, small viewport) is capable", () => {
    window.matchMedia = function () { return { matches: true }; };
    expect(scanCapable()).toBe(true);
  });

  test("desktop viewport is not capable even with touch", () => {
    window.matchMedia = function () { return { matches: true }; };
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    expect(scanCapable()).toBe(false);
  });

  test("fine-pointer device is not capable", () => {
    window.matchMedia = function () { return { matches: false }; };
    delete window.ontouchstart;
    expect(scanCapable()).toBe(false);
  });
});
