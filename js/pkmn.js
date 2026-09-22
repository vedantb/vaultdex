/* VaultDex — PkmnPrices client (via the /api/pkmnprices serverless proxy).
 *
 * Pricing rules (per user decision 2026-09-14):
 *   - Always default to Near Mint condition prices.
 *   - Map each collection row to the exact PkmnPrices printing by
 *     set + card number — never by name alone. (Name-only matching once
 *     priced a 276/217 SIR as its 057/217 base printing.)
 *   - Prefer USD (TCGPlayer) rows; fall back to EUR, then any Near Mint row.
 */
(function () {
  window.App = window.App || {};

  var PROXY = "/api/pkmnprices";

  /* Same hard timeout as the catalog client: a stalled proxy request must
   * reject instead of hanging. The set page's pkmn_id backfill fans out one
   * lookup per unmapped row — with 100+ rows a single hung fetch used to
   * wedge checkbox painting for minutes. */
  var API_TIMEOUT_MS = 20000;
  /* Shared: App.util.fetchWithTimeout (js/util.js). */

  function PkmnError(message, opts) {
    this.name = "PkmnError";
    this.message = message;
    this.status = opts && opts.status;
    this.notConfigured = !!(opts && opts.notConfigured);
  }
  PkmnError.prototype = Object.create(Error.prototype);

  async function api(path, params) {
    var q = new URLSearchParams({ path: path });
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) q.set(k, String(params[k]));
    });
    var res = await App.util.fetchWithTimeout(PROXY + "?" + q.toString(), { headers: { "Accept": "application/json" } }, API_TIMEOUT_MS);
    var json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    if (res.status === 503) {
      throw new PkmnError(
        "PkmnPrices isn't connected yet — add your API key as PKMNPRICES_API_KEY in the Vercel project settings.",
        { status: 503, notConfigured: true }
      );
    }
    if (!res.ok) {
      throw new PkmnError(
        "PkmnPrices error (HTTP " + res.status + ")." + (json && json.error ? " " + json.error : ""),
        { status: res.status }
      );
    }
    return json;
  }

  /* "ME: Ascended Heroes" -> "ascended heroes"; "Ascended Heroes" -> same. */
  function normSetName(name) {
    var s = String(name || "");
    var cut = s.indexOf(": ");
    if (cut !== -1) s = s.slice(cut + 2);
    return s.trim().toLowerCase();
  }

  /* Japanese sets PkmnPrices doesn't carry at all (verified 2026-09-22:
   * M6a is absent from their full Japanese set list; MC and SM1p have no
   * PkmnPrices equivalent). For these, the number-only fallback would
   * silently match a DIFFERENT set's card with the same number — pricing
   * M6a Pikachu #017 as SV2D Clay Burst #017, for example. A missing price
   * is honest; a cross-set price is a lie. Keyed lang|normalized-set-name.
   * When the provider adds coverage, remove the entry and re-verify. */
  var PKMN_MISSING_SETS = {
    "ja|30th celebration": true,                    /* M6a */
    "ja|starter decks 100 battle collection": true, /* MC */
    "ja|sun and moon plus": true                    /* SM1p */
  };

  /* True when PkmnPrices has no cards for this set at all — the unsafe
   * number-only fallbacks in findCardId()/findVariantPrice() must be
   * skipped so these sets can never price from another set's printing. */
  function pkmnMissingSet(setName, lang) {
    return !!PKMN_MISSING_SETS[String(lang === "ja" ? "ja" : "en") + "|" + normSetName(setName)];
  }

  /* "(Poke Ball)" suffix of a PkmnPrices record name, e.g.
   * "Erika's Oddish (Poke Ball)" -> "Poke Ball". Null for base records. */
  function recordLabel(name) {
    var m = String(name || "").match(/\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : null;
  }

  /* Shared: App.util.normNumber (js/util.js) — "001" -> "1": TCGdex pads
   * numbers, PkmnPrices may not. Compare padded. */
  var normNumber = App.util.normNumber;

  var idCache = {};
  function cacheKey(name, setName, number, lang) {
    return (lang === "ja" ? "ja|" : "en|") + normSetName(setName) + "|" + normNumber(number) + "|" + String(name || "").trim().toLowerCase();
  }

  /* Find the exact PkmnPrices card id for a collection row.
   * opts.lang === "ja" scopes the search to Japanese printings. */
  async function findCardId(opts) {
    opts = opts || {};
    var key = cacheKey(opts.name, opts.setName, opts.number, opts.lang);
    if (idCache[key] !== undefined) return idCache[key];

    var params = {
      name: opts.name,
      number: opts.number,
      per_page: 50
    };
    if (opts.lang === "ja") params.language = "Japanese";
    var json = await api("/v1/cards", params);
    var wantSet = normSetName(opts.setName);
    var wantNum = normNumber(opts.number);
    var hit = null;
    (json.data || []).forEach(function (c) {
      if (hit) return;
      var setName = c.set && c.set.name;
      if (normSetName(setName) === wantSet && normNumber(c.number) === wantNum) hit = c;
    });
    // Fallback: name + number matched but set name didn't normalize cleanly
    // (e.g. promo sets) — take the first number-exact hit. Skipped for sets
    // PkmnPrices doesn't carry at all: there the exact match already failed
    // for good reason, and any number hit is necessarily another set's card.
    if (!hit && !pkmnMissingSet(opts.setName, opts.lang)) {
      (json.data || []).forEach(function (c) {
        if (hit) return;
        if (normNumber(c.number) === wantNum) hit = c;
      });
    }
    idCache[key] = hit ? hit.id : null;
    return idCache[key];
  }

  var VARIANT_ALIASES = {
    normal: ["normal"],
    holofoil: ["holofoil"],
    reverseHolofoil: ["reverse holofoil", "reverse holo"]
  };

  function variantMatches(row, wantKey) {
    var aliases = VARIANT_ALIASES[wantKey] || [];
    var v = String(row || "").toLowerCase();
    return aliases.some(function (a) { return v === a; });
  }

  /* Near Mint market price for a PkmnPrices card id. Always Near Mint first. */
  async function nearMintPrice(pkmnId, variantKey) {
    var card = await api("/v1/cards/" + encodeURIComponent(pkmnId));
    var rows = (card.prices || []).filter(function (p) {
      return p && p.condition === "Near Mint" && typeof p.market_price === "number";
    });
    if (!rows.length) return null;

    function pick(pool) {
      if (!pool.length) return null;
      var usd = pool.filter(function (p) { return p.currency === "USD"; });
      var eur = pool.filter(function (p) { return p.currency === "EUR"; });
      return (usd[0] || eur[0] || pool[0]);
    }

    var exact = rows.filter(function (p) { return variantMatches(p.variant, variantKey); });
    var row = pick(exact) || pick(rows);
    if (!row) return null;
    return {
      price: row.market_price,
      currency: row.currency,
      source: row.source,
      variant: row.variant,
      condition: row.condition
    };
  }

  /* Match one TCGdex print variant to its exact PkmnPrices record, then
   * price it Near Mint. pkmnLabel is the expected record-name parenthetical
   * ("poke ball"); priceVariant picks the finish ("reverseHolofoil") when the
   * base record covers several finishes. Returns
   * { pkmnId, price, currency, source, variant, condition } or null.
   * Costs a few credits per call (one search) — made only when the user
   * checks a box, never in bulk. */
  async function findVariantPrice(opts) {
    opts = opts || {};
    var params = {
      name: opts.name,
      number: opts.number,
      per_page: 50
    };
    if (opts.lang === "ja") params.language = "Japanese";
    var json = await api("/v1/cards", params);
    var wantSet = normSetName(opts.setName);
    var wantNum = normNumber(opts.number);
    var all = json.data || [];
    var cands = all.filter(function (c) {
      return normSetName(c.set && c.set.name) === wantSet && normNumber(c.number) === wantNum;
    });
    if (!cands.length && !pkmnMissingSet(opts.setName, opts.lang)) {
      /* Number-only fallback for promo sets whose names normalize oddly.
       * Never for unsupported sets: the exact match already failed for good
       * reason, and any hit here is another set's printing. */
      cands = all.filter(function (c) { return normNumber(c.number) === wantNum; });
    }
    if (!cands.length) return null;
    var nv = App.tcg.normVLabel;
    var want = nv(opts.pkmnLabel);
    var rec = null, i;
    if (want) {
      for (i = 0; i < cands.length; i++) {
        if (nv(recordLabel(cands[i].name)) === want) { rec = cands[i]; break; }
      }
    }
    if (!rec) {
      for (i = 0; i < cands.length; i++) {
        if (!recordLabel(cands[i].name)) { rec = cands[i]; break; }
      }
    }
    if (!rec) rec = cands[0];
    var p = await nearMintPrice(rec.id, opts.priceVariant || null);
    if (!p) return null;
    p.pkmnId = rec.id;
    return p;
  }

  /* Graded market price for a PkmnPrices card id — exact company + grade
   * match (e.g. PSA 10). Returns
   * { price, currency, source: "pkmnprices-graded", comps } or null.
   *
   * Verified live 2026-09-17 against /v1/cards/34126/listings/ebay:
   *   GET /v1/cards/{id}/listings/ebay?graded=true&grader=PSA&grade=10&limit=12
   * Rows are eBay SOLD comps (every row carries sold_at), snake_case:
   *   { id, title, price, currency ("USD" on eBay), grader, grade (string),
   *     grade_qualifier, variant, attribution ("exact"|"shared"|"unknown"),
   *     sold_at, ingested_at, listing_url }
   * Server-side graded/grader/grade filtering works; only attribution
   * "exact" rows feed the price, everything else is ignored. `limit` is
   * honored (per_page is not — it floors at 20 rows, so pass limit).
   * Price = median of the up to 10 most recent exact-attribution comps.
   * Cost: 1 credit per row returned — limit=12 keeps a graded lookup to
   * about a dozen credits.
   * Language scoping happens at id resolution: findCardId already passes
   * language=Japanese for ja rows, and the PkmnPrices id is per-printing,
   * so the listings call needs no extra lang handling.
   *
   * Never invents a price: no comps, no exact match, or any failure
   * returns null and callers fall back to the raw Near Mint price. */
  async function gradedPrice(pkmnId, company, grade, opts) {
    void opts;
    var gradeStr = String(grade == null ? "" : grade);
    var wantGrader = String(company || "").toUpperCase();
    if (!pkmnId || !wantGrader || !gradeStr) return null;
    var json;
    try {
      json = await api("/v1/cards/" + encodeURIComponent(pkmnId) + "/listings/ebay", {
        graded: true,
        grader: wantGrader, /* server-side filter is case-sensitive */
        grade: gradeStr,
        limit: 12
      });
    } catch (e) {
      console.warn("[VaultDex] graded listings lookup failed:", e && e.message);
      return null;
    }
    var rows = (json && json.data) || [];
    var comps = rows.filter(function (r) {
      return r && typeof r.price === "number" && r.price > 0 &&
        String(r.grader || "").toUpperCase() === wantGrader &&
        String(r.grade) === gradeStr;
    });
    var exact = comps.filter(function (r) { return r.attribution === "exact"; });
    var pool = exact.length ? exact : comps;
    if (!pool.length) return null;
    /* Most recent sales first; median of up to 10. */
    pool.sort(function (a, b) {
      var x = String(a.sold_at || a.ingested_at || "");
      var y = String(b.sold_at || b.ingested_at || "");
      return x < y ? 1 : (x > y ? -1 : 0);
    });
    var use = pool.slice(0, 10);
    var prices = use.map(function (r) { return r.price; }).sort(function (a, b) { return a - b; });
    var mid = Math.floor(prices.length / 2);
    var median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    /* Currency: most common among the comps used (USD on eBay). */
    var curCount = {};
    use.forEach(function (r) {
      var c = String(r.currency || "USD");
      curCount[c] = (curCount[c] || 0) + 1;
    });
    var currency = Object.keys(curCount).sort(function (a, b) { return curCount[b] - curCount[a]; })[0];
    return {
      price: Math.round(median * 100) / 100,
      currency: currency,
      source: "pkmnprices-graded",
      comps: use.length
    };
  }

  /* One-shot: map a collection row to its Near Mint price. Returns null when
   * the card can't be matched or has no Near Mint row.
   * Rows carrying a pkmn_id (per-variant checkboxes) price directly against
   * that exact PkmnPrices record — no set+number search needed.
   * Japanese rows (set_id prefixed "ja-") search Japanese printings only —
   * English prices are never substituted for Japanese cards. */
  async function priceForRow(row) {
    var lang = row.lang || App.util.langOf(row);
    /* Unsupported sets (M6a/MC/SM1p): the provider carries no cards for
     * them, so a stored pkmn_id here could only be cross-set residue from
     * the removed number-only fallback — never price off it. Return null so
     * the refresh loop leaves these rows untouched (unpriced is honest). */
    if (pkmnMissingSet(row.set_name, lang)) return null;
    if (row.pkmn_id) return nearMintPrice(row.pkmn_id, row.variant);
    var number = row.number || guessNumber(row.card_id);
    if (!row.card_name || !number) return null;
    var id = await findCardId({ name: row.card_name, setName: row.set_name, number: number, lang: lang });
    if (!id) return null;
    return nearMintPrice(id, row.variant);
  }

  /* TCGdex ids look like "me02.5-276": number follows the last dash. */
  function guessNumber(cardId) {
    var m = String(cardId || "").match(/-([A-Za-z0-9]+)$/);
    return m ? m[1] : null;
  }

  App.pkmn = {
    api: api,
    findCardId: findCardId,
    findVariantPrice: findVariantPrice,
    nearMintPrice: nearMintPrice,
    gradedPrice: gradedPrice,
    priceForRow: priceForRow,
    normSetName: normSetName,
    pkmnMissingSet: pkmnMissingSet,
    PkmnError: PkmnError
  };
})();
