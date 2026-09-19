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

  /* Lazy, in-memory-cached species → catalog printings index
   * (data/species-printings.json, built by scripts/build-species-printings.js).
   * Tuples: [card_id, lang, name, set_name, image]. A failed fetch resolves
   * to null and the modal falls back to the owned-only view — quiet. */
  var printingsCache = null;
  var printingsFailed = false;
  function loadPrintings() {
    if (printingsCache || printingsFailed) return Promise.resolve(printingsCache);
    return fetch("/data/species-printings.json").then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (json) {
      printingsCache = json || {};
      return printingsCache;
    }).catch(function (e) {
      printingsFailed = true;
      if (typeof console !== "undefined") console.warn("[VaultDex] species printings failed to load:", e && e.message);
      return null;
    });
  }

  function speciesCell(slug, num, group) {
    var lvl = group ? levelFor(group.copies) : null;
    var inner;
    if (lvl) {
      var img = group.cards[0] ? (group.cards[0].image_small || group.cards[0].image_large) : null;
      inner =
        (img ? '<img loading="lazy" src="' + App.esc(img) + '" alt="' + App.esc(App.species.displayName(slug)) + '">' : "") +
        '<span class="dex-num">#' + num + "</span>";
    } else {
      /* Uncaptured: official artwork, greyscaled — "Who's that Pokémon?".
       * The error handler (bound after render) hides the img if the
       * artwork 404s, leaving the number-only cell. */
      var art = App.species.artworkUrl(num);
      inner =
        (art ? '<img loading="lazy" class="dex-art-missing" src="' + App.esc(art) + '" alt="">' : "") +
        '<span class="dex-num dex-num-alone">#' + num + "</span>";
    }
    return '<button type="button" class="dex-cell ' + (lvl ? lvl.cls : "dex-missing") + '"' +
      ' data-dex-species="' + App.esc(slug) + '"' +
      ' aria-label="' + App.esc(App.species.displayName(slug)) + (lvl ? ", " + lvl.label + ", " + group.copies + " cards" : ", not captured, view missing printings") + '">' +
      inner +
      '<span class="dex-name">' + App.esc(App.species.displayName(slug)) + "</span>" +
    "</button>";
  }

  function ownedCard(owned, i) {
    var c = owned[i];
    var img = c.image_small || c.image_large;
    return '<button type="button" class="dex-modal-card" data-dex-owned="' + i + '">' +
      (img ? '<img loading="lazy" src="' + App.esc(img) + '" alt="' + App.esc(c.card_name || "") + '">' : "") +
      '<span class="dmc-name">' + App.esc(c.card_name || "?") + "</span>" +
      '<span class="dmc-meta">' + App.esc(c.set_name || "") + (c.variant ? " · " + App.esc(c.variant) : "") + "</span>" +
    "</button>";
  }

  function missingCard(m) {
    var img = m[4];
    return '<button type="button" class="dex-modal-card dex-modal-missing" data-dex-missing="' + App.esc(m[0]) + '" data-dex-lang="' + App.esc(m[1]) + '">' +
      (img ? '<img loading="lazy" src="' + App.esc(img) + '" alt="">' : "") +
      '<span class="dmc-name">' + App.esc(m[2] || "?") + "</span>" +
      '<span class="dmc-meta">' + App.esc(m[3] || "") + "</span>" +
    "</button>";
  }

  function openSpeciesModal(slug, group) {
    var owned = group ? group.cards.slice().sort(function (a, b) {
      return (Number(b.market_price) || 0) - (Number(a.market_price) || 0);
    }) : [];
    var copies = group ? group.copies : 0;
    var ownedIds = owned.map(function (c) { return c.card_id; });

    function paint(missing, loading) {
      missing = missing || [];
      var html =
        '<div class="dex-modal-head">' +
          '<h3>' + App.esc(App.species.displayName(slug)) + ' <span class="dex-modal-num">#' + App.species.dexNumber(slug) + "</span></h3>" +
          '<div class="result-meta">' + copies + (copies === 1 ? " card" : " cards") + " in the vault</div>" +
        "</div>";
      if (owned.length) {
        html += '<div class="dex-modal-grid">' +
          owned.map(function (c, i) { return ownedCard(owned, i); }).join("") +
        "</div>";
      }
      if (loading) {
        html += '<p class="dex-modal-loading">Finding missing printings…</p>';
      } else if (missing.length) {
        html += '<h4 class="dex-modal-sub">Missing printings (' + missing.length + ")</h4>" +
          '<div class="dex-modal-grid">' +
          missing.map(missingCard).join("") +
        "</div>";
      }
      return html;
    }

    /* Paint the owned section immediately; the missing-printings index
     * loads lazily and fills in below (or never, on failure — quiet). */
    var m = App.ui.openModal(paint(null, true), { narrow: true });
    function body() { return m.el.querySelector(".modal-body"); }
    function bindOwned() {
      m.el.querySelectorAll("[data-dex-owned]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var c = owned[parseInt(btn.getAttribute("data-dex-owned"), 10)];
          if (!c) return;
          m.close();
          App.openCardModal(c.card_id, App.util.langOf(c), c);
        });
      });
    }
    function bindMissing() {
      m.el.querySelectorAll("[data-dex-missing]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          m.close();
          App.openCardModal(btn.getAttribute("data-dex-missing"), btn.getAttribute("data-dex-lang") || "en");
        });
      });
    }
    bindOwned();

    loadPrintings().then(function (idx) {
      if (!m.el.isConnected) return;
      var all = (idx && idx[slug]) || [];
      var missing = App.species.missingPrintings(all, ownedIds);
      /* Re-render the modal body: loading line swaps for the missing grid
       * (or disappears when there is nothing missing / the fetch failed). */
      body().innerHTML = paint(missing, false);
      bindOwned();
      bindMissing();
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
    var filterHtml =
      '<div class="dex-filters">' +
      '<label class="dex-filter"><input type="checkbox" data-dex-filter="caught"> Captured only</label>' +
      '<label class="dex-filter"><input type="checkbox" data-dex-filter="missing"> Not captured</label>' +
      "</div>";
    root.innerHTML =
      '<div class="pokedex-head">' +
        '<h1 class="pokedex-title">Pokédex</h1>' +
        '<p class="pokedex-sub">' + App.esc(readOnly ? "Every species Vedant's cards have captured." : "Every species your cards have captured. Gotta catch 'em all.") + "</p>" +
        '<div class="pokedex-count"><span class="pokedex-count-num" data-dex-count>…</span> / 1025 species</div>' +
        filterHtml +
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

    function renderGrid(mode) {
      return '<div class="dex-grid">' +
        mapping.order.map(function (slug) {
          var g = groups[slug] || null;
          if (!App.species.visibleInMode(!!g, mode)) return "";
          return speciesCell(slug, mapping.dex[slug], g);
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
        filterHtml +
      "</div>" +
      '<div data-dex-grid-wrap>' + renderGrid("all") + "</div>";

    var wrap = root.querySelector("[data-dex-grid-wrap]");
    var boxes = Array.prototype.slice.call(root.querySelectorAll("[data-dex-filter]"));
    function currentMode() {
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].checked) return boxes[i].getAttribute("data-dex-filter");
      }
      return "all";
    }
    function bindCells() {
      /* Every cell is clickable — captured opens owned cards, uncaptured
       * opens the missing-printings view for that species. */
      wrap.querySelectorAll("[data-dex-species]").forEach(function (cell) {
        cell.addEventListener("click", function () {
          var slug = cell.getAttribute("data-dex-species");
          openSpeciesModal(slug, groups[slug] || null);
        });
      });
      /* Artwork 404s (a few dex numbers lack official art) fall back to
       * the number-only cell instead of a broken image. */
      wrap.querySelectorAll("img.dex-art-missing").forEach(function (img) {
        img.addEventListener("error", function () { img.remove(); });
        if (img.complete && img.naturalWidth === 0) img.remove();
      });
    }
    bindCells();
    boxes.forEach(function (box) {
      box.addEventListener("change", function () {
        /* Mutually exclusive: checking one unchecks the other; unchecking
         * the active one returns to "All". */
        if (box.checked) {
          boxes.forEach(function (other) { if (other !== box) other.checked = false; });
        }
        wrap.innerHTML = renderGrid(currentMode());
        bindCells();
      });
    });
    App.ui.reveal(root);
  };
})();
