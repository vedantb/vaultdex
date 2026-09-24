/* VaultDex — owned-copy counts: session-cached per-card quantity index.
 *
 * Exposes cardId -> { qty, variants: [{ label, qty }] } for the signed-in
 * owner's rows, or the owner's public rows when signed out (the collection
 * is a public showcase; same RLS policy as collection listPublic).
 * Powers the owned-count badges on set/browse tiles and the "In your
 * collection" line in the card modal. Zero PkmnPrices credits — plain
 * Supabase, one paginated select of (card_id, variant, quantity), cached
 * for the session and invalidated on "collection:changed". */
(function () {
  window.App = window.App || {};

  var cache = null;    // { cardId: { qty, variants } } once loaded
  var inFlight = null; // shared promise while the first query is running
  var subbed = false;

  /* Pretty-print a stored variant value for the breakdown line. Stored
   * labels are usually print names ("Holo", "Reverse Holo", "Cosmos Holo");
   * rows added before print data resolve to TCGdex variant keys. */
  function prettyVariant(label) {
    var k = String(label || "");
    var labels = App.util && App.util.VARIANT_LABELS;
    if (labels && labels[k]) return labels[k];
    return k || "Normal";
  }

  function normLabel(v) {
    if (App.tcg && App.tcg.normVLabel) return App.tcg.normVLabel(v);
    return String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  /* Pure: [{ card_id, variant, quantity, market_price, price_currency,
   * price_source, price_updated_at }] -> { cardId: { qty, variants } }.
   * Rows sharing a normalized variant label merge; the display label keeps
   * the first stored spelling seen. Per-variant collection value is
   * accumulated (market_price × qty) so the card dialog can show the same
   * number as the tile that opened it. Exposed for unit tests. */
  function buildIndex(rows) {
    var map = {};
    (rows || []).forEach(function (r) {
      var id = String(r.card_id || "");
      if (!id) return;
      var q = Math.max(0, parseInt(r.quantity, 10) || 0);
      if (!q) return;
      var entry = map[id] || (map[id] = { qty: 0, variants: [] });
      entry.qty += q;
      var norm = normLabel(r.variant);
      var v = null;
      for (var i = 0; i < entry.variants.length; i++) {
        if (entry.variants[i].norm === norm) { v = entry.variants[i]; break; }
      }
      if (!v) {
        v = { norm: norm, label: prettyVariant(r.variant), qty: 0 };
        entry.variants.push(v);
      }
      v.qty += q;
      var mp = Number(r.market_price);
      if (r.market_price !== null && r.market_price !== undefined && !isNaN(mp)) {
        if (v.value === undefined) { v.value = 0; v.currency = r.price_currency || "USD"; }
        v.value += mp * q;
      }
      if (r.price_source && !v.priceSource) v.priceSource = r.price_source;
      var pu = r.price_updated_at ? Date.parse(r.price_updated_at) : 0;
      if (pu && (!v.priceUpdatedAt || pu > Date.parse(v.priceUpdatedAt))) {
        v.priceUpdatedAt = r.price_updated_at;
      }
    });
    return map;
  }

  /* Local USD/EUR formatter so breakdownText stays pure and unit-testable
   * without App.ui. Mirrors App.ui.money's symbols. */
  function fmtMoney(n, currency) {
    var sym = currency === "EUR" ? "€" : "$";
    return sym + Number(n).toFixed(2);
  }

  /* Pure: [{ label, qty, value, currency }] -> "Holo ×2 · $25.00".
   * Variants with no priced rows keep the old "Holo ×1" rendering.
   * Exposed for tests. */
  function breakdownText(variants) {
    return (variants || []).map(function (v) {
      var t = v.label + " ×" + v.qty;
      if (typeof v.value === "number") t += " · " + fmtMoney(v.value, v.currency);
      return t;
    }).join(" · ");
  }

  /* Pure: group priced variants by currency -> [{ currency, value }].
   * Exposed for tests. */
  function valueByCurrency(variants) {
    var map = {};
    (variants || []).forEach(function (v) {
      if (typeof v.value !== "number") return;
      var c = v.currency || "USD";
      map[c] = (map[c] || 0) + v.value;
    });
    return Object.keys(map).map(function (c) {
      return { currency: c, value: Math.round(map[c] * 100) / 100 };
    });
  }

  /* Pure: "Collection value: $45.50", "$40.00 · €12.00" across currencies,
   * or "" when no variant carries a price. Exposed for tests. */
  function collectionValueText(variants) {
    var parts = valueByCurrency(variants).map(function (t) {
      return fmtMoney(t.value, t.currency);
    });
    return parts.length ? parts.join(" · ") : "";
  }

  /* Pure local time-ago (mirrors App.ui.timeAgo) for the source note. */
  function timeAgo(ts, nowMs) {
    var s = Math.floor((nowMs - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  /* Pure: muted source line for the modal's owned section, e.g.
   * "PkmnPrices · Near Mint · refreshed 2d ago", or "eBay sold listings"
   * when any priced row came from graded comps. "" when nothing is priced.
   * Exposed for tests. */
  function priceSourceNote(variants, nowMs) {
    var priced = (variants || []).filter(function (v) { return typeof v.value === "number"; });
    if (!priced.length) return "";
    var graded = priced.some(function (v) { return v.priceSource === "pkmnprices-graded"; });
    var note = graded ? "eBay sold listings" : "PkmnPrices · Near Mint";
    var latest = 0;
    priced.forEach(function (v) {
      var t = v.priceUpdatedAt ? Date.parse(v.priceUpdatedAt) : 0;
      if (t > latest) latest = t;
    });
    if (latest) note += " · refreshed " + timeAgo(latest, nowMs == null ? Date.now() : nowMs);
    return note;
  }

  /* Paginated fetch: PostgREST caps a single response at 1000 rows. */
  async function fetchAllPages(queryBuilder) {
    var out = [];
    var pageSize = 1000;
    var from = 0;
    for (;;) {
      var res = await queryBuilder(from, from + pageSize - 1);
      if (res.error) throw res.error;
      var rows = res.data || [];
      out = out.concat(rows);
      if (rows.length < pageSize) break;
      from += pageSize;
    }
    return out;
  }

  async function load() {
    var u = App.auth && App.auth.user;
    var uid;
    if (u) {
      uid = u.id;
    } else {
      // Signed out: the owner's rows are public (same RLS as listPublic).
      var ownerId = (window.APP_CONFIG && window.APP_CONFIG.OWNER_USER_ID) || "";
      if (!ownerId || ownerId.indexOf("00000000") === 0) return {};
      uid = ownerId;
    }
    /* price_currency may not exist yet (pre-migration schema): fall back
     * to the legacy select rather than failing the whole index. */
    var fullSelect = "card_id,variant,quantity,market_price,price_currency,price_source,price_updated_at";
    var legacySelect = "card_id,variant,quantity,market_price,price_source,price_updated_at";
    var rows;
    try {
      rows = await fetchAllPages(function (from, to) {
        return App.sb
          .from("collection_items")
          .select(fullSelect)
          .eq("user_id", uid)
          .range(from, to);
      });
    } catch {
      rows = await fetchAllPages(function (from, to) {
        return App.sb
          .from("collection_items")
          .select(legacySelect)
          .eq("user_id", uid)
          .range(from, to);
      });
    }
    return buildIndex(rows);
  }

  /* Subscribe lazily (inside getIndex) rather than at script load:
   * deferred scripts execute in document order and this module may run
   * before app.js defines App.on. */
  function ensureSub() {
    if (subbed || typeof App.on !== "function") return;
    subbed = true;
    App.on("collection:changed", function () { cache = null; });
  }

  function getIndex() {
    ensureSub();
    if (cache) return Promise.resolve(cache);
    if (!inFlight) {
      inFlight = load().then(
        function (m) { cache = m; inFlight = null; return m; },
        function (e) { inFlight = null; throw e; }
      );
    }
    return inFlight;
  }

  function getCard(cardId) {
    return getIndex().then(function (map) {
      return map[String(cardId)] || null;
    });
  }

  function invalidate() { cache = null; }

  App.ownedQty = {
    getIndex: getIndex,
    getCard: getCard,
    invalidate: invalidate,
    buildIndex: buildIndex,
    breakdownText: breakdownText,
    valueByCurrency: valueByCurrency,
    collectionValueText: collectionValueText,
    priceSourceNote: priceSourceNote
  };
})();
