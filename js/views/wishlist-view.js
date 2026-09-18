/* VaultDex — wishlist view (Feature 2 + target-price deals). Owner-only grid
 * of saved cards with stored price badges, per-card target prices, a Deals
 * section pinned at the top, and a user-triggered price refresh.
 *
 * The wishlist is private: non-owners get an empty state pointing at
 * /collection, and there is no public read path (see the table's RLS policy).
 *
 * A row is a "deal" when its market price is at or under its target price
 * (same currency required). target_hit_at is stamped on the first hit and
 * cleared when the price climbs back above target, so a later dip counts
 * as new again.
 */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

  function isJaRow(row) {
    return (row.set_id || "").indexOf("ja-") === 0;
  }

  function targetLine(row) {
    if (typeof row.target_price !== "number") return "";
    return '<div class="target-row"><span class="target-chip">' +
      App.ui.icon("target") + " " + App.esc(App.ui.money(row.target_price, row.target_currency)) +
      "</span></div>";
  }

  function tileHtml(row) {
    var deal = App.wishlist.isDeal(row);
    var price = (typeof row.market_price === "number")
      ? App.ui.money(row.market_price, row.price_currency)
      : "—";
    return (
      '<article class="card-tile wishlist-tile' + (deal ? " is-deal" : "") + '" data-row="' + App.esc(row.id) + '" data-card="' + App.esc(row.card_id) + '">' +
        '<button type="button" class="icon-btn-sm wishlist-target' + (typeof row.target_price === "number" ? " has-target" : "") + '" data-act="target" aria-label="Set target price for ' + App.esc(row.card_name || row.card_id) + '" title="Set target price">' + App.ui.icon("target") + "</button>" +
        '<button type="button" class="icon-btn-sm wishlist-remove" data-act="rm" aria-label="Remove ' + App.esc(row.card_name || row.card_id) + ' from wishlist" title="Remove from wishlist">' + App.ui.icon("x") + "</button>" +
        '<div class="art"><img loading="lazy" src="' + App.esc(row.image_small) + '" alt="' + App.esc(row.card_name || row.card_id) + ' card art"></div>' +
        '<div class="info">' +
          '<div class="name">' + App.esc(row.card_name || row.card_id) + "</div>" +
          '<div class="set">' + App.esc(row.set_name || "") + "</div>" +
          '<div class="price-row"><span class="price-badge">' + App.esc(price) + "</span>" +
          (deal ? '<span class="deal-badge">At target</span>' : "") +
          (row.variant ? '<span class="variant-chip">' + App.esc(row.variant) + "</span>" : "") + "</div>" +
          targetLine(row) +
        "</div>" +
      "</article>"
    );
  }

  App.views.wishlist = async function (root) {
    if (!App.isConfigured()) {
      root.innerHTML = App.ui.emptyState({
        title: "Supabase isn't configured",
        body: "Add your Supabase URL and anon key to js/config.js (see SETUP.md), then reload. You can still browse cards in the meantime.",
        actionHtml: '<a class="btn btn-ghost" href="/browse">Browse cards</a>'
      });
      return;
    }
    if (!App.auth.isOwner()) {
      root.innerHTML = App.ui.emptyState({
        title: "Wishlist is private",
        body: "Only the collection owner keeps a wishlist here.",
        actionHtml: '<a class="btn btn-primary" href="/collection">Go to collection</a>'
      });
      return;
    }

    var items;
    try {
      items = await App.wishlist.list();
    } catch (e) {
      root.innerHTML = App.ui.emptyState({ title: "Couldn't load your wishlist", body: (e && e.message) || "Something went wrong." });
      return;
    }

    function deals() { return items.filter(App.wishlist.isDeal); }
    function watching() { return items.filter(function (x) { return !App.wishlist.isDeal(x); }); }

    function countLabel() {
      return items.length === 1 ? "1 card" : items.length + " cards";
    }

    function render() {
      if (!items.length) {
        root.innerHTML = App.ui.emptyState({
          title: "Your wishlist is empty",
          body: "Tap the heart on any card to save it here for later.",
          actionHtml: '<a class="btn btn-ghost" href="/browse">Browse cards</a>'
        });
        return;
      }
      var ds = deals();
      var ws = watching();
      var html =
        '<div class="wishlist-head">' +
          '<div class="wishlist-head-text"><h2>Wishlist</h2>' +
          '<p class="wishlist-count" id="wish-count">' + App.esc(countLabel()) + "</p></div>" +
          '<button type="button" class="btn btn-ghost btn-sm" id="wish-refresh">' + App.ui.icon("refresh") + " Refresh prices</button>" +
        "</div>";
      if (ds.length) {
        html +=
          '<section class="deals-section" aria-label="Deals">' +
            '<div class="deals-head"><h3>' + App.ui.icon("target") + " Deals</h3>" +
            '<p>' + ds.length + (ds.length === 1 ? " card at or under" : " cards at or under") + " your target</p></div>" +
            '<div class="card-grid" id="wish-deals">' + ds.map(tileHtml).join("") + "</div>" +
          "</section>";
      }
      if (ws.length) {
        if (ds.length) html += '<h3 class="watching-head">Watching</h3>';
        html += '<div class="card-grid" id="wish-grid">' + ws.map(tileHtml).join("") + "</div>";
      }
      root.innerHTML = html;
      wireGrid();
      root.querySelector("#wish-refresh").addEventListener("click", refreshPrices);
    }

    function findRow(rowId) {
      return items.filter(function (x) { return x.id === rowId; })[0];
    }

    function wireGrid() {
      root.querySelectorAll("#wish-grid .card-tile, #wish-deals .card-tile").forEach(function (tile) {
        tile.querySelector(".art").addEventListener("click", function () {
          var row = findRow(tile.getAttribute("data-row"));
          var cid = tile.getAttribute("data-card");
          // Japanese cards live under ja- set ids; the catalog lookup must
          // use the Japanese namespace or TCGdex returns 404.
          App.openCardModal(cid, isJaRow(row || {}) ? "ja" : "en", row);
        });
        var rm = tile.querySelector('[data-act="rm"]');
        if (rm) rm.addEventListener("click", async function (e) {
          e.stopPropagation();
          var rowId = tile.getAttribute("data-row");
          var row = findRow(rowId);
          try {
            if (!row || !(await App.wishlist.remove(row.card_id))) return;
            App.ui.toast("Removed from wishlist.", "success");
            items = items.filter(function (x) { return x.id !== rowId; });
            render();
          } catch (err) {
            App.handleApiError(err);
          }
        });
        var tg = tile.querySelector('[data-act="target"]');
        if (tg) tg.addEventListener("click", function (e) {
          e.stopPropagation();
          var row = findRow(tile.getAttribute("data-row"));
          if (row) openTargetEditor(row);
        });
      });
      var grids = root.querySelectorAll("#wish-grid, #wish-deals");
      grids.forEach(function (g) { App.ui.staggerTiles(g, ".card-tile"); });
    }

    /* Target-price editor. The target is stored in the row's price currency
     * so deal comparisons stay apples-to-apples. */
    function openTargetEditor(row) {
      var now = (typeof row.market_price === "number")
        ? App.ui.money(row.market_price, row.price_currency)
        : "no price yet";
      var cur = (typeof row.target_price === "number") ? String(row.target_price) : "";
      var m = App.ui.openModal(
        '<div class="target-editor">' +
          '<h3>Target price</h3>' +
          '<p class="target-sub">' + App.esc(row.card_name || row.card_id) + " · now " + App.esc(now) + "</p>" +
          '<label class="target-label">Alert me at' +
            '<span class="target-input-wrap"><span class="target-cur">' + App.esc(row.price_currency === "EUR" ? "€" : "$") + "</span>" +
            '<input id="tg-input" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" value="' + App.esc(cur) + '"></span>' +
          "</label>" +
          '<div class="target-actions">' +
            (cur ? '<button type="button" class="btn btn-ghost btn-sm" id="tg-clear">Clear target</button>' : "") +
            '<span class="target-spacer"></span>' +
            '<button type="button" class="btn btn-primary btn-sm" id="tg-save">Save</button>' +
          "</div>" +
        "</div>",
        { narrow: true }
      );
      var input = m.el.querySelector("#tg-input");
      if (input) setTimeout(function () { input.focus(); input.select(); }, 50);

      async function save(price) {
        try {
          var updated = await App.wishlist.setTarget(row.card_id, price, row.price_currency);
          if (updated) {
            var i = items.indexOf(row);
            if (i >= 0) items[i] = updated;
          }
          m.close();
          render();
          App.ui.toast(price === null ? "Target cleared." : "Target set — I'll flag it in Deals when it hits.", "success");
        } catch (err) {
          App.ui.toast("Couldn't save the target — run the wishlist migration in Supabase first.", "info");
        }
      }

      m.el.querySelector("#tg-save").addEventListener("click", function () {
        var v = parseFloat(input.value);
        if (isNaN(v) || v <= 0) {
          App.ui.toast("Enter a target price above zero.", "info");
          return;
        }
        save(Math.round(v * 100) / 100);
      });
      var clearBtn = m.el.querySelector("#tg-clear");
      if (clearBtn) clearBtn.addEventListener("click", function () { save(null); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") m.el.querySelector("#tg-save").click();
      });
    }

    /* Explicit user action only: re-price each row Near Mint (1 credit each).
     * Deal transitions are stamped (target_hit_at) so the toast below only
     * fires for newly-hit targets, not every refresh. Per-row errors are
     * tolerated; a 429 stops the run quietly with a toast. */
    var refreshing = false;
    async function refreshPrices() {
      if (refreshing) return;
      if (!App.collection.needUser()) return;
      refreshing = true;
      var btn = root.querySelector("#wish-refresh");
      if (btn) btn.disabled = true;
      var updated = 0;
      var newDeals = 0;
      var stopped = false;
      for (var i = 0; i < items.length; i++) {
        try {
          var p = await App.pkmn.priceForRow(items[i]);
          if (p && typeof p.price === "number") {
            var up = await App.sb.from("wishlist").update({
              market_price: p.price,
              price_currency: p.currency || "USD"
            }).eq("id", items[i].id);
            if (!up.error) {
              items[i].market_price = p.price;
              items[i].price_currency = p.currency || "USD";
              updated++;
            }
          }
          var dealNow = App.wishlist.isDeal(items[i]);
          var wasHit = !!items[i].target_hit_at;
          if (dealNow && !wasHit) newDeals++;
          items[i] = await App.wishlist.noteDealTransition(items[i], dealNow);
        } catch (e) {
          if (e && (e.status === 429 || e.notConfigured)) { stopped = true; break; }
          console.warn("[VaultDex] wishlist refresh failed for", items[i].card_id, e && e.message);
        }
      }
      refreshing = false;
      render();
      if (stopped) {
        App.ui.toast("Rate limited — stopped early. Try again in a bit.", "info");
      } else if (newDeals > 0) {
        App.ui.toast("🎯 " + newDeals + (newDeals === 1 ? " deal" : " deals") + " hit your target!", "success");
      } else {
        App.ui.toast(updated ? "Prices refreshed." : "No prices found to update.", "success");
      }
    }

    render();
  };
})();
