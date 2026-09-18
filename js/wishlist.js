/* VaultDex — wishlist data layer (Supabase: public.wishlist, Feature 2).
 * The wishlist is private to the owner: no public/anon read policy, every
 * read and write is gated behind an active session via App.collection.needUser().
 *
 * One row per card (unique on user_id + card_id); re-adding updates the
 * stored snapshot/variant. PkmnPrices is touched only as a best-effort
 * price at add-time (may resolve to null — never blocks the save).
 */
(function () {
  window.App = window.App || {};

  /* Owner gate. needUser() shows the sign-in prompt when signed out and
   * returns the user (with .id) when signed in. */
  function needUser() {
    return App.collection.needUser();
  }

  function sb() {
    return App.sb;
  }

  /* Snapshot of a card for wishlist storage. Japanese cards keep their ja-
   * appId-style set ids (e.g. "ja-M4") so pricing can always tell Japanese
   * printings apart — never price them from English results. */
  function snapshot(u, card, variant) {
    return {
      user_id: u.id,
      card_id: card.id,
      card_name: card.name || null,
      set_id: (card.set && card.set.id) || null,
      set_name: (card.set && card.set.name) || null,
      number: card.number || null,
      variant: variant || null,
      image_small: (card.images && card.images.small) || null,
      market_price: null,
      price_currency: "USD"
    };
  }

  /* Best-effort Near Mint price for the snapshot (1 credit). Resolves to
   * null on any failure — the save must never block on pricing. */
  async function addTimePrice(card, row) {
    try {
      var p = await App.pkmn.priceForRow({
        card_id: card.id,
        card_name: card.name,
        set_id: row.set_id,
        set_name: row.set_name,
        number: row.number,
        variant: row.variant
      });
      if (p && typeof p.price === "number") {
        row.market_price = p.price;
        row.price_currency = p.currency || "USD";
      }
    } catch (e) {
      console.warn("[VaultDex] wishlist add-time pricing failed:", e && e.message);
    }
    return row;
  }

  async function list() {
    var u = needUser();
    if (!u || !sb()) return [];
    var res = await sb().from("wishlist").select("*")
      .eq("user_id", u.id)
      .order("added_at", { ascending: false });
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function isWished(cardId) {
    var u = needUser();
    if (!u || !sb() || !cardId) return false;
    var res = await sb().from("wishlist").select("id")
      .eq("user_id", u.id)
      .eq("card_id", cardId)
      .limit(1);
    if (res.error) return false;
    return !!(res.data && res.data.length);
  }

  async function add(card, variant) {
    var u = needUser();
    if (!u || !sb()) return null;
    var row = await addTimePrice(card, snapshot(u, card, variant));
    var res = await sb().from("wishlist")
      .upsert(row, { onConflict: "user_id,card_id" })
      .select();
    if (res.error) throw res.error;
    return (res.data && res.data[0]) || row;
  }

  async function remove(cardId) {
    var u = needUser();
    if (!u || !sb()) return false;
    var res = await sb().from("wishlist").delete()
      .eq("user_id", u.id)
      .eq("card_id", cardId);
    if (res.error) throw res.error;
    return true;
  }

  /* Returns true when the card ends up wished, false when removed.
   * Because add() upserts on (user_id, card_id), re-adding an already
   * wished card would just update it — so toggle removes instead. */
  async function toggle(card, variant) {
    var u = needUser();
    if (!u) return null;
    if (await isWished(card.id)) {
      await remove(card.id);
      return false;
    }
    await add(card, variant);
    return true;
  }

  /* Deal check: a target is set, a market price is known, both are in the
   * same currency, and the market price is at or under the target.
   * Currency mismatch never counts as a deal — a EUR price must not be
   * compared against a USD target. */
  function isDeal(row) {
    if (!row) return false;
    if (typeof row.target_price !== "number" || typeof row.market_price !== "number") return false;
    if ((row.target_currency || "USD") !== (row.price_currency || "USD")) return false;
    return row.market_price <= row.target_price;
  }

  /* Set (or clear, with price == null) the target price for a wished card.
   * The target is stored in the row's price currency so comparisons stay
   * apples-to-apples. Clearing also resets target_hit_at. Tolerates the
   * migration not being applied yet — the caller should surface a friendly
   * message on failure. */
  async function setTarget(cardId, price, currency) {
    var u = needUser();
    if (!u || !sb() || !cardId) return null;
    var patch = (price === null || price === undefined)
      ? { target_price: null, target_hit_at: null }
      : { target_price: price, target_currency: currency || "USD" };
    var res = await sb().from("wishlist").update(patch)
      .eq("user_id", u.id)
      .eq("card_id", cardId)
      .select();
    if (res.error) throw res.error;
    return (res.data && res.data[0]) || null;
  }

  /* Record a deal transition after a price refresh: stamp target_hit_at on
   * the first hit, clear it when the price climbs back above target so a
   * later dip counts as new again. */
  async function noteDealTransition(row, dealNow) {
    var hit = !!row.target_hit_at;
    if (dealNow === hit) return row;
    var res = await sb().from("wishlist").update({
      target_hit_at: dealNow ? new Date().toISOString() : null
    }).eq("id", row.id).select();
    if (!res.error && res.data && res.data[0]) return res.data[0];
    return row;
  }

  App.wishlist = {
    list: list,
    add: add,
    remove: remove,
    isWished: isWished,
    toggle: toggle,
    isDeal: isDeal,
    setTarget: setTarget,
    noteDealTransition: noteDealTransition
  };
})();
