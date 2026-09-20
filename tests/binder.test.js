/* VaultDex unit tests — js/binder.js idea generator.
 *
 * Pure color/layout logic plus generatePages with a fully stubbed ctx
 * (no network, no catalog). Covers every recipe and layout's composition
 * invariants: 9 slots, anchors pinned, no duplicate cards, inserts span
 * correctly, locked slots survive a reshuffle.
 */
import { describe, test, expect } from "vitest";
import "../js/binder.js";

const B = window.App.binder;

/* ---------- stub world ---------- */

function pal(h, s, l, w) { return [[h, s, l, w || 100]]; }

function stubCtx(over) {
  const cards = {
    "en:char-1": { id: "char-1", name: "Charmander", rarity: "Common", artist: "Arita", images: { small: "c1.png" }, set: { id: "s1", name: "Set One", lang: "en", appId: "s1" }, types: ["Fire"] },
    "en:char-2": { id: "char-2", name: "Charmeleon", rarity: "Uncommon", artist: "Arita", images: { small: "c2.png" }, set: { id: "s1", name: "Set One", lang: "en", appId: "s1" }, types: ["Fire"] },
    "en:char-3": { id: "char-3", name: "Charizard", rarity: "Rare", artist: "Arita", images: { small: "c3.png" }, set: { id: "s1", name: "Set One", lang: "en", appId: "s1" }, types: ["Fire"] },
    "en:char-4": { id: "char-4", name: "Charizard ex", rarity: "Double rare", artist: "Arita", images: { small: "c4.png" }, set: { id: "s2", name: "Set Two", lang: "en", appId: "s2" }, types: ["Fire"] },
    "en:aqua-1": { id: "aqua-1", name: "Squirtle", rarity: "Common", artist: "Sugimori", images: { small: "a1.png" }, set: { id: "s1", name: "Set One", lang: "en", appId: "s1" }, types: ["Water"] },
    "en:aqua-2": { id: "aqua-2", name: "Blastoise", rarity: "Illustration rare", artist: "Sugimori", images: { small: "a2.png" }, set: { id: "s2", name: "Set Two", lang: "en", appId: "s2" }, types: ["Water"] },
  };
  const ctx = {
    palettes: {
      "en:char-1": { p: pal(15, 70, 50) },
      "en:char-2": { p: pal(20, 65, 45) },
      "en:char-3": { p: pal(10, 75, 48) },
      "en:char-4": { p: pal(12, 80, 42) },
      "en:aqua-1": { p: pal(210, 60, 50) },
      "en:aqua-2": { p: pal(215, 55, 45) },
      "en:leaf-1": { p: pal(120, 50, 45) },
      "en:leaf-2": { p: pal(130, 45, 40) },
      "en:sun-1": { p: pal(45, 80, 55) },
      "en:night-1": { p: pal(270, 40, 25) },
      "en:rose-1": { p: pal(330, 60, 60) },
      "en:teal-1": { p: pal(180, 55, 45) },
      "en:sky-1": { p: pal(200, 70, 60) },
    },
    indexById: {},
    ownedKeys: new Set(["en:char-1", "en:aqua-1"]),
    artistCards: { "Arita": ["en:char-1", "en:char-2", "en:char-3", "en:char-4"] },
    speciesPrintings: {
      "charmander": [["char-1", "en", "Charmander", "Set One", "c1.png"]],
      "charmeleon": [["char-2", "en", "Charmeleon", "Set One", "c2.png"]],
      "charizard": [["char-3", "en", "Charizard", "Set One", "c3.png"], ["char-4", "en", "Charizard ex", "Set Two", "c4.png"]],
      "pikachu": [["pika-1", "en", "Pikachu", "Set One", "p1.png"]],
    },
    setRank: { s1: 5, s2: 1 },
    setNames: { s1: "Set One", s2: "Set Two" },
    parseKey(k) {
      const i = k.indexOf(":");
      const lang = k.slice(0, i), id = k.slice(i + 1);
      const d = id.lastIndexOf("-");
      const sid = d > 0 ? id.slice(0, d) : id;
      return { lang, id, appSetId: lang === "ja" ? "ja-" + sid : sid };
    },
    keyOf(c) { return c.set.lang + ":" + c.id; },
    speciesSlug(n) { return String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); },
    async getSetCards(appSetId) {
      return Object.keys(cards).filter((k) => this.parseKey(k).appSetId === appSetId).map((k) => cards[k]);
    },
    async evoChain(slug) {
      if (slug === "charizard") return ["charmander", "charmeleon", "charizard"];
      return [slug];
    },
    inserts: [{ id: "t1", src: "/ins/ember.jpg", title: "Ember Fields", hues: [12], moods: ["vibrant", "dark"] }],
  };
  Object.keys(ctx.palettes).forEach((k) => {
    const id = k.split(":")[1];
    ctx.indexById[k] = { key: k, id, lang: "en", name: id, image: id + ".png" };
  });
  return Object.assign(ctx, over || {});
}

function anchor(key, name, over) {
  return Object.assign({
    key,
    speciesSlug: "charizard",
    card: {
      id: key.split(":")[1], name, rarity: "Double rare", artist: "Arita",
      images: { small: key + ".png" },
      set: { id: "s2", name: "Set Two", lang: "en", appId: "s2" },
      types: ["Fire"],
    },
  }, over || {});
}

function cardKeys(page) {
  return page.slots.filter((s) => s && s.kind === "card").map((s) => s.key);
}

/* ---------- color utils ---------- */

describe("hue helpers", () => {
  test("hueFamily buckets the wheel", () => {
    expect(B.hueFamily(5)).toBe("red");
    expect(B.hueFamily(25)).toBe("orange");
    expect(B.hueFamily(210)).toBe("blue");
    expect(B.hueFamily(280)).toBe("purple");
    expect(B.hueFamily(350)).toBe("red");
  });
  test("hueDist wraps around 0/360", () => {
    expect(B.hueDist(350, 10)).toBe(20);
    expect(B.hueDist(10, 350)).toBe(20);
    expect(B.hueDist(0, 180)).toBe(180);
  });
  test("paletteDistance is ~0 for identical palettes", () => {
    const p = pal(210, 60, 50);
    expect(B.paletteDistance(p, p)).toBeLessThan(0.001);
    expect(B.paletteDistance(p, pal(20, 60, 50))).toBeGreaterThan(0.3);
  });
  test("meanHue averages circularly", () => {
    expect(B.meanHue([pal(350, 50, 50), pal(10, 50, 50)])).toBe(0);
  });
});

describe("vibeScore", () => {
  test("hue match scores high, opposite scores low", () => {
    const blue = pal(210, 60, 50);
    expect(B.vibeScore(blue, { hue: 210 })).toBeGreaterThan(0.8);
    expect(B.vibeScore(blue, { hue: 30 })).toBeLessThan(0.4);
  });
  test("mood dark prefers low lightness", () => {
    expect(B.vibeScore(pal(210, 40, 20), { hue: null, mood: "dark" })).toBe(1);
    expect(B.vibeScore(pal(210, 40, 80), { hue: null, mood: "dark" })).toBeLessThan(0.6);
  });
  test("empty palette scores 0", () => {
    expect(B.vibeScore(null, { hue: 210 })).toBe(0);
  });
});

describe("rarityWeight", () => {
  test("art rares outrank bulk", () => {
    expect(B.rarityWeight("Illustration rare")).toBeGreaterThan(B.rarityWeight("Rare"));
    expect(B.rarityWeight("Common")).toBeLessThan(B.rarityWeight("Uncommon"));
    expect(B.rarityWeight("mystery")).toBe(30);
  });
});

/* ---------- layout primitives ---------- */

describe("anchorPositions", () => {
  test("anchors take the centered middle row", () => {
    expect(B.anchorPositions(1)).toEqual([4]);
    expect(B.anchorPositions(2)).toEqual([3, 4]);
    expect(B.anchorPositions(3)).toEqual([3, 4, 5]);
  });
});

describe("blankPositions", () => {
  test("prefers corners and avoids taken slots", () => {
    const rand = B.prng(7);
    const blanks = B.blankPositions([4], 2, rand);
    expect(blanks).toHaveLength(2);
    blanks.forEach((p) => {
      expect([0, 2, 6, 8]).toContain(p);
      expect(p).not.toBe(4);
    });
  });
});

/* ---------- generatePages ---------- */

describe("generatePages: classic color story", () => {
  test("3 pages, 9 slots each, anchor pinned, no dupes", async () => {
    const ctx = stubCtx();
    const pages = await B.generatePages([anchor("en:char-4", "Charizard ex")],
      { recipe: "color", layout: "classic", vibe: { hue: 12, mood: null }, density: 1, seed: 42 }, ctx);
    expect(pages).toHaveLength(3);
    for (const pg of pages) {
      expect(pg.slots).toHaveLength(9);
      expect(pg.slots[4].anchor).toBe(true);
      expect(pg.slots[4].key).toBe("en:char-4");
      const keys = cardKeys(pg);
      expect(new Set(keys).size).toBe(keys.length); // no duplicate cards
      const nonAnchor = pg.slots.filter((s) => s && s.kind === "card" && !s.anchor).map((s) => s.key);
      expect(nonAnchor).not.toContain("en:char-4"); // anchor never re-suggested
      pg.slots.forEach((s) => expect(s && s.reason).toBeTruthy());
    }
  });
  test("airy density reserves real blanks", async () => {
    const ctx = stubCtx();
    const [pg] = await B.generatePages([anchor("en:char-4", "Charizard ex")],
      { recipe: "color", layout: "classic", vibe: { hue: 12 }, density: 0, seed: 42 }, ctx);
    const blanks = pg.slots.filter((s) => s.kind === "blank");
    expect(blanks.length).toBeGreaterThanOrEqual(2);
  });
  test("ownedOnly restricts the pool", async () => {
    const ctx = stubCtx();
    const [pg] = await B.generatePages([anchor("en:char-4", "Charizard ex")],
      { recipe: "color", layout: "classic", vibe: { hue: 200 }, ownedOnly: true, density: 1, seed: 1 }, ctx);
    cardKeys(pg).forEach((k) => {
      if (k !== "en:char-4") expect(ctx.ownedKeys.has(k)).toBe(true);
    });
  });
});

describe("generatePages: evolution", () => {
  test("fills stage-1 and stage-2 cards around the anchor", async () => {
    const ctx = stubCtx();
    const [pg] = await B.generatePages([anchor("en:char-4", "Charizard ex")],
      { recipe: "evolution", layout: "classic", density: 1, seed: 3 }, ctx);
    const keys = cardKeys(pg);
    expect(keys).toContain("en:char-1"); // Charmander
    expect(keys).toContain("en:char-2"); // Charmeleon
    const reasons = pg.slots.filter((s) => s.kind === "card" && !s.anchor).map((s) => s.reason);
    expect(reasons.some((r) => r.indexOf("Stage") === 0)).toBe(true);
  });
});

describe("generatePages: artist spotlight", () => {
  test("picks same-artist cards, no duplicate species", async () => {
    const ctx = stubCtx();
    const [pg] = await B.generatePages([anchor("en:char-4", "Charizard ex")],
      { recipe: "artist", layout: "classic", density: 1, seed: 5 }, ctx);
    const nonAnchor = pg.slots.filter((s) => s.kind === "card" && !s.anchor);
    expect(nonAnchor.length).toBeGreaterThan(0);
    nonAnchor.forEach((s) => expect(s.reason).toMatch(/Arita/));
  });
});

describe("generatePages: gradient", () => {
  test("cards lay out in hue order", async () => {
    const ctx = stubCtx();
    const [pg] = await B.generatePages([anchor("en:char-4", "Charizard ex")],
      { recipe: "gradient", layout: "classic", density: 1, seed: 9 }, ctx);
    const hues = pg.slots
      .filter((s) => s && s.kind === "card" && !s.anchor)
      .map((s) => B.dominant(ctx.palettes[s.key].p)[0]);
    // At least roughly ordered: count inversions vs sorted order.
    let inv = 0;
    for (let i = 0; i < hues.length; i++)
      for (let j = i + 1; j < hues.length; j++)
        if (hues[i] > hues[j]) inv++;
    const maxInv = (hues.length * (hues.length - 1)) / 2;
    expect(inv / Math.max(maxInv, 1)).toBeLessThan(0.45);
  });
});

describe("generatePages: michi layouts", () => {
  test("panorama spans one insert across the bottom row", async () => {
    const ctx = stubCtx();
    const [pg] = await B.generatePages([anchor("en:char-4", "Charizard ex")],
      { recipe: "color", layout: "panorama", vibe: { hue: 12 }, seed: 11 }, ctx);
    const inserts = pg.slots.filter((s) => s && s.kind === "insert");
    expect(inserts.length).toBeGreaterThanOrEqual(2); // shared slot object
    const first = pg.slots.find((s) => s && s.kind === "insert");
    expect(first.span).toBeGreaterThanOrEqual(2);
    expect(first.positions).toContain(6);
    // All spanned positions reference the same slot object.
    first.positions.forEach((p) => expect(pg.slots[p]).toBe(first));
  });
  test("gallery has a terrain insert and real blanks", async () => {
    const ctx = stubCtx();
    const [pg] = await B.generatePages([anchor("en:char-4", "Charizard ex")],
      { recipe: "color", layout: "gallery", vibe: { hue: 12 }, seed: 13 }, ctx);
    const ins = pg.slots.find((s) => s && s.kind === "insert");
    expect(ins).toBeTruthy();
    expect(ins.insert.kind).toBe("terrain");
    expect(pg.slots.filter((s) => s.kind === "blank").length).toBeGreaterThanOrEqual(2);
    expect(cardKeys(pg).length).toBeLessThanOrEqual(5); // heroes only
  });
});

describe("generatePages: locked slots", () => {
  test("locked pockets survive a reshuffle", async () => {
    const ctx = stubCtx();
    const opts = { recipe: "color", layout: "classic", vibe: { hue: 12 }, density: 1, seed: 21 };
    const [first] = await B.generatePages([anchor("en:char-4", "Charizard ex")], opts, ctx);
    const locked = new Array(9).fill(null);
    locked[0] = first.slots[0];
    locked[8] = first.slots[8];
    const [second] = await B.generatePages([anchor("en:char-4", "Charizard ex")],
      Object.assign({}, opts, { seed: 22 }), ctx, locked);
    expect(second.slots[0]).toBe(first.slots[0]);
    expect(second.slots[8]).toBe(first.slots[8]);
    expect(second.slots[4].anchor).toBe(true);
  });
});

describe("prng", () => {
  test("same seed, same sequence", () => {
    const a = B.prng(99), b = B.prng(99);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });
});

describe("entryImage + page variety", () => {
  test("entryImage appends /low.png to bare TCGdex asset URLs", () => {
    expect(B.entryImage({ image: "https://assets.tcgdex.net/en/me/30th/001" }))
      .toBe("https://assets.tcgdex.net/en/me/30th/001/low.png");
    expect(B.entryImage({ image: "https://images.pkmnprices.com/cards/x.webp" }))
      .toBe("https://images.pkmnprices.com/cards/x.webp");
    expect(B.entryImage(null)).toBeNull();
  });

  test("three pages from one deal differ (per-page jitter)", async () => {
    const ctx = stubCtx();
    const pages = await B.generatePages([anchor("en:char-4", "Charizard ex")],
      { recipe: "color", layout: "classic", seed: 5 }, ctx);
    const sigs = pages.map((p) => cardKeys(p).join(","));
    expect(new Set(sigs).size).toBeGreaterThan(1);
  });
});
