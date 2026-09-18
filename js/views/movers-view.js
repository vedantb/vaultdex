/* VaultDex — price movers dashboard (Feature 4).
 * Shows the cards whose price changed since the last refresh, from the
 * prev_price recorded by refreshPrices(). Public data: works signed-out
 * (owner's collection) as well as for the owner. */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

  var MAX_PER_SECTION = 10;

  function deltaOf(it) { return Number(it.market_price) - Number(it.prev_price); }

  function isMover(it) {
    return typeof it.prev_price === "number" &&
      typeof it.market_price === "number" &&
      it.market_price !== it.prev_price;
  }

  /* delta signed: "+$3.50 (+12.34%)" for gains, "−$1.20 (−4.56%)" for losses.
   * Percent is vs prev_price; guarded against divide-by-zero (prev = 0). */
  function deltaText(it) {
    var d = deltaOf(it);
    var sign = d > 0 ? "+" : "\u2212"; // U+2212 minus, matches collection-view
    var txt = sign + App.ui.money(Math.abs(d));
    var prev = Number(it.prev_price);
    if (prev !== 0) {
      txt += " (" + sign + (Math.abs(d / prev) * 100).toFixed(2) + "%)";
    }
    return txt;
  }

  function moverTile(it) {
    var cls = deltaOf(it) > 0 ? "mover-up" : "mover-down";
    return (
      '<article class="card-tile" data-row="' + App.esc(it.id) + '">' +
        '<span class="qty-badge">×' + it.quantity + "</span>" +
        '<div class="art"><img loading="lazy" src="' + App.esc(it.image_small) + '" alt="' + App.esc(it.card_name) + ' card art"></div>' +
        '<div class="info">' +
          '<div class="name">' + App.esc(it.card_name) + "</div>" +
          '<div class="set">' + App.esc(it.set_name || "") + "</div>" +
          '<div class="mover-prices">' + App.ui.money(it.prev_price) + " → " + App.ui.money(it.market_price) + "</div>" +
          '<div class="price-row"><span class="price-badge ' + cls + '">' + deltaText(it) + "</span>" +
          '<span class="variant-chip">' + App.esc(it.variant) + "</span></div>" +
        "</div>" +
      "</article>"
    );
  }

  function sectionHtml(title, sub, movers) {
    return '<section class="movers-section">' +
      '<h2 class="movers-h">' + App.esc(title) + "</h2>" +
      '<div class="result-meta">' + App.esc(sub) + "</div>" +
      '<div class="card-grid">' + movers.map(moverTile).join("") + "</div>" +
      "</section>";
  }

  App.views.movers = async function (root) {
    if (!App.isConfigured()) {
      root.innerHTML = App.ui.emptyState({
        title: "Supabase isn't configured",
        body: "Add your Supabase URL and anon key to js/config.js (see SETUP.md), then reload. You can still browse cards in the meantime.",
        actionHtml: '<a class="btn btn-ghost" href="/browse">Browse cards</a>'
      });
      return;
    }

    var readOnly = !App.auth.isOwner();
    function el(id) { return root.querySelector("#" + id); }

    root.innerHTML = '<div class="stats-row"></div><div id="m-loading"></div>';
    App.ui.skeletonGrid(el("m-loading"), 6);

    try {
      var items = (readOnly ? await App.collection.listPublic() : await App.collection.list()) || [];

      var html =
        '<div class="movers-head">' +
          '<h1 class="movers-title">Price movers</h1>' +
          '<p class="movers-sub">Price changes since ' + (readOnly ? "the owner's" : "your") + " last refresh.</p>" +
        "</div>";

      if (!items.length) {
        html += App.ui.emptyState({
          title: "The shelf is empty",
          body: readOnly
            ? "This collection doesn't have any cards yet."
            : "Head to Browse to find cards — search by name, or open a set and bulk-add the ones you own.",
          actionHtml: readOnly ? "" : '<a class="btn btn-primary" href="/browse">Browse cards</a>'
        });
        root.innerHTML = html;
        window.scrollTo(0, 0);
        return;
      }

      var movers = items.filter(isMover);
      if (!movers.length) {
        html += App.ui.emptyState({
          title: "No movers yet",
          body: "Movers appear after the first price refresh that changes a card's price. Prices refresh automatically each day."
        });
        root.innerHTML = html;
        window.scrollTo(0, 0);
        return;
      }

      var gainers = movers.filter(function (it) { return deltaOf(it) > 0; })
        .sort(function (a, b) { return deltaOf(b) - deltaOf(a); })
        .slice(0, MAX_PER_SECTION);
      var losers = movers.filter(function (it) { return deltaOf(it) < 0; })
        .sort(function (a, b) { return deltaOf(a) - deltaOf(b); })
        .slice(0, MAX_PER_SECTION);

      if (gainers.length) {
        html += sectionHtml("Top gainers", "Biggest price increases, by dollar change.", gainers);
      }
      if (losers.length) {
        html += sectionHtml("Top losers", "Biggest price drops, by dollar change.", losers);
      }
      root.innerHTML = html;
      window.scrollTo(0, 0);
    } catch (e) {
      root.innerHTML = App.ui.emptyState({ title: "Couldn't load price movers", body: (e && e.message) || "Something went wrong." });
      App.handleApiError(e);
    }
  };
})();
