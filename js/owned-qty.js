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

  /* Pure: [{ card_id, variant, quantity }] -> { cardId: { qty, variants } }.
   * Rows sharing a normalized variant label merge; the display label keeps
   * the first stored spelling seen. Exposed for unit tests. */
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
    });
    return map;
  }

  /* Pure: [{ label, qty }] -> "Holo ×2 · Reverse Holo ×1". Exposed for tests. */
  function breakdownText(variants) {
    return (variants || []).map(function (v) {
      return v.label + " ×" + v.qty;
    }).join(" · ");
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
    var rows = await fetchAllPages(function (from, to) {
      return App.sb
        .from("collection_items")
        .select("card_id,variant,quantity")
        .eq("user_id", uid)
        .range(from, to);
    });
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
    breakdownText: breakdownText
  };
})();
