/* VaultDex — set completion tracking (Feature 1): shared owner-collection
 * index by set. X counts DISTINCT card_ids per set (one per card no matter
 * how many variants of it are owned); Y is the set's total card count
 * (including secret rares) — the same denominator the set page uses.
 *
 * Collection rows store set_id in appId style ("ja-M4" for Japanese sets,
 * the raw TCGdex id for English — see rowFromCard in js/collection.js), so
 * tile appIds match map keys directly. Matching is by set_id only, which is
 * why English print data can never bleed into a Japanese set's count.
 *
 * One paginated query selecting only (card_id, set_id) for the owner;
 * cached for the session; invalidated on "collection:changed" and via
 * App.setProgress.invalidate(). Zero PkmnPrices credits — plain Supabase. */
(function () {
  window.App = window.App || {};

  var cache = null;    // { appId: Set(cardId) } once loaded
  var inFlight = null; // shared promise while the first query is running
  var subbed = false;

  /* Paginated fetch: PostgREST caps a single response at 1000 rows, so
   * large collections must be pulled in pages. (Same pattern as
   * fetchAllPages in js/collection.js.) */
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
    if (!u) return {}; // signed out: nothing owned
    var rows = await fetchAllPages(function (from, to) {
      return App.sb
        .from("collection_items")
        .select("card_id,set_id")
        .eq("user_id", u.id)
        .range(from, to);
    });
    var map = {};
    rows.forEach(function (r) {
      if (!r.set_id) return; // legacy rows without a set id can't be matched
      var key = String(r.set_id); // stored appId-style already ("ja-M4")
      var set = map[key] || (map[key] = new Set());
      if (r.card_id) set.add(String(r.card_id));
    });
    return map;
  }

  /* Subscribe lazily (inside getOwnedBySet) rather than at script load:
   * deferred scripts execute in document order and this module may run
   * before app.js defines App.on. */
  function ensureSub() {
    if (subbed || typeof App.on !== "function") return;
    subbed = true;
    App.on("collection:changed", function () { cache = null; });
  }

  function getOwnedBySet() {
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

  function invalidate() { cache = null; }

  App.setProgress = {
    getOwnedBySet: getOwnedBySet,
    invalidate: invalidate
  };
})();
