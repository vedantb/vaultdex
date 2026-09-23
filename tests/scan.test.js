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
    expect(info).toEqual({ name: "", nameJa: "", number: "", illustrator: "" });
  });

  test("pulls the illustrator credit from a mangled 'Illus.' marker", () => {
    const info = extractCardInfo({
      text: "Psyduck\n| Mllus. OKACHEKE Ithas been found",
      lines: [
        ocrLine("gems Psyduck 70 &", 50, 72),
        ocrLine("| Mllus. OKACHEKE Ithas been found", 750, 772)
      ]
    });
    expect(info.illustrator).toBe("OKACHEKE");
  });

  test("rescues the illustrator when the marker itself is unreadable ('Hos. chibi')", () => {
    const tokens = App.scan.buildIllustratorTokens([
      { illustrator: "chibi" },
      { illustrator: "Mitsuhiro Arita" }
    ]);
    const info = extractCardInfo({
      text: "Hos. chibi When Pikachu meet",
      lines: [
        ocrLine("Pikachu w60 4)", 40, 62),
        ocrLine("Hos. chibi When Pikachu meet, they ll touch their tails", 752, 774)
      ]
    }, tokens);
    expect(info.illustrator).toBe("chibi");
  });

  test("buildIllustratorTokens drops polluted credits (GAME FREAK, energy cards, HTML notes)", () => {
    const tokens = App.scan.buildIllustratorTokens([
      { illustrator: "GAME FREAK inc." },
      { illustrator: "Basic Grass Energy" },
      { illustrator: '<span>(This card cannot be used at official tournaments.)</span>' },
      { illustrator: "chibi" }
    ]);
    expect(tokens.game).toBeUndefined();
    expect(tokens.freak).toBeUndefined();
    expect(tokens.energy).toBeUndefined();
    expect(tokens.this).toBeUndefined();
    expect(tokens.chibi).toBe(true);
  });

  test("keeps a mixed-script name readable in both languages", () => {
    const info = extractCardInfo({
      text: "soc Psyduck 上 生",
      lines: [ocrLine("soc Psyduck 上 生", 50, 72)]
    });
    expect(info.name).toMatch(/psyduck/i);
    expect(info.nameJa).toBe("上生");
  });

  test("strips Tesseract's artifact spaces inside Japanese names", () => {
    const info = extractCardInfo({
      text: "ピカ チュ ウ",
      lines: [ocrLine("ピカ チュ ウ", 50, 72)]
    });
    expect(info.nameJa).toBe("ピカチュウ");
    expect(info.name).toBe("");
  });

  test("the evolution line never wins the name (it names the wrong species)", () => {
    const info = extractCardInfo({
      text: "Charizard 120 HP\nSTAGE 2 Evolves from Charmeleon",
      lines: [
        ocrLine("Charizard 120 HP", 40, 70),
        ocrLine("STAGE 2 Evolves from Charmeleon", 80, 105)
      ]
    });
    expect(info.name).toBe("Charizard");
  });

  test("a bare number inside flavor text is not the card number", () => {
    const info = extractCardInfo({
      text: "Ithas been found thatits brain cells are 10 times more.\n©2021 GAME FREAK.",
      lines: [
        ocrLine("Pikachu", 40, 70),
        ocrLine("Ithas been found thatits brain cells are 10 times more.", 740, 765),
        ocrLine("©2021 GAME FREAK.", 790, 810)
      ]
    });
    expect(info.number).toBe("");
  });
});

describe("scoreEntry", () => {
  test("an exact name hit outscores a number-only hit (stray numbers must not bury the name)", () => {
    const numHit = scoreEntry(ENTRIES[1], { name: "", number: "60" });
    const nameHit = scoreEntry(ENTRIES[0], { name: "Pikachu", number: "" });
    expect(nameHit).toBeGreaterThan(numHit);
  });

  test("name plus number together beats either alone", () => {
    const both = scoreEntry(ENTRIES[1], { name: "Charizard ex", number: "60" });
    const nameOnly = scoreEntry(ENTRIES[1], { name: "Charizard ex", number: "" });
    const numOnly = scoreEntry(ENTRIES[1], { name: "", number: "60" });
    expect(both).toBeGreaterThan(nameOnly);
    expect(both).toBeGreaterThan(numOnly);
  });

  test("an OCR-mangled name token still scores (fuzzy match)", () => {
    const psyduck = { id: "swsh7-24", localId: "24", name: "Psyduck", lang: "en" };
    expect(scoreEntry(psyduck, { name: "Psyduok", number: "" })).toBeGreaterThan(0);
    expect(scoreEntry(psyduck, { name: "xyzzy", number: "" })).toBe(0);
  });

  test("the illustrator credit boosts the right printing", () => {
    const chibi = { id: "swsh7-49", localId: "49", name: "Pikachu", lang: "en", illustrator: "chibi" };
    const other = { id: "sv01-25", localId: "25", name: "Pikachu", lang: "en", illustrator: "Mitsuhiro Arita" };
    const info = { name: "Pikachu", number: "", illustrator: "chibi" };
    expect(scoreEntry(chibi, info)).toBeGreaterThan(scoreEntry(other, info));
  });

  test("zero means no evidence", () => {
    expect(scoreEntry(ENTRIES[0], { name: "", number: "" })).toBe(0);
  });
});

describe("rankCandidates", () => {
  test("a stray number does not outrank the exactly-named card", () => {
    const ranked = rankCandidates(ENTRIES, { name: "Pikachu", number: "60" });
    expect(ranked[0].name).toBe("Pikachu");
  });

  test("name plus number pinpoints the exact printing", () => {
    const ranked = rankCandidates(ENTRIES, { name: "Pikachu", number: "58" });
    expect(ranked[0].id).toBe("base1-58");
  });

  test("a bare card number alone is not evidence (no cross-set random list)", () => {
    /* A lone "060" matches ~150 printings across sets; the 12 shown
     * would be effectively random. Withheld instead — cf. the iPhone
     * photo of N's Zekrom, whose misread "5" surfaced twelve unrelated
     * #005s. Manual search is one tap away from the honest empty state. */
    expect(rankCandidates(ENTRIES, { name: "", number: "060" })).toEqual([]);
    /* ...but the number still scores when corroborated, and leading
     * zeros still normalize against the catalog form. */
    expect(scoreEntry(ENTRIES[1], { name: "", number: "060" })).toBe(80);
    const ranked = rankCandidates(ENTRIES, { name: "Charizard ex", number: "060" });
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

describe("user-reported regressions (swsh7 Evolving Skies)", () => {
  /* Real Tesseract output (eng+jpn, 600x825 catalog scan) for the two
   * cards Vedant reported on 2026-09-23:
   *  - Pikachu 049/203, illus. chibi — "couldn't read correctly"
   *  - Psyduck 024/203, illus. OKACHEKE — "only a Japanese variant,
   *    English never appeared"
   * The old pipeline read the illustrator/flavor line as the name and a
   * flavor-text number ("10 times more") as the card number. */

  const PIKACHU_OCR = {
    text: "Pikachu w60 4)\nHos. chibi When Pikachu meet\n幸 ©2021 Pokemon/Nintendo/Creatures GAME FREAK. 4",
    lines: [
      ocrLine("Pikachu w60 4)", 40, 62),
      ocrLine("Attach a 4 Energy card from your discard pile to this", 520, 542),
      ocrLine("Hos. chibi When Pikachu meet, they ll touch their tails together and", 752, 774),
      ocrLine("幸 ©2021 Pokemon/Nintendo/Creatures GAME FREAK. 4", 803, 825)
    ]
  };

  const PSYDUCK_OCR = {
    text: "gems Psyduck 70 &\n| Mllus. OKACHEKE Ithas been found thatits brain cells are 10 times more.\n©2021 Pokémon / Nintendo / Creatures / GAME FREAK 。",
    lines: [
      ocrLine("gems Psyduck 70 &", 50, 72),
      ocrLine("fr NO.054 Duck Pokémon. HT. 27° WI. 43.2 1b, pe", 392, 414),
      ocrLine("| Xx Rain Splash 10", 548, 570),
      ocrLine("| Mllus. OKACHEKE Ithas been found thatits brain cells are 10 times more.", 750, 772),
      ocrLine("| Oe active when Psyduck is experiencing a headache.", 771, 793),
      ocrLine("©2021 Pokémon / Nintendo / Creatures / GAME FREAK 。", 796, 818)
    ]
  };

  const PRINTINGS = [
    { id: "swsh7-49", localId: "49", name: "Pikachu", lang: "en", illustrator: "chibi" },
    { id: "2022swsh-7", localId: "7", name: "Pikachu", lang: "en", illustrator: "chibi" },
    { id: "sv01-25", localId: "25", name: "Pikachu", lang: "en", illustrator: "Mitsuhiro Arita" },
    { id: "SM0-004", localId: "004", name: "Pikachu", lang: "ja", illustrator: "Naoyo Kimura" },
    { id: "swsh7-24", localId: "24", name: "Psyduck", lang: "en", illustrator: "OKACHEKE" },
    { id: "xy9-16", localId: "16", name: "Psyduck", lang: "en", illustrator: "Mitsuhiro Arita" },
    { id: "PMCG3-010", localId: "010", name: "Psyduck", nameJa: "コダック", lang: "ja", illustrator: "OKACHEKE" },
    { id: "SV2a-010", localId: "010", name: "Caterpie", nameJa: "キャタピー", lang: "ja", illustrator: "chibi" }
  ];

  test("Pikachu 049/203: name reads, flavor numbers are not the card number", () => {
    const info = extractCardInfo(PIKACHU_OCR);
    expect(info.name).toBe("Pikachu");
    expect(info.number).toBe("");
  });

  test("Pikachu 049/203: the English printing ranks first", () => {
    const info = extractCardInfo(PIKACHU_OCR);
    const ranked = rankCandidates(PRINTINGS, info, 8);
    expect(ranked[0].id).toBe("swsh7-49");
    expect(ranked[0].lang).toBe("en");
  });

  test("Psyduck 024/203: name reads, '10 times more' is not the card number", () => {
    const info = extractCardInfo(PSYDUCK_OCR);
    expect(info.name).toMatch(/psyduck/i);
    expect(info.number).toBe("");
    expect(info.illustrator).toBe("OKACHEKE");
  });

  test("Psyduck 024/203: English printings are never buried under Japanese ones", () => {
    const info = extractCardInfo(PSYDUCK_OCR);
    const ranked = rankCandidates(PRINTINGS, info, 8);
    expect(ranked[0].lang).toBe("en");
    expect(ranked.map((e) => e.id)).toContain("swsh7-24");
    /* The old bug: the JA Psyduck (same illustrator, stray number "10")
     * ranked above every English printing. */
    const enIdx = ranked.findIndex((e) => e.lang === "en");
    const jaPsyIdx = ranked.findIndex((e) => e.id === "PMCG3-010");
    expect(enIdx).toBeLessThan(jaPsyIdx);
  });

  test("set recency breaks ties toward newer printings", () => {
    const setRank = { "swsh7": 50, "sv01": 20 };
    const ranked = rankCandidates(
      [PRINTINGS[0], PRINTINGS[2]],
      { name: "Pikachu", number: "" }, 8, setRank
    );
    expect(ranked[0].id).toBe("sv01-25");
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

describe("phone-photo regression: garbage OCR never yields random cards (2026-09-23)", () => {
  /* After the accuracy repair, real iPhone scans surfaced "completely
   * random cards". Root causes, all in scoreEntry:
   *  - short OCR fragments ("tt") substring-matched any catalog word
   *    containing them ("banette", "jett", "floette")
   *    — cf. the en-sm1-28 corpus case, "TTT TT ETT" glare garbage
   *  - single-letter catalog names ("N") matched via the containment
   *    bonus against any garbage query containing the letter
   *    — cf. the ja-M-P-002 corpus case, "SSN ue i e"
   * The tightened token rules plus the MIN_SCORE confidence gate
   * withhold these; the view renders its honest "couldn't read it"
   * state instead of a random list. */

  const GARBAGE_ENTRIES = [
    { id: "me05-034", localId: "34", name: "Banette", lang: "en" },
    { id: "me05-079", localId: "79", name: "Jett", lang: "en" },
    { id: "me04-035", localId: "35", name: "Mega Floette ex", lang: "en" },
    { id: "30th-015", localId: "15", name: "Fuecoco ex", lang: "en" },
    { id: "30th-c-021", localId: "21", name: "N", lang: "en" },
    { id: "swsh7-24", localId: "24", name: "Psyduck", lang: "en" }
  ];

  test("glare garbage ('TTT TT ETT') yields no candidates, not Banette/Jett", () => {
    const info = extractCardInfo({
      text: "TTT TT ETT\n©2021 Pokémon",
      lines: [ocrLine("TTT TT ETT", 40, 70), ocrLine("©2021 Pokémon", 780, 800)]
    });
    expect(info.name).toBe("TTT TT ETT");
    expect(rankCandidates(GARBAGE_ENTRIES, info, 12)).toEqual([]);
  });

  test("fragment garbage ('SSN ue i e') does not match the 'N' trainer", () => {
    const info = extractCardInfo({
      text: "SSN ue i e",
      lines: [ocrLine("SSN ue i e", 45, 70)]
    });
    expect(rankCandidates(GARBAGE_ENTRIES, info, 12)).toEqual([]);
  });

  test("blur garbage yields no candidates", () => {
    const info = extractCardInfo({
      text: "asdf qwer\nzxcv",
      lines: [ocrLine("asdf qwer", 100, 130), ocrLine("zxcv", 700, 730)]
    });
    expect(rankCandidates(GARBAGE_ENTRIES, info, 12)).toEqual([]);
  });

  test("a lone weak fragment stays below the confidence bar", () => {
    /* "Firex": one fuzzy token hit (5) + containment (20) + language
     * (10) = 35 < MIN_SCORE (40) — withheld, not shown as a guess. */
    const ranked = rankCandidates(
      [{ id: "t-1", localId: "1", name: "Fire", lang: "en" }],
      { name: "Firex", number: "" }, 12);
    expect(ranked).toEqual([]);
    expect(App.scan.MIN_SCORE).toBe(40);
  });

  test("a real partial read ('Pikachu ex' vs 'Pikachu') still clears the gate", () => {
    const ranked = rankCandidates(
      [{ id: "sv01-25", localId: "25", name: "Pikachu", lang: "en" }],
      { name: "Pikachu ex", number: "" }, 12);
    expect(ranked.length).toBe(1);
  });

  test("callers can tighten the bar explicitly", () => {
    const e = { id: "x-1", localId: "1", name: "Pikachu", lang: "en" };
    expect(rankCandidates([e], { name: "Pikachu", number: "" }, 12, null, 200)).toEqual([]);
    expect(rankCandidates([e], { name: "Pikachu", number: "" }, 12, null, 0).length).toBe(1);
  });

  test("y-normalization survives phone framing (table visible around the card)", () => {
    /* Card occupies y 200..1200 of a 1600px photo; a stray
     * background-texture line sits below it. Normalization is
     * monotonic, so top/bottom ordering — and the name/number picks —
     * survive the framing. */
    const info = extractCardInfo({
      text: "Pikachu\n060/198",
      lines: [
        ocrLine("Pikachu", 210, 250),
        ocrLine("060/198", 1100, 1140),
        ocrLine(".. .", 1450, 1480)
      ]
    });
    expect(info.name).toBe("Pikachu");
    expect(info.number).toBe("60");
  });
});

describe("real iPhone photo regressions (2026-09-23)", () => {
  /* Vedant's three real scans (iPhone photos: sleeve glare, fingers,
   * off-angle framing). The info objects below are what the production
   * extractCardInfo produced from the actual Tesseract eng+jpn output
   * for each photo — see ~/workspace/.qa/ocr/photos-before.json.
   * All three cards exist in the catalog (mep-031, me02.5-159,
   * mee-001), so every failure here is recognition-side. */

  test("glare-destroyed Zekrom read yields no candidates, not random #005s", () => {
    /* N's Zekrom, MEP EN 031. Glare destroyed the name bar; OCR kept a
     * stray "5" as the number. A bare number matches every set's #005,
     * so the old code surfaced twelve unrelated cards (M4-005,
     * 30th-005, ...). Now: honest empty. */
    const entries = [
      { id: "mep-031", localId: "31", name: "N's Zekrom", lang: "en" },
      { id: "mep-005", localId: "5", name: "MEP Card Five", lang: "en" },
      { id: "sv01-005", localId: "5", name: "SV01 Card Five", lang: "en" }
    ];
    const info = { name: "J SERCH SE en RRR Se", nameJa: "うー", number: "5", illustrator: "" };
    expect(rankCandidates(entries, info, 12)).toEqual([]);
  });

  test("Drakloak read ranks the Ascended Heroes printing #1", () => {
    /* Drakloak, "ASC" = Ascended Heroes (TCGdex me02.5), 159/217.
     * The name bar read cleanly; the number misread as "4" matches
     * nothing, so the exact name hit must carry the ranking. */
    const entries = [
      { id: "me02.5-159", localId: "159", name: "Drakloak", lang: "en" },
      { id: "me02.5-248", localId: "248", name: "Drakloak", lang: "en" },
      { id: "swsh7-091", localId: "91", name: "Drakloak", lang: "en" }
    ];
    const info = { name: "Drakloak", nameJa: "", number: "4", illustrator: "" };
    const ranked = rankCandidates(entries, info, 12);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].id).toBe("me02.5-159");
  });

  test("mangled energy read yields no candidates, not random energy types", () => {
    /* Basic Grass Energy, MEE EN 001. The name bar came out
     * "Basic.Enerdy i ENERG" with the type and number unreadable; the
     * fragments matched every Basic Energy type at gate strength (the
     * old code showed Darkness/Metal/Psychic/...). Now: honest empty. */
    const entries = [
      { id: "mee-001", localId: "1", name: "Grass Energy", lang: "en" },
      { id: "sv02-278", localId: "278", name: "Basic Grass Energy", lang: "en" },
      { id: "sv06.5-098", localId: "98", name: "Basic Darkness Energy", lang: "en" },
      { id: "sv01-230", localId: "230", name: "Basic Fire Energy", lang: "en" }
    ];
    const info = { name: "Basic.Enerdy i ENERG", nameJa: "リンミミ", number: "", illustrator: "" };
    expect(rankCandidates(entries, info, 12)).toEqual([]);
  });

  test("a clean 'Basic Grass Energy' read finds Grass Energy (catalog says 'Grass Energy')", () => {
    /* The card prints "Basic Grass Energy"; the catalog names it
     * "Grass Energy". The energy alias bridges the two, and the type
     * token keeps the wrong energy types below the right one. */
    const entries = [
      { id: "mee-001", localId: "1", name: "Grass Energy", lang: "en" },
      { id: "sv06.5-098", localId: "98", name: "Basic Darkness Energy", lang: "en" },
      { id: "sv01-230", localId: "230", name: "Basic Fire Energy", lang: "en" }
    ];
    const ranked = rankCandidates(entries, { name: "Basic Grass Energy", number: "" }, 12);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].name).toBe("Grass Energy");
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
