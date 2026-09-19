/* VaultDex unit tests — js/species.js card-name normalization.
 *
 * The normalizer maps TCG card names to PokéAPI species slugs. Unmatched
 * names return null ("unknown species") — never guessed. Tests inject a
 * small mapping via setMapping so no fetch is needed. */
import { describe, test, expect, beforeAll } from "vitest";
import "../js/species.js";

const S = window.App.species;

const SLUGS = [
  "bulbasaur", "charizard", "pikachu", "raichu", "raichu-alola",
  "nidoran-f", "nidoran-m", "mr-mime", "farfetchd", "ho-oh",
  "porygon-z", "mime-jr", "type-null", "zapdos", "zapdos-galar",
  "gyarados", "arcanine", "unown", "dialga", "ogerpon",
  "ogerpon-wellspring-mask", "ogerpon-hearthflame-mask",
  "ogerpon-cornerstone-mask", "ursaluna-bloodmoon", "zoroark-hisui",
  "wooper-paldea", "rotom", "wormadam", "shaymin", "shaymin-sky",
  "basculin-white-striped", "calyrex-ice", "calyrex-shadow",
  "necrozma-dusk", "necrozma-dawn", "kyurem-black", "kyurem-white",
  "wishiwashi", "flabebe", "mewtwo", "lucario", "charmeleon",
];

beforeAll(() => {
  const dex = {};
  SLUGS.forEach((s, i) => { dex[s] = i + 1; });
  S.setMapping({ order: SLUGS.slice(), dex });
});

describe("slugForCardName — TCG mechanic suffixes", () => {
  test.each([
    ["Pikachu ex", "pikachu"],
    ["Charizard VMAX", "charizard"],
    ["Mewtwo VSTAR", "mewtwo"],
    ["Charmeleon V", "charmeleon"],
    ["Dialga LV.X", "dialga"],
    ["Charizard \u03b4", "charizard"], // delta species
    ["Lucario \u25c7", "lucario"], // prism star
  ])("%s -> %s", (input, want) => {
    expect(S.slugForCardName(input)).toBe(want);
  });
});

describe("slugForCardName — regional forms", () => {
  test.each([
    ["Alolan Raichu", "raichu-alola"],
    ["Galarian Zapdos", "zapdos-galar"],
    ["Hisuian Zoroark", "zoroark-hisui"],
    ["Paldean Wooper", "wooper-paldea"],
  ])("%s -> %s", (input, want) => {
    expect(S.slugForCardName(input)).toBe(want);
  });
});

describe("slugForCardName — punctuation and gender marks", () => {
  test.each([
    ["Nidoran\u2640", "nidoran-f"],
    ["Nidoran\u2642", "nidoran-m"],
    ["Mr. Mime", "mr-mime"],
    ["Farfetch'd", "farfetchd"],
    ["Ho-Oh", "ho-oh"],
    ["Porygon-Z", "porygon-z"],
    ["Mime Jr.", "mime-jr"],
    ["Type: Null", "type-null"],
    ["Flab\u00e9b\u00e9", "flabebe"],
  ])("%s -> %s", (input, want) => {
    expect(S.slugForCardName(input)).toBe(want);
  });
});

describe("slugForCardName — flavor prefixes", () => {
  test.each([
    ["Dark Charizard", "charizard"],
    ["Light Arcanine", "arcanine"],
    ["Shining Gyarados", "gyarados"],
    ["Rocket's Zapdos", "zapdos"],
  ])("%s -> %s", (input, want) => {
    expect(S.slugForCardName(input)).toBe(want);
  });
});

describe("slugForCardName — special full-name cases", () => {
  test.each([
    ["Unown A", "unown"],
    ["Unown [R]", "unown"],
    ["Teal Mask Ogerpon ex", "ogerpon"],
    ["Wellspring Mask Ogerpon ex", "ogerpon-wellspring-mask"],
    ["Hearthflame Mask Ogerpon ex", "ogerpon-hearthflame-mask"],
    ["Cornerstone Mask Ogerpon ex", "ogerpon-cornerstone-mask"],
    ["Bloodmoon Ursaluna ex", "ursaluna-bloodmoon"],
    ["Pikachu with Grey Felt Hat", "pikachu"],
    ["Surfing Pikachu", "pikachu"],
    ["Heat Rotom", "rotom"],
    ["Wormadam Sandy Cloak", "wormadam"],
    ["Shaymin Sky Forme", "shaymin-sky"],
    ["White-Striped Basculin", "basculin-white-striped"],
    ["Ice Rider Calyrex VMAX", "calyrex-ice"],
    ["Shadow Rider Calyrex VMAX", "calyrex-shadow"],
    ["Dusk Mane Necrozma", "necrozma-dusk"],
    ["Dawn Wings Necrozma", "necrozma-dawn"],
    ["Black Kyurem", "kyurem-black"],
    ["White Kyurem EX", "kyurem-white"],
    ["School Form Wishiwashi", "wishiwashi"],
  ])("%s -> %s", (input, want) => {
    expect(S.slugForCardName(input)).toBe(want);
  });
});

describe("slugForCardName — unknown species are never guessed", () => {
  test.each([["Fake Mon XYZ", null], ["", null], [null, null], ["Pikachu123", null]])(
    "%s -> null",
    (input, want) => {
      expect(S.slugForCardName(input)).toBe(want);
    }
  );

  test("returns null when no mapping is loaded", () => {
    S.setMapping(null);
    expect(S.slugForCardName("Pikachu")).toBe(null);
    const dex = {};
    SLUGS.forEach((s, i) => { dex[s] = i + 1; });
    S.setMapping({ order: SLUGS.slice(), dex });
    expect(S.slugForCardName("Pikachu")).toBe("pikachu");
  });
});

describe("groupRowsBySpecies", () => {
  test("groups copies by slug and skips unknown names", () => {
    const rows = [
      { card_name: "Pikachu ex", quantity: 2 },
      { card_name: "Pikachu", quantity: 3 },
      { card_name: "Charizard VMAX", quantity: 1 },
      { card_name: "Fake Mon XYZ", quantity: 9 },
    ];
    const g = S.groupRowsBySpecies(rows);
    expect(Object.keys(g).sort()).toEqual(["charizard", "pikachu"]);
    expect(g.pikachu.copies).toBe(5);
    expect(g.pikachu.cards).toHaveLength(2);
    expect(g.charizard.copies).toBe(1);
  });
});

describe("displayName", () => {
  test.each([
    ["mr-mime", "Mr. Mime"],
    ["mr-rime", "Mr. Rime"],
    ["farfetchd", "Farfetch'd"],
    ["sirfetchd", "Sirfetch'd"],
    ["ho-oh", "Ho-Oh"],
    ["porygon-z", "Porygon-Z"],
    ["mime-jr", "Mime Jr."],
    ["type-null", "Type: Null"],
    ["nidoran-f", "Nidoran\u2640"],
    ["nidoran-m", "Nidoran\u2642"],
    ["flabebe", "Flab\u00e9b\u00e9"],
    ["raichu-alola", "Alolan Raichu"],
    ["zapdos-galar", "Galarian Zapdos"],
    ["tapu-koko", "Tapu Koko"],
    ["pikachu", "Pikachu"],
  ])("%s -> %s", (input, want) => {
    expect(S.displayName(input)).toBe(want);
  });
});
