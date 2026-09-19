/* VaultDex — build data/artist-stats.json.
 *
 * Walks the local TCGdex catalog snapshots (EN + JA) and aggregates per
 * illustrator: first set, first/last year, distinct species illustrated,
 * and total cards. Powers the Card of the Day "Did you know?" artist fact.
 *
 * Species counting uses the REAL normalizer from js/species.js (loaded via
 * a window shim, same as build-species-printings.js) — never a
 * reimplementation. Names that don't map to a known species are skipped
 * from the species count (never guessed).
 *
 * Curated "legend" facts below are hand-verified (web sources checked
 * 2026-09-19) and baked in as _legends — never generated. If a claim
 * can't be verified, it doesn't go in.
 *
 * RE-RUN THIS whenever the catalog changes (weekly TCGdex snapshot,
 * Japanese enrichment, M6a rebuild, image backfill):
 *   node scripts/build-artist-stats.js
 *
 * Output format:
 *   { "_meta": { "generated_at": "...", "artists": N },
 *     "_legends": { "Mitsuhiro Arita": "...", ... },
 *     "<artist>": { "firstSet": "Base Set", "firstYear": 1999,
 *                   "lastYear": 2026, "species": 312, "cards": 841 } }
 * Zero PkmnPrices credits: everything here is local/static data.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const OUT = path.join(DATA, "artist-stats.json");

/* species.js is a browser IIFE that attaches to window.App — shim it so
 * the exact same normalizer code runs in node. */
global.window = global;
require(path.join(ROOT, "js", "species.js"));
const species = global.App && global.App.species;
if (!species) {
  console.error("failed to load js/species.js");
  process.exit(1);
}
species.setMapping(JSON.parse(fs.readFileSync(path.join(DATA, "pokemon-species.json"), "utf8")));

/* Hand-verified artist facts (sources checked 2026-09-19). Curated facts
 * take precedence over computed ones in the app. */
const LEGENDS = {
  "Mitsuhiro Arita":
    "Mitsuhiro Arita illustrated the original Base Set Charizard — the most iconic card in the TCG.",
  "Atsuko Nishida":
    "Atsuko Nishida designed Pikachu itself, the face of the franchise.",
  "Ken Sugimori":
    "Ken Sugimori drew the original artwork for all 151 Generation I Pokémon."
};

function yearOf(set) {
  const rd = set && set.releaseDate;
  if (typeof rd !== "string") return null;
  const y = parseInt(rd.slice(0, 4), 10);
  return y >= 1995 && y <= 2100 ? y : null;
}

function walkLang(dir, onCard) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (e) {
    console.warn("skip missing dir:", dir);
    return 0;
  }
  let sets = 0;
  files.forEach((f) => {
    let snap;
    try {
      snap = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch (e) {
      console.warn("skip unreadable set file:", f, e && e.message);
      return;
    }
    if (!snap || !Array.isArray(snap.cards) || !snap.set) return;
    sets++;
    const setName = snap.set.name || f.replace(/\.json$/, "");
    const year = yearOf(snap.set);
    snap.cards.forEach((card) => onCard(card, setName, year));
  });
  return sets;
}

const artists = {}; // name -> { firstSet, firstYear, lastYear, species:Set, cards }

function record(card, setName, year) {
  const name = String((card && card.illustrator) || "").trim();
  if (!name) return;
  let a = artists[name];
  if (!a) {
    a = artists[name] = { firstSet: null, firstYear: null, lastYear: null, species: new Set(), cards: 0 };
  }
  a.cards++;
  if (year !== null) {
    if (a.firstYear === null || year < a.firstYear) {
      a.firstYear = year;
      a.firstSet = setName;
    }
    if (a.lastYear === null || year > a.lastYear) a.lastYear = year;
  }
  const slug = species.slugForCardName(card.name);
  if (slug) a.species.add(slug);
}

let nSets = 0;
nSets += walkLang(path.join(DATA, "tcgdex", "sets"), record);
nSets += walkLang(path.join(DATA, "tcgdex", "sets", "ja"), record);

const out = {
  _meta: {
    generated_at: new Date().toISOString(),
    artists: 0,
    sets: nSets
  },
  _legends: LEGENDS
};
Object.keys(artists).sort().forEach((name) => {
  const a = artists[name];
  out[name] = {
    firstSet: a.firstSet,
    firstYear: a.firstYear,
    lastYear: a.lastYear,
    species: a.species.size,
    cards: a.cards
  };
});
out._meta.artists = Object.keys(artists).length;

fs.writeFileSync(OUT, JSON.stringify(out) + "\n");
console.log("wrote", OUT, "-", out._meta.artists, "artists across", nSets, "sets",
  "(" + fs.statSync(OUT).size + " bytes)");
