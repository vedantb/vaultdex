/* VaultDex — "Did you know?" fun facts for Card of the Day.
 *
 * Two honest fact sources, never fabricated:
 *  1. Lore: Pokédex flavor text from the free PokéAPI (no key). The daily
 *     card's name is mapped to a species slug with the real js/species.js
 *     normalizer; English flavor entries are picked deterministically by
 *     date (same date -> same fact for every visitor) and cached in
 *     localStorage once per species. On any failure the fact is silently
 *     skipped — it never blocks the card render and never shows an error.
 *  2. Artist: computed from data/artist-stats.json (built by
 *     scripts/build-artist-stats.js from the local catalog). Hand-verified
 *     "legend" facts baked into that file take precedence; otherwise a
 *     computed template is picked deterministically by date.
 *
 * Pure helpers (cleanFlavor, pickDailyText, artistFact) are unit-tested in
 * tests/fun-facts.test.js. The async loreFact / artistFactForCard helpers
 * are used by js/views/games-view.js. Zero PkmnPrices credits. */
(function () {
  window.App = window.App || {};
  var F = (App.funFacts = App.funFacts || {});

  var POKEAPI = "https://pokeapi.co/api/v2/pokemon-species/";
  var STATS_URL = "/data/artist-stats.json";

  function hash(s) {
    if (window.App.games && window.App.games.hashStr) return window.App.games.hashStr(s);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* Collapse PokéAPI's newlines/form-feeds into clean single-spaced text. */
  function cleanFlavor(t) {
    return String(t || "").replace(/[\n\r\f\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  }

  /* Deterministic pick from a list of strings for a YYYY-MM-DD date. */
  function pickDailyText(texts, dateStr) {
    if (!texts || !texts.length) return null;
    return texts[hash("vaultdex-fact:" + dateStr) % texts.length];
  }

  function flavorCacheKey(slug) { return "vaultdex:flavor:" + slug; }

  var memFlavor = {};   // slug -> [texts] (in-memory)
  var memStats = null;  // parsed artist-stats.json (in-memory)

  /* English flavor texts for a species slug. Cached in localStorage once
   * per species, forever. Never throws; [] on any failure. */
  async function englishFlavorTexts(slug) {
    if (!slug) return [];
    if (memFlavor[slug]) return memFlavor[slug];
    var texts = [];
    try {
      var raw = null;
      try { raw = localStorage.getItem(flavorCacheKey(slug)); } catch { /* private mode */ }
      if (raw) texts = JSON.parse(raw) || [];
    } catch { texts = []; }
    if (!texts.length) {
      try {
        var res = await fetch(POKEAPI + encodeURIComponent(slug));
        if (!res.ok) throw new Error("HTTP " + res.status);
        var data = await res.json();
        var seen = {};
        (data.flavor_text_entries || []).forEach(function (e) {
          if (e && e.language && e.language.name === "en" && e.flavor_text) {
            var t = cleanFlavor(e.flavor_text);
            if (t && !seen[t]) { seen[t] = true; texts.push(t); }
          }
        });
        try { localStorage.setItem(flavorCacheKey(slug), JSON.stringify(texts.slice(0, 40))); } catch { /* private mode */ }
      } catch { texts = []; }
    }
    memFlavor[slug] = texts;
    return texts;
  }

  /* Lore fact for a card name + date. Resolves to a string or null.
   * The species mapping must be loadable; unknown names -> null (never
   * guessed). */
  async function loreFact(cardName, dateStr) {
    try {
      if (window.App.species && window.App.species.loadMapping) {
        await window.App.species.loadMapping();
      }
    } catch { /* mapping failed: no fact */ }
    var slug = null;
    try { slug = window.App.species ? window.App.species.slugForCardName(cardName) : null; } catch { /* keep null */ }
    if (!slug) return null;
    var texts = await englishFlavorTexts(slug);
    return pickDailyText(texts, dateStr);
  }

  /* Parsed artist-stats.json, fetched once. Never throws; {} on failure. */
  async function loadArtistStats() {
    if (memStats) return memStats;
    try {
      var res = await fetch(STATS_URL);
      if (!res.ok) throw new Error("HTTP " + res.status);
      memStats = await res.json();
    } catch { memStats = {}; }
    return memStats;
  }

  /* Case-insensitive artist lookup in the stats table. */
  function findArtist(stats, name) {
    if (!stats || !name) return null;
    var want = String(name).trim().toLowerCase();
    if (!want) return null;
    var keys = Object.keys(stats);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.charAt(0) === "_") continue;
      if (k.toLowerCase() === want) return { name: k, s: stats[k] };
    }
    return null;
  }

  /* Deterministic artist fact. A hand-verified legend fact takes
   * precedence when the artist matches; otherwise a computed template is
   * picked by date. Returns null when nothing is known. */
  function artistFact(artistName, stats, dateStr) {
    var found = findArtist(stats, artistName);
    var name = found ? found.name : String(artistName || "").trim();
    if (!name) return null;
    var legends = (stats && stats._legends) || {};
    var lk = Object.keys(legends);
    for (var i = 0; i < lk.length; i++) {
      if (lk[i].toLowerCase() === name.toLowerCase()) return legends[lk[i]];
    }
    var s = found && found.s;
    if (!s) return null;
    var templates = [];
    if (s.firstSet && s.firstYear) {
      templates.push(name + " has been illustrating Pokémon cards since " + s.firstSet + " (" + s.firstYear + ").");
    }
    if (s.species) {
      templates.push(name + " has illustrated " + s.species + " different Pokémon.");
    }
    if (s.firstYear && s.lastYear && s.lastYear > s.firstYear) {
      templates.push(name + "'s TCG illustrations span " + (s.lastYear - s.firstYear + 1) +
        " years, " + s.firstYear + "–" + s.lastYear + ".");
    }
    if (!templates.length) return null;
    return pickDailyText(templates, "artist:" + dateStr);
  }

  /* Artist fact for a collection row's artist field. Resolves to a string
   * or null. */
  async function artistFactForCard(artistName, dateStr) {
    if (!artistName) return null;
    var stats = await loadArtistStats();
    return artistFact(artistName, stats, dateStr);
  }

  F.cleanFlavor = cleanFlavor;
  F.pickDailyText = pickDailyText;
  F.englishFlavorTexts = englishFlavorTexts;
  F.loreFact = loreFact;
  F.loadArtistStats = loadArtistStats;
  F.findArtist = findArtist;
  F.artistFact = artistFact;
  F.artistFactForCard = artistFactForCard;
})();
