/* VaultDex — browse view: card search bar on top, set browser below.
 * Defaults to browsing sets: pick a language (English / Japanese), then
 * era-grouped set sections with a set-specific search filter (pkmn.gg
 * style). Typing in the card search bar swaps the body to card results;
 * clearing it returns to the set browser. */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

  var PAGE_SIZE = 24;

  var setsCache = null;
  async function loadSets() {
    if (!setsCache) setsCache = await App.tcg.getSets();
    return setsCache;
  }

  function tileHtml(card) {
    var market = App.tcg.marketOf(card);
    return (
      '<article class="card-tile" data-id="' + App.esc(card.id) + '" tabindex="0" role="button" aria-label="View ' + App.esc(card.name) + '">' +
        '<div class="art"><img loading="lazy" src="' + App.esc(card.images && card.images.small) + '" alt="' + App.esc(card.name) + ' card art"></div>' +
        '<div class="info">' +
          '<div class="name">' + App.esc(card.name) + "</div>" +
          '<div class="set">' + App.esc((card.set && card.set.name) || "") + "</div>" +
          '<div class="price-row"><span class="price-badge">' + App.ui.money(market, card.priceCurrency) + "</span>" +
          (card.rarity ? '<span class="variant-chip" style="max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + App.esc(card.rarity) + "</span>" : "") +
          "</div>" +
        "</div>" +
      "</article>"
    );
  }

  function bindTiles(root) {
    root.querySelectorAll(".card-tile").forEach(function (tile) {
      function open() { App.openCardModal(tile.getAttribute("data-id")); }
      tile.addEventListener("click", open);
      tile.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });
    App.ui.staggerTiles(root, ".card-tile");
  }

  function setTileHtml(s) {
    // Japanese sets have no TCGdex logo art; fall back to the set symbol.
    var logo = s.images && s.images.logo;
    var img = logo || (s.images && s.images.symbol);
    var cls = !logo && img ? ' class="symbol"' : "";
    var total = s.total || s.printedTotal || "?";
    return (
      '<div class="set-tile" data-id="' + App.esc(s.appId) + '" tabindex="0" role="button" aria-label="Open ' + App.esc(s.name) + '">' +
        '<div class="logo">' + (img ? '<img loading="lazy" src="' + App.esc(img) + '" alt=""' + cls + ">" : "") + "</div>" +
        "<h3>" + App.esc(s.name) + "</h3>" +
        '<div class="meta">' + total + " cards</div>" +
        // Filled in by paintSetProgress once the owner's collection index
        // loads (X = distinct owned cards in this set, Y = set size).
        '<div class="set-progress-line" data-sp="' + App.esc(s.appId) + '" data-sp-total="' + App.esc(String(total)) + '"></div>' +
      "</div>"
    );
  }

  function bindSetTiles(root) {
    root.querySelectorAll(".set-tile").forEach(function (tile) {
      function open() { App.navigate("/set/" + tile.getAttribute("data-id")); }
      tile.addEventListener("click", open);
      tile.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });
    App.ui.staggerTiles(root, ".set-tile");
  }

  /* Fill every tile's progress line: "you own X of Y" + a slim bar. X is
   * the distinct owned card ids for the tile's appId ("ja-…" for Japanese
   * sets), straight from the shared session-cached index — so a filter
   * repaint is one cheap promise, never a new query. */
  function paintSetProgress(root) {
    if (!App.setProgress) return; // script tag missing: tiles still work
    App.setProgress.getOwnedBySet().then(function (map) {
      root.querySelectorAll(".set-progress-line").forEach(function (el) {
        if (!el.isConnected) return; // a newer paint() already replaced it
        var appId = el.getAttribute("data-sp");
        var total = el.getAttribute("data-sp-total");
        var owned = (map[appId] && map[appId].size) || 0;
        var pct = 0;
        if (total !== "?" && parseInt(total, 10) > 0) {
          pct = Math.min(100, Math.round((owned / parseInt(total, 10)) * 100));
        }
        el.innerHTML =
          '<span class="sp-text">you own ' + owned + " of " + App.esc(total) + "</span>" +
          '<div class="sp-bar" role="img" aria-label="You own ' + owned + " of " + App.esc(total) + ' cards in this set">' +
            '<div class="sp-fill" style="width:' + pct + '%"></div>' +
          "</div>";
      });
    }).catch(function (e) {
      console.warn("[VaultDex] set progress failed to load:", e && e.message);
    });
  }

  /* ---------------- card results ---------------- */

  function renderCardResults(body, query) {
    var state = { page: 1, total: 0, cards: [], loading: false, done: false };
    var resultsEl = body.querySelector("#results");
    var metaEl = body.querySelector("#result-meta");

    function updateMeta() {
      metaEl.innerHTML = state.total
        ? "<strong>" + state.total.toLocaleString() + "</strong> cards found"
        : "";
    }

    async function runSearch(append) {
      if (state.loading) return;
      state.loading = true;
      if (!append) {
        state.page = 1; state.cards = []; state.done = false;
        App.ui.skeletonGrid(resultsEl, 12);
        body.querySelector("#load-more-wrap").hidden = true;
      }
      try {
        var json = await App.tcg.searchCards({ name: query, page: state.page, pageSize: PAGE_SIZE });
        state.total = json.totalCount || 0;
        state.cards = state.cards.concat(json.data || []);
        state.done = (state.page * PAGE_SIZE) >= state.total;

        if (!state.cards.length) {
          resultsEl.innerHTML = App.ui.emptyState({
            title: "No cards found",
            body: "Try a different name — card search covers the English catalog."
          });
        } else {
          resultsEl.innerHTML = '<div class="card-grid">' + state.cards.map(tileHtml).join("") + "</div>";
          bindTiles(resultsEl);
        }
        updateMeta();
        body.querySelector("#load-more-wrap").hidden = state.done || !state.cards.length;
      } catch (e) {
        if (!append) {
          resultsEl.innerHTML = App.ui.emptyState({
            title: "Couldn't load cards",
            body: (e && e.message) || "Something went wrong.",
            actionHtml: '<button class="btn btn-ghost" id="retry">Try again</button>'
          });
          var rb = resultsEl.querySelector("#retry");
          if (rb) rb.addEventListener("click", function () { runSearch(false); });
        }
        App.handleApiError(e);
      } finally {
        state.loading = false;
      }
    }

    body.querySelector("#load-more").addEventListener("click", function () {
      state.page++; runSearch(true);
    });
    runSearch(false);
  }

  /* ---------------- set browser ---------------- */

  /* Sets for one language, grouped into era sections (newest era first),
   * with a set-specific search filter like pkmn.gg's. */
  function renderEraSections(body, sets, langLabel) {
    body.innerHTML =
      '<a class="back-link" href="/browse" id="lang-back">' + App.ui.icon("chevL") + " Languages</a>" +
      '<div class="search-row set-search-row">' +
        '<div class="field"><input id="set-q" type="search" placeholder="Search ' + App.esc(langLabel.toLowerCase()) + ' sets — try &quot;obsidian&quot;" autocomplete="off" aria-label="Search sets"></div>' +
      "</div>" +
      '<div id="era-wrap"></div>';

    var wrap = body.querySelector("#era-wrap");

    function paint(filter) {
      var q = (filter || "").trim().toLowerCase();
      var list = q
        ? sets.filter(function (s) { return (s.name || "").toLowerCase().indexOf(q) !== -1; })
        : sets;
      // Sets arrive pre-sorted: newest era first, newest set first.
      var groups = [];
      var bySeries = {};
      list.forEach(function (s) {
        var key = s.series || "Other";
        if (!bySeries[key]) { bySeries[key] = { series: key, sets: [] }; groups.push(bySeries[key]); }
        bySeries[key].sets.push(s);
      });

      if (!list.length) {
        wrap.innerHTML = App.ui.emptyState({
          title: "No sets found",
          body: "Try a different search — or clear it to see every " + App.esc(langLabel.toLowerCase()) + " set."
        });
        return;
      }
      wrap.innerHTML =
        '<div class="result-meta"><strong>' + list.length + "</strong> " + App.esc(langLabel) + " sets — pick one to check off the cards you own.</div>" +
        groups.map(function (g) {
          return (
            '<section class="era-section">' +
              '<h2 class="era-title">' + App.esc(g.series) + ' <span class="era-count">' + g.sets.length + "</span></h2>" +
              '<div class="set-grid">' + g.sets.map(setTileHtml).join("") + "</div>" +
            "</section>"
          );
        }).join("");
      bindSetTiles(wrap);
      paintSetProgress(wrap);
    }

    var debounced = App.ui.debounce(function () {
      paint(body.querySelector("#set-q").value);
    }, 250);
    body.querySelector("#set-q").addEventListener("input", debounced);
    var back = body.querySelector("#lang-back");
    if (back) back.addEventListener("click", function (e) {
      e.preventDefault();
      renderBrowseHome(body);
    });
    paint("");
  }

  /* Language picker: the default landing of the browse view. */
  function renderBrowseHome(body) {
    body.innerHTML = '<div class="spinner" role="status" aria-label="Loading sets"></div>';
    loadSets().then(function (sets) {
      var en = sets.filter(function (s) { return s.lang !== "ja"; });
      var ja = sets.filter(function (s) { return s.lang === "ja"; });
      body.innerHTML =
        '<div class="result-meta">Pick a language to browse its sets.</div>' +
        '<div class="lang-grid">' +
          '<div class="lang-card" data-lang="en" tabindex="0" role="button" aria-label="Browse English sets">' +
            '<div class="lang-name">English</div>' +
            '<div class="meta">' + en.length + " sets</div>" +
          "</div>" +
          '<div class="lang-card" data-lang="ja" tabindex="0" role="button" aria-label="Browse Japanese sets">' +
            '<div class="lang-name">日本語</div>' +
            '<div class="meta">' + ja.length + " sets</div>" +
          "</div>" +
        "</div>";
      body.querySelectorAll(".lang-card").forEach(function (card) {
        function pick() {
          var lang = card.getAttribute("data-lang");
          renderEraSections(body, lang === "ja" ? ja : en, lang === "ja" ? "Japanese" : "English");
        }
        card.addEventListener("click", pick);
        card.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
        });
      });
    }).catch(function (e) {
      body.innerHTML = App.ui.emptyState({ title: "Couldn't load sets", body: (e && e.message) || "Something went wrong." });
      App.handleApiError(e);
    });
  }

  /* ---------------- view entry ---------------- */
  App.views.browse = async function (root) {
    // The catalog is the owner's workspace — owner-only. Everyone else
    // gets the public read-only collection page.
    if (!App.auth.isOwner()) {
      root.innerHTML = App.ui.emptyState({
        title: "Owner only",
        body: "The card catalog is the owner's workspace — you're seeing their public collection instead.",
        actionHtml: '<a class="btn btn-primary" href="/collection">View collection</a>'
      });
      return;
    }
    root.innerHTML =
      '<div class="hero"><h1>Find your next <span class="hl">grail</span></h1>' +
      "<p>Search every Pokémon TCG card by name — or pick a language and browse full sets to check off the cards you own.</p></div>" +
      '<form id="card-search-form" class="search-row">' +
        '<div class="field"><input id="card-q" type="search" placeholder="Search cards by name — try &quot;charizard&quot;" autocomplete="off" aria-label="Search cards by name"></div>' +
        '<button class="btn btn-primary" type="submit">' + App.ui.icon("search") + " Search</button>" +
      "</form>" +
      '<div id="browse-body"></div>';

    var body = root.querySelector("#browse-body");
    var input = root.querySelector("#card-q");

    function showCardResults() {
      var q = input.value.trim();
      if (!q) { renderBrowseHome(body); return; }
      body.innerHTML =
        '<div class="result-meta" id="result-meta"></div>' +
        '<div id="results"></div>' +
        '<div class="load-more-wrap" id="load-more-wrap" hidden><button class="btn btn-ghost" id="load-more">Load more</button></div>';
      renderCardResults(body, q);
    }

    var debounced = App.ui.debounce(showCardResults, 450);
    input.addEventListener("input", function () {
      // Live results while typing; an empty field restores the set browser.
      if (!input.value.trim()) { renderBrowseHome(body); return; }
      debounced();
    });
    root.querySelector("#card-search-form").addEventListener("submit", function (e) {
      e.preventDefault();
      showCardResults();
    });

    renderBrowseHome(body);
  };
})();
