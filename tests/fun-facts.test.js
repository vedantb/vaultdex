/* VaultDex unit tests — js/fun-facts.js "Did you know?" helpers.
 *
 * Lore facts come from PokéAPI flavor text; artist facts from the computed
 * data/artist-stats.json (legends are hand-verified, never generated).
 * fetch is stubbed per test; the species mapping is injected via
 * setMapping so no network is needed. */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import "../js/games.js";
import "../js/species.js";
import "../js/fun-facts.js";

const F = window.App.funFacts;
const S = window.App.species;

S.setMapping({
  order: ["pikachu", "charizard", "mr-mime", "nidoran-f"],
  dex: { pikachu: 25, charizard: 6, "mr-mime": 122, "nidoran-f": 29 },
});

const realFetch = globalThis.fetch;
beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(payload, ok = true) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok, json: async () => payload };
  };
  return () => calls;
}

const FLAVOR_PAYLOAD = {
  flavor_text_entries: [
    { flavor_text: "When several of\nthese Pokémon\f gather,\ntheir electricity can build.", language: { name: "en" } },
    { flavor_text: "Quand plusieurs de ces Pokémon se rassemblent.", language: { name: "fr" } },
    { flavor_text: "It keeps its tail raised to monitor its surroundings.", language: { name: "en" } },
    { flavor_text: "When several of these Pokémon gather, their electricity can build.", language: { name: "en" } }, // dup
  ],
};

const STATS = {
  _legends: { "Mitsuhiro Arita": "Arita illustrated the original Base Set Charizard." },
  "Mitsuhiro Arita": { firstSet: "Expansion Pack", firstYear: 1996, lastYear: 2026, species: 296, cards: 861 },
  "Some Artist": { firstSet: "Base Set", firstYear: 1999, lastYear: 2005, species: 12, cards: 40 },
};

describe("cleanFlavor", () => {
  test("collapses newlines, form feeds and extra spaces", () => {
    expect(F.cleanFlavor("When several of\nthese Pokémon\f gather,\ntheir electricity can build."))
      .toBe("When several of these Pokémon gather, their electricity can build.");
  });
  test("trims and handles empty input", () => {
    expect(F.cleanFlavor("  hello  ")).toBe("hello");
    expect(F.cleanFlavor(null)).toBe("");
  });
});

describe("pickDailyText", () => {
  const texts = ["alpha", "beta", "gamma", "delta"];
  test("same date -> same text (deterministic)", () => {
    expect(F.pickDailyText(texts, "2026-09-19")).toBe(F.pickDailyText(texts, "2026-09-19"));
  });
  test("varies across dates", () => {
    const seen = new Set();
    for (let d = 1; d <= 30; d++) seen.add(F.pickDailyText(texts, "2026-09-" + String(d).padStart(2, "0")));
    expect(seen.size).toBeGreaterThan(1);
  });
  test("null on empty input", () => {
    expect(F.pickDailyText([], "2026-09-19")).toBeNull();
    expect(F.pickDailyText(null, "2026-09-19")).toBeNull();
  });
});

describe("loreFact", () => {
  test("returns a cleaned English entry, deterministic per date", async () => {
    const calls = stubFetch(FLAVOR_PAYLOAD);
    const a = await F.loreFact("Pikachu", "2026-09-19");
    const b = await F.loreFact("Pikachu", "2026-09-19");
    expect(a).toBe(b);
    expect(a).not.toContain("\n");
    expect(a).not.toContain("\f");
    expect(a.length).toBeGreaterThan(0);
    // cached: one network fetch for both calls
    expect(calls()).toBe(1);
  });
  test("skips non-English entries and dedupes", async () => {
    stubFetch(FLAVOR_PAYLOAD);
    const texts = await F.englishFlavorTexts("pikachu-x");
    expect(texts).toHaveLength(2);
    expect(texts.every((t) => !t.includes("rassemblent"))).toBe(true);
  });
  test("unknown card name -> null without fetching", async () => {
    const calls = stubFetch(FLAVOR_PAYLOAD);
    expect(await F.loreFact("Not A Real Pokemon", "2026-09-19")).toBeNull();
    expect(calls()).toBe(0);
  });
  test("fetch failure -> null, never throws", async () => {
    globalThis.fetch = async () => { throw new Error("offline"); };
    expect(await F.loreFact("Charizard", "2026-09-19")).toBeNull();
  });
  test("HTTP error -> null", async () => {
    stubFetch({}, false);
    expect(await F.loreFact("Charizard", "2026-09-19")).toBeNull();
  });
});

describe("artistFact", () => {
  test("curated legend takes precedence (case-insensitive)", () => {
    expect(F.artistFact("mitsuhiro arita", STATS, "2026-09-19"))
      .toBe("Arita illustrated the original Base Set Charizard.");
    expect(F.artistFact("Mitsuhiro Arita", STATS, "2026-09-20"))
      .toBe("Arita illustrated the original Base Set Charizard.");
  });
  test("computed templates are deterministic per date", () => {
    const a = F.artistFact("Some Artist", STATS, "2026-09-19");
    expect(F.artistFact("Some Artist", STATS, "2026-09-19")).toBe(a);
    expect(typeof a).toBe("string");
    expect(a).toContain("Some Artist");
  });
  test("computed templates only use real stats fields", () => {
    const seen = new Set();
    for (let d = 1; d <= 30; d++) seen.add(F.artistFact("Some Artist", STATS, "2026-09-" + String(d).padStart(2, "0")));
    for (const t of seen) {
      const ok = t.includes("1999") || t.includes("12 different Pokémon") || t.includes("7 years");
      expect(ok).toBe(true);
    }
  });
  test("unknown artist -> null, empty name -> null", () => {
    expect(F.artistFact("Nobody Ever", STATS, "2026-09-19")).toBeNull();
    expect(F.artistFact("", STATS, "2026-09-19")).toBeNull();
    expect(F.artistFact(null, STATS, "2026-09-19")).toBeNull();
  });
});

describe("artistFactForCard", () => {
  test("loads stats once and builds the fact", async () => {
    const calls = stubFetch(STATS);
    const a = await F.artistFactForCard("Some Artist", "2026-09-19");
    const b = await F.artistFactForCard("Some Artist", "2026-09-19");
    expect(a).toBe(b);
    expect(a).toContain("Some Artist");
    expect(calls()).toBe(1);
  });
  test("missing artist -> null without fetching", async () => {
    const calls = stubFetch(STATS);
    expect(await F.artistFactForCard("", "2026-09-19")).toBeNull();
    expect(calls()).toBe(0);
  });
});
