/* VaultDex — Pokémon species mapping + TCG card-name normalization.
 *
 * data/pokemon-species.json maps PokéAPI species slugs to National Dex
 * numbers (all 1025, fetched once from https://pokeapi.co/api/v2/pokemon).
 * slugForCardName() maps a TCG card name to a species slug so the Pokédex
 * and species-based badges can be computed from collection rows alone.
 *
 * Unmatched names return null ("unknown species") — the function never
 * guesses. A slug only counts when it exists in the loaded mapping.
 * Zero PkmnPrices credits: everything here is pure/local. */
(function () {
  window.App = window.App || {};

  var mapping = null; // { order: [...], dex: {slug: n} }

  /* Full-name special cases, keyed by lowercased stripped name. */
  var SPECIAL = {
    "spiky-eared pichu": "pichu",
    "pikachu with grey felt hat": "pikachu",
    "surfing pikachu": "pikachu",
    "flying pikachu": "pikachu",
    "detective pikachu": "pikachu",
    "teal mask ogerpon": "ogerpon",
    "wellspring mask ogerpon": "ogerpon-wellspring-mask",
    "hearthflame mask ogerpon": "ogerpon-hearthflame-mask",
    "cornerstone mask ogerpon": "ogerpon-cornerstone-mask",
    "bloodmoon ursaluna": "ursaluna-bloodmoon",
    "heat rotom": "rotom",
    "wash rotom": "rotom",
    "frost rotom": "rotom",
    "fan rotom": "rotom",
    "mow rotom": "rotom",
    "wormadam plant cloak": "wormadam",
    "wormadam sandy cloak": "wormadam",
    "wormadam trash cloak": "wormadam",
    "shaymin land forme": "shaymin",
    "shaymin sky forme": "shaymin-sky",
    "white-striped basculin": "basculin-white-striped",
    "ice rider calyrex": "calyrex-ice",
    "shadow rider calyrex": "calyrex-shadow",
    "dusk mane necrozma": "necrozma-dusk",
    "dawn wings necrozma": "necrozma-dawn",
    "black kyurem": "kyurem-black",
    "white kyurem": "kyurem-white",
    "school form wishiwashi": "wishiwashi"
  };

  /* Trailing TCG mechanic suffixes, stripped repeatedly until stable. */
  var SUFFIXES = [" v-union", " vmax", " vstar", " lv.x", " lv x", " ex", " gx", " v", " break", " δ", " ◇", " ☆"];
  /* Leading flavor prefixes ("Dark Charizard", "Rocket's Zapdos"). */
  var PREFIXES = ["dark ", "light ", "shining ", "rocket's "];

  /* Regional prefix -> PokéAPI form slug suffix. */
  var REGIONS = { alolan: "alola", galarian: "galar", hisuian: "hisui", paldean: "paldea" };

  function slugForCardName(name) {
    var s = String(name || "").toLowerCase().trim();
    if (!s) return null;
    s = s.replace(/♀/g, "-f").replace(/♂/g, "-m");
    try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch { /* no normalize */ }
    // Regional forms: "Alolan Raichu" -> raichu-alola.
    var region = null;
    var m = s.match(/^(alolan|galarian|hisuian|paldean)\s+(.*)$/);
    if (m) { region = REGIONS[m[1]]; s = m[2]; }
    // Strip TCG suffixes repeatedly ("Mewtwo ex", "Pikachu VMAX", "Dialga LV.X").
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < SUFFIXES.length; i++) {
        if (s.length > SUFFIXES[i].length && s.slice(-SUFFIXES[i].length) === SUFFIXES[i]) {
          s = s.slice(0, -SUFFIXES[i].length).trim();
          changed = true;
        }
      }
    }
    // Strip flavor prefixes ("Dark Charizard", "Rocket's Zapdos").
    for (var p = 0; p < PREFIXES.length; p++) {
      if (s.indexOf(PREFIXES[p]) === 0) { s = s.slice(PREFIXES[p].length); break; }
    }
    // Full-name special cases, checked after mechanic/flavor cleanup so
    // "Wellspring Mask Ogerpon ex" still resolves.
    var probe = s.replace(/[.:']/g, "").replace(/\s+/g, " ").trim();
    if (SPECIAL[probe]) return check(SPECIAL[probe]);
    // Unown lettered forms collapse to unown ("Unown A", "Unown [R]").
    var un = s.replace(/\[|\]/g, "").trim();
    if (/^unown(\s+[a-z?!])?$/.test(un)) return check("unown");
    // Punctuation -> spaces, then hyphenate.
    s = s.replace(/[.:']/g, "").replace(/[^a-z0-9-]+/g, " ").trim().replace(/\s+/g, "-");
    if (!s) return null;
    if (region) s = s + "-" + region;
    return check(s);
  }

  /* A slug only counts when the mapping knows it — never guessed. */
  function check(slug) {
    if (!mapping || !mapping.dex) return null;
    return mapping.dex[slug] ? slug : null;
  }

  function dexNumber(slug) {
    if (!mapping || !mapping.dex) return null;
    return mapping.dex[slug] || null;
  }

  var DISPLAY_SPECIAL = {
    "mr-mime": "Mr. Mime", "mr-rime": "Mr. Rime",
    "farfetchd": "Farfetch'd", "sirfetchd": "Sirfetch'd",
    "ho-oh": "Ho-Oh", "porygon-z": "Porygon-Z",
    "mime-jr": "Mime Jr.", "type-null": "Type: Null",
    "nidoran-f": "Nidoran♀", "nidoran-m": "Nidoran♂",
    "flabebe": "Flabébé", "jangmo-o": "Jangmo-o",
    "hakamo-o": "Hakamo-o", "kommo-o": "Kommo-o"
  };
  var REGION_LABEL = { alola: "Alolan", galar: "Galarian", hisui: "Hisuian", paldea: "Paldean" };

  function displayName(slug) {
    slug = String(slug || "");
    if (DISPLAY_SPECIAL[slug]) return DISPLAY_SPECIAL[slug];
    var parts = slug.split("-");
    var last = parts[parts.length - 1];
    var suffix = "";
    if (REGION_LABEL[last]) { suffix = " "; parts.pop(); }
    else if (last === "f" || last === "m") { suffix = last === "f" ? " ♀" : " ♂"; parts.pop(); }
    var base = parts.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
    if (REGION_LABEL[last]) return REGION_LABEL[last] + " " + base;
    return base + suffix;
  }

  /* Group owned rows by species slug: { slug: { copies, cards: [rows] } }.
   * Rows whose names don't map to a known species are skipped (never
   * guessed) — the caller decides what to do with the remainder. */
  function groupRowsBySpecies(rows) {
    var out = {};
    (rows || []).forEach(function (r) {
      var slug = slugForCardName(r.card_name);
      if (!slug) return;
      var g = out[slug] || (out[slug] = { copies: 0, cards: [] });
      g.copies += Number(r.quantity) || 1;
      g.cards.push(r);
    });
    return out;
  }

  async function loadMapping() {
    if (mapping) return mapping;
    try {
      var res = await fetch("/data/pokemon-species.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      mapping = await res.json();
    } catch (e) {
      mapping = { order: [], dex: {} };
      if (typeof console !== "undefined") console.warn("[VaultDex] species mapping failed to load:", e && e.message);
    }
    return mapping;
  }

  /* Test seam: inject a mapping without fetching. */
  function setMapping(m) { mapping = m; }

  /* Official Pokémon artwork URL (PokeAPI sprites repo) for a National Dex
   * number — used greyscaled for uncaptured species ("Who's that Pokémon?"). */
  function artworkUrl(dexNum) {
    var n = parseInt(dexNum, 10);
    if (!n || n < 1) return null;
    return "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/" + n + ".png";
  }

  /* Grid filter: which species are visible under each filter mode. */
  function visibleInMode(captured, mode) {
    if (mode === "caught") return !!captured;
    if (mode === "missing") return !captured;
    return true; // "all" (or anything unexpected) shows everything
  }

  /* Partition catalog printings (species-printings.json tuples:
   * [card_id, lang, name, set_name, image]) into owned vs missing by
   * card_id. card_id matches collection rows' card_id in both languages;
   * EN and JA printings are distinct entries. Never invents ownership:
   * a printing is "owned" only when its exact card_id is in ownedCardIds. */
  function missingPrintings(printings, ownedCardIds) {
    var owned = {};
    (ownedCardIds || []).forEach(function (id) { owned[String(id)] = true; });
    return (printings || []).filter(function (p) {
      return !owned[String(p[0])];
    });
  }

  App.species = {
    loadMapping: loadMapping,
    setMapping: setMapping,
    slugForCardName: slugForCardName,
    dexNumber: dexNumber,
    displayName: displayName,
    groupRowsBySpecies: groupRowsBySpecies,
    artworkUrl: artworkUrl,
    visibleInMode: visibleInMode,
    missingPrintings: missingPrintings
  };
})();
