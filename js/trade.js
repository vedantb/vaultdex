/* VaultDex — trade binder data layer (Feature 6).
 *
 * trade_qty (nullable integer, >= 0) on collection_items:
 *   - when set, it's the EXACT number of copies up for trade
 *     (0 = explicitly excluded from the binder)
 *   - when null, the auto-rule applies:
 *     (quantity - 1) if quantity > 1, else not listed
 *
 * Rows fetched before the migration is applied won't carry the column —
 * treat a missing column as null so the auto-rule governs them.
 * Zero PkmnPrices calls: listing and steppers touch trade_qty only.
 */
(function () {
  window.App = window.App || {};

  /* How many copies of a row are up for trade right now. */
  function effectiveQty(row) {
    var tq = (row && row.trade_qty !== undefined && row.trade_qty !== null)
      ? Math.floor(Number(row.trade_qty))
      : null;
    if (tq !== null) return (!isFinite(tq) || tq < 0) ? 0 : tq;
    var q = row && row.quantity ? Number(row.quantity) : 0;
    return q > 1 ? q - 1 : 0;
  }

  /* Listing state, driving trade badge/button styling ("trade-on" /
   * "trade-auto" / "trade-off", defined in css/trade.css):
   *   on   = explicitly listed (trade_qty > 0)
   *   auto = listed via the auto-rule (trade_qty null, surplus > 0)
   *   off  = excluded (trade_qty === 0) or nothing available */
  function tradeState(row) {
    var hasTq = !!(row && row.trade_qty !== undefined && row.trade_qty !== null);
    var eff = effectiveQty(row);
    if (hasTq) return eff > 0 ? "on" : "off";
    return eff > 0 ? "auto" : "off";
  }

  /* All rows currently listed for trade (effectiveQty > 0).
   * The owner sees their own rows; visitors see the owner's public rows. */
  async function listForTrade() {
    var rows = App.auth.isOwner()
      ? await App.collection.list()
      : await App.collection.listPublic();
    if (!rows) return null;
    return rows.filter(function (r) { return effectiveQty(r) > 0; });
  }

  /* Owner-only: set the exact number of copies up for trade (0 removes
   * the row from the binder). Never touches prices, quantities, or any
   * other column. */
  async function setTradeQty(rowId, qty) {
    if (!App.auth.isOwner()) throw new Error("Only the owner can manage trade listings.");
    qty = Math.floor(Number(qty));
    if (!isFinite(qty) || qty < 0) {
      throw new Error("Trade quantity must be a whole number of 0 or more.");
    }
    var u = App.auth.user;
    var up = await App.sb
      .from("collection_items")
      .update({ trade_qty: qty })
      .eq("id", rowId)
      .eq("user_id", u.id);
    if (up.error) throw up.error;
    App.emit("trade:changed", { id: rowId, tradeQty: qty });
    return qty;
  }

  App.trade = {
    effectiveQty: effectiveQty,
    tradeState: tradeState,
    listForTrade: listForTrade,
    setTradeQty: setTradeQty
  };
})();
