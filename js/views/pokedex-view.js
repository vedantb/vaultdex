/* VaultDex — species Pokédex.
 * National-Dex-ordered grid of all 1025 species. A species is "captured"
 * when the owner owns any card of it (card names map to species via
 * js/species.js — unknown names are skipped, never guessed). Copy counts
 * set the frame: 1 captured, 5 bronze, 15 silver, 30 gold (shiny).
 * Public read-only for visitors. Zero PkmnPrices credits. */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

  var LEVELS = [
    { min: 30, cls: "dex-gold", label: "Gold" },
    { min: 15, cls: "dex-silver", label: "Silver" },
    { min: 5, cls: "dex-bronze", label: "Bronze" },
    { min: 1, cls: "dex-caught", label: "Captured" }
  ];
  function levelFor(copies) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (copies >= LEVELS[i].min) return LEVELS[i];
    }
    return null;
  }

  function speciesCell(slug, num, group) {
    var lvl = group ? levelFor(group.copies) : null;
    var img = group && group.cards[0] ? (group.cards[0].image_small || group.cards[0].image_large) : null;
    var inner;
    if (lvl) {
      inner =
        (img ? '<img loading="lazy" src="' + App.esc(img) + '" alt="' + App.esc(App.species.displayName(slug)) + '">' : "") +
        '<span class="dex-num">#' + num + "</span>";
    } else {
      inner = '<span class="dex-num dex-num-alone">#' + num + "</span>";
    }
    return '<button type="button" class="dex-cell ' + (lvl ? lvl.cls : "dex-missing") + '"' +
      (lvl ? ' data-dex-species="' + App.esc(slug) + '"' : " disabled") +
      ' aria-label="' + App.esc(App.species.displayName(slug)) + (lvl ? ", " + lvl.label + ", " + group.copies + " cards" : ", not captured") + '">' +
      inner +
      '<span class="dex-name">' + App.esc(App.species.displayName(slug)) + "</span>" +
    "</button>";
  }

  function openSpeciesModal(slug, group) {
    var cards = group.cards.slice().sort(function (a, b) {
      return (Number(b.market_price) || 0) - (Number(a.market_price) || 0);
    });
    var html =
      '<div class="dex-modal-head">' +
        '<h3>' + App.esc(App.species.displayName(slug)) + ' <span class="dex-modal-num">#' + App.species.dexNumber(slug) + "</span></h3>" +
        '<div class="result-meta">' + group.copies + (group.copies === 1 ? " card" : " cards") + " in the vault</div>" +
      "</div>" +
      '<div class="dex-modal-grid">' +
      cards.map(function (c, i) {
        var img = c.image_small || c.image_large;
        return '<button type="button" class="dex-modal-card" data-dex-card="' + i + '">' +
          (img ? '<img loading="lazy" src="' + App.esc(img) + '" alt="' + App.esc(c.card_name || "") + '">' : "") +
          '<span class="dmc-name">' + App.esc(c.card_name || "?") + "</span>" +
          '<span class="dmc-meta">' + App.esc(c.set_name || "") + (c.variant ? " · " + App.esc(c.variant) : "") + "</span>" +
        "</button>";
      }).join("") +
      "</div>";
    var m = App.ui.openModal(html, { narrow: true });
    m.el.querySelectorAll("[data-dex-card]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var c = cards[parseInt(btn.getAttribute("data-dex-card"), 10)];
        if (!c) return;
        m.close();
        App.openCardModal(c.card_id, App.util.langOf(c), c);
      });
    });
  }

  App.views.pokedex = async function (root) {
    if (!App.isConfigured()) {
      root.innerHTML = App.ui.emptyState({
        title: "Supabase isn't configured",
        body: "Add your Supabase URL and anon key to js/config.js (see SETUP.md), then reload.",
        actionHtml: '<a class="btn btn-ghost" href="/browse">Browse cards</a>'
      });
      return;
    }
    var readOnly = !App.auth.isOwner();
    root.innerHTML =
      '<div class="pokedex-head">' +
        '<h1 class="pokedex-title">Pokédex</h1>' +
        '<p class="pokedex-sub">' + App.esc(readOnly ? "Every species Vedant's cards have captured." : "Every species your cards have captured. Gotta catch 'em all.") + "</p>" +
        '<div class="pokedex-count"><span class="pokedex-count-num" data-dex-count>…</span> / 1025 species</div>' +
        '<label class="dex-filter"><input type="checkbox" data-dex-caught-only> Captured only</label>' +
      "</div>" +
      '<div id="d-loading"></div>';
    App.ui.skeletonGrid(root.querySelector("#d-loading"), 12);

    var mapping, items;
    try {
      mapping = await App.species.loadMapping();
      items = (readOnly ? await App.collection.listPublic() : await App.collection.list()) || [];
    } catch (e) {
      root.innerHTML = App.ui.emptyState({ title: "Couldn't load the Pokédex", body: (e && e.message) || "Something went wrong." });
      return;
    }
    var groups = App.species.groupRowsBySpecies(items);
    var caught = Object.keys(groups).length;

    function renderGrid(caughtOnly) {
      return '<div class="dex-grid">' +
        mapping.order.map(function (slug) {
          var g = groups[slug];
          if (caughtOnly && !g) return "";
          return speciesCell(slug, mapping.dex[slug], g || null);
        }).join("") +
      "</div>";
    }

    root.innerHTML =
      '<div class="pokedex-head">' +
        '<h1 class="pokedex-title">Pokédex</h1>' +
        '<p class="pokedex-sub">' + App.esc(readOnly ? "Every species Vedant's cards have captured." : "Every species your cards have captured. Gotta catch 'em all.") + "</p>" +
        '<div class="pokedex-count"><span class="pokedex-count-num">' + caught + "</span> / 1025 species</div>" +
        '<div class="dex-legend">' +
          '<span class="dex-legend-item"><i class="dex-dot dex-caught"></i>Captured</span>' +
          '<span class="dex-legend-item"><i class="dex-dot dex-bronze"></i>5+</span>' +
          '<span class="dex-legend-item"><i class="dex-dot dex-silver"></i>15+</span>' +
          '<span class="dex-legend-item"><i class="dex-dot dex-gold"></i>30+ ✨</span>' +
        "</div>" +
        '<label class="dex-filter"><input type="checkbox" data-dex-caught-only> Captured only</label>' +
      "</div>" +
      '<div data-dex-grid-wrap>' + renderGrid(false) + "</div>";

    var wrap = root.querySelector("[data-dex-grid-wrap]");
    var box = root.querySelector("[data-dex-caught-only]");
    function bindCells() {
      wrap.querySelectorAll("[data-dex-species]").forEach(function (cell) {
        cell.addEventListener("click", function () {
          var slug = cell.getAttribute("data-dex-species");
          if (groups[slug]) openSpeciesModal(slug, groups[slug]);
        });
      });
    }
    bindCells();
    box.addEventListener("change", function () {
      wrap.innerHTML = renderGrid(box.checked);
      bindCells();
    });
    App.ui.reveal(root);
  };
})();
