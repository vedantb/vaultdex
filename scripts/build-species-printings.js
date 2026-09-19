/* VaultDex — build data/species-printings.json.
 *
 * Maps every catalog printing to its Pokémon species slug, powering the
 * Pokédex species modal's "Missing printings" section (printings the owner
 * doesn't own, shown greyscale).
 *
 * The mapping uses the REAL normalizer from js/species.js (loaded below
 * via a window shim) — never a reimplementation. Names that don't map to
 * a known species return null and are skipped (never guessed).
 *
 * RE-RUN THIS whenever the catalog changes (weekly TCGdex snapshot,
 * Japanese enrichment, M6a rebuild, image backfill):
 *   node scripts/build-species-printings.js
 *
 * Output format (kept lean on purpose — ~35k printings):
 *   { "_meta": { "generated_at": "...", "fields": [...] },
 *     "<slug>": [ [card_id, lang, name, set_name, image], ... ] }
 * Tuple order: 0 card_id (raw catalog id, e.g. "me02-001" / "M6a-001"),
 * 1 lang ("en" | "ja"), 2 card name, 3 set name, 4 image URL (may be null).
 * card_id matches collection rows' card_id in both languages, so the app
 * partitions owned vs missing by card_id. EN and JA printings are distinct
 * entries (a species can be missing in one language and owned in the other).
 * Zero PkmnPrices credits: everything here is local/static data.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");

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

function imageFor(card) {
  if (card.imageSmall) return card.imageSmall;
  if (card.imageLarge) return card.imageLarge;
  if (card.image) return card.image + "/low.png"; // same rule as normCard in js/tcg-api.js
  return null;
}

/* Walk one catalog language dir. appSetPrefix is "" for EN, "ja-" for JA. */
function walkLang(dir, lang) {
  const out = [];
  const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith(".json"); });
  files.forEach(function (f) {
    var snap;
    try {
      snap = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch (e) {
      console.warn("skip unreadable set file:", f, e && e.message);
      return;
    }
    var cards = (snap && snap.cards) || [];
    var setName = (snap.set && (snap.set.name || snap.set.id)) || f.replace(/\.json$/, "");
    cards.forEach(function (card) {
      if (!card || !card.id) return;
      var slug = species.slugForCardName(card.name);
      if (!slug) return; // unknown species — never guessed
      out.push({
        slug: slug,
        tuple: [
          String(card.id),
          lang,
          String(card.name || "?"),
          String(setName),
          imageFor(card)
        ]
      });
    });
  });
  return out;
}

function main() {
  var entries = []
    .concat(walkLang(path.join(DATA, "tcgdex", "sets"), "en"))
    .concat(walkLang(path.join(DATA, "tcgdex", "sets", "ja"), "ja"));

  var seen = new Set();
  var bySlug = {};
  var dupes = 0;
  entries.forEach(function (e) {
    var key = e.tuple[1] + "|" + e.tuple[0];
    if (seen.has(key)) { dupes++; return; }
    seen.add(key);
    (bySlug[e.slug] || (bySlug[e.slug] = [])).push(e.tuple);
  });

  Object.keys(bySlug).forEach(function (slug) {
    bySlug[slug].sort(function (a, b) {
      return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    });
  });

  var out = {
    _meta: {
      generated_at: new Date().toISOString(),
      fields: ["card_id", "lang", "name", "set_name", "image"],
      species: Object.keys(bySlug).length,
      printings: seen.size
    }
  };
  Object.keys(bySlug).sort().forEach(function (slug) { out[slug] = bySlug[slug]; });

  var dest = path.join(DATA, "species-printings.json");
  fs.writeFileSync(dest, JSON.stringify(out));
  var kb = Math.round(fs.statSync(dest).size / 1024);
  console.log("wrote " + dest + " (" + kb + " KB): " +
    out._meta.species + " species, " + out._meta.printings + " printings" +
    (dupes ? ", " + dupes + " dupes dropped" : ""));
}

main();
