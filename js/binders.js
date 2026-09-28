/* VaultDex — physical binder tracking (data layer).
 *
 * binders: one row per physical binder (owner-scoped, custom names).
 * collection_items.binder_id (nullable FK, ON DELETE SET NULL):
 *   - set   → the row lives in that binder
 *   - null  → unshelved ("No binder")
 *
 * Rows fetched before the migration is applied won't carry the column —
 * treat a missing column as null so everything still renders.
 * Zero PkmnPrices calls: binder work touches names/positions only.
 */
(function () {
  window.App = window.App || {};

  var cache = null;
  var cacheUser = null;

  function needUser() {
    return (App.auth && App.auth.user) || null;
  }

  function invalidate() {
    cache = null;
    cacheUser = null;
  }

  /* Friendly error when the migration hasn't been applied yet. */
  function friendlyError(err) {
    var msg = (err && err.message) || "";
    if (err && (err.code === "42P01" || err.code === "42703" || msg.indexOf("binders") !== -1 || msg.indexOf("binder_id") !== -1)) {
      return new Error("Binders aren't set up yet — run supabase/migration-binders.sql in the Supabase dashboard, then try again.");
    }
    return err instanceof Error ? err : new Error(msg || "Binder update failed.");
  }

  /* Owner's binders, ordered by position then name. Cached per user. */
  async function list(force) {
    var u = needUser();
    if (!u) return [];
    if (cache && !force && cacheUser === u.id) return cache;
    var res = await App.sb
      .from("binders")
      .select("*")
      .eq("user_id", u.id)
      .order("position", { ascending: true })
      .order("name", { ascending: true });
    if (res.error) {
      /* Table missing (migration not applied): behave as "no binders". */
      if (res.error.code === "42P01") { cache = []; cacheUser = u.id; return cache; }
      throw friendlyError(res.error);
    }
    cache = res.data || [];
    cacheUser = u.id;
    return cache;
  }

  function byId(id) {
    if (!id || !cache) return null;
    for (var i = 0; i < cache.length; i++) if (cache[i].id === id) return cache[i];
    return null;
  }

  function binderName(row) {
    if (!row || !row.binder_id) return null;
    var b = byId(row.binder_id);
    return b ? b.name : null;
  }

  async function create(name) {
    var u = needUser();
    if (!u) throw new Error("Sign in first.");
    name = (name || "").trim();
    if (!name) throw new Error("Give the binder a name.");
    if (name.length > 60) throw new Error("Keep binder names under 60 characters.");
    var existing = await list();
    var pos = 0;
    existing.forEach(function (b) { pos = Math.max(pos, (b.position || 0) + 1); });
    var res = await App.sb
      .from("binders")
      .insert({ user_id: u.id, name: name, position: pos })
      .select()
      .single();
    if (res.error) throw friendlyError(res.error);
    invalidate();
    return res.data;
  }

  async function rename(id, name) {
    if (!App.auth.isOwner()) throw new Error("Only the owner can manage binders.");
    name = (name || "").trim();
    if (!name) throw new Error("Give the binder a name.");
    if (name.length > 60) throw new Error("Keep binder names under 60 characters.");
    var res = await App.sb.from("binders").update({ name: name }).eq("id", id);
    if (res.error) throw friendlyError(res.error);
    invalidate();
  }

  /* Deleting a binder unassigns its cards (FK is ON DELETE SET NULL) —
   * no collection rows are ever deleted by this. */
  async function remove(id) {
    if (!App.auth.isOwner()) throw new Error("Only the owner can manage binders.");
    var res = await App.sb.from("binders").delete().eq("id", id);
    if (res.error) throw friendlyError(res.error);
    invalidate();
    App.emit("collection:changed", { binder: true });
  }

  /* Persist a position order: ids is the binder id array in display order. */
  async function reorder(ids) {
    if (!App.auth.isOwner()) throw new Error("Only the owner can manage binders.");
    ids = ids || [];
    for (var i = 0; i < ids.length; i++) {
      var res = await App.sb.from("binders").update({ position: i }).eq("id", ids[i]);
      if (res.error) throw friendlyError(res.error);
    }
    invalidate();
  }

  /* Owner-only: assign a collection row to a binder (null = unshelved).
   * Never touches prices, quantities, or any other column. */
  async function setBinder(rowId, binderId) {
    if (!App.auth.isOwner()) throw new Error("Only the owner can assign binders.");
    var up = await App.sb
      .from("collection_items")
      .update({ binder_id: binderId || null })
      .eq("id", rowId);
    if (up.error) throw friendlyError(up.error);
    App.emit("collection:changed", { binder: true });
  }

  /* ---------------- rarity ranking (binder sort) ----------------
   * Common → rarest. Unknown/blank rarities group at the end so they
   * never scatter through the binder. Pure + unit-tested. */
  var RARITY_ORDER = [
    "common",
    "uncommon",
    "rare",
    "rare holo",
    "double rare",
    "illustration rare",
    "ultra rare",
    "amazing rare",
    "radiant rare",
    "shiny rare",
    "shiny ultra rare",
    "special illustration rare",
    "ace spec rare",
    "hyper rare",
    "rare secret",
    "rare rainbow",
    "rare break",
    "legend",
    "prime",
    "promo"
  ];

  function rarityRank(rarity) {
    var key = (rarity || "").toString().trim().toLowerCase();
    var idx = RARITY_ORDER.indexOf(key);
    return idx === -1 ? RARITY_ORDER.length : idx;
  }

  /* Rarest-first comparator for collection rows. Ties break by set, then
   * name, so the order is stable and browsable. */
  function rarityComparator(a, b) {
    var d = rarityRank(b.rarity) - rarityRank(a.rarity);
    if (d) return d;
    var sa = (a.set_name || "") + (a.card_name || "");
    var sb = (b.set_name || "") + (b.card_name || "");
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  function sortByRarity(rows) {
    return (rows || []).slice().sort(rarityComparator);
  }

  App.binders = {
    list: list,
    byId: byId,
    binderName: binderName,
    create: create,
    rename: rename,
    remove: remove,
    reorder: reorder,
    setBinder: setBinder,
    invalidate: invalidate,
    RARITY_ORDER: RARITY_ORDER,
    rarityRank: rarityRank,
    rarityComparator: rarityComparator,
    sortByRarity: sortByRarity
  };
})();
