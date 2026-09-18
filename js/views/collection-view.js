/* VaultDex — collection view: filtered grid, quantity management, price refresh. */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

  var PRICE_KEY = "vd_prices_updated";

  /* Shared: App.util.BUDGETS (js/util.js). */
  var BUDGETS = App.util.BUDGETS;

  /* Shared tile: App.ui.tileHtml (js/ui.js). */
  function tileHtml(item, readOnly) {
    var value = (item.market_price !== null && item.market_price !== undefined)
      ? Number(item.market_price) * item.quantity : null;
    /* Graded rows name the slab next to the variant chip. When the stored
     * price is the raw Near Mint fallback (no graded price ever landed),
     * the badge says so instead of implying a graded value. */
    var gradeBadge = item.grading_company
      ? '<span class="grade-badge">' + App.esc(item.grading_company) + " " + App.esc(item.grade || "") + "</span>"
      : "";
    var priceTitle = (item.grading_company && item.price_source !== "pkmnprices-graded")
      ? ' title="Near Mint raw price — graded price unavailable"' : "";
    /* Trade binder toggle state: trade-on (explicit), trade-auto (surplus
     * rule), trade-off (excluded/none). Defensive when js/trade.js is absent. */
    var tradeState = (App.trade && !readOnly) ? App.trade.tradeState(item) : "";
    var controls = readOnly ? "" :
        '<div class="tile-controls">' +
          '<div class="stepper" role="group" aria-label="Quantity for ' + App.esc(item.card_name) + '">' +
            '<button data-act="dec" aria-label="Decrease quantity">' + App.ui.icon("minus") + "</button>" +
            '<span class="qty">' + item.quantity + "</span>" +
            '<button data-act="inc" aria-label="Increase quantity">' + App.ui.icon("plus") + "</button>" +
          "</div>" +
          '<button class="icon-btn-sm" data-act="rm" aria-label="Remove ' + App.esc(item.card_name) + ' from collection">' + App.ui.icon("trash") + "</button>" +
          '<button class="icon-btn-sm trade-toggle ' + tradeState + '" data-act="trade" aria-label="Toggle trade listing for ' + App.esc(item.card_name) + '" title="List for trade">' + App.ui.icon("tag") + "</button>" +
        "</div>";
    return App.ui.tileHtml(item, {
      dataRow: item.id,
      dataCard: item.card_id,
      qty: item.quantity,
      activatable: false,
      setHtml: App.esc(item.set_name || ""),
      priceHtml:
        '<span class="price-badge"' + priceTitle + ">" + App.ui.money(value) + "</span>" +
        '<span class="price-chips">' + gradeBadge + '<span class="variant-chip">' + App.esc(item.variant) + "</span></span>",
      postPrice: controls
    });
  }

  App.views.collection = async function (root) {
    if (!App.isConfigured()) {
      root.innerHTML = App.ui.emptyState({
        title: "Supabase isn't configured",
        body: "Add your Supabase URL and anon key to js/config.js (see SETUP.md), then reload. You can still browse cards in the meantime.",
        actionHtml: '<a class="btn btn-ghost" href="/browse">Browse cards</a>'
      });
      return;
    }

    // Public read-only mode: anyone who isn't the signed-in owner sees
    // the owner's collection (stats + search + grid) but can't change anything.
    // Browsing the catalog and editing stay owner-only.
    var readOnly = !App.auth.isOwner();

    var items = [];
    var state = { q: "", artist: "", set: "", min: "", max: "", sort: "value", lang: "", limit: 0 };
    var GRID_PAGE = 120; /* tiles rendered per page — keeps the DOM light on big collections */

    function el(id) { return root.querySelector("#" + id); }

    // Collection language comes from the stored set id ("ja-…" = Japanese).
    // Shared: App.util.langOf (js/util.js).
    function rowValue(it) {
      return (it.market_price !== null && it.market_price !== undefined)
        ? Number(it.market_price) * it.quantity : null;
    }
    /* ---------------- stats ---------------- */
    function renderStats() {
      var statsEl = el("stats");
      if (!statsEl) return;
      var total = items.reduce(function (n, it) { return n + it.quantity; }, 0);
      var value = items.reduce(function (n, it) {
        var v = rowValue(it);
        return n + (v === null ? 0 : v);
      }, 0);
      statsEl.innerHTML =
        '<div class="stat"><div class="label">Total cards</div><div class="value" data-countup="' + total + '">' + total.toLocaleString() + "</div></div>" +
        '<div class="stat"><div class="label">Est. market value</div><div class="value" data-countup-money="' + value.toFixed(2) + '">' + App.ui.money(value) + "</div></div>";
      App.ui.bindCounters(statsEl);
    }


    /* ---------------- filtered grid ---------------- */
    function gridHtml() {
      return (
        '<div class="stats-row" id="stats"></div>' +
        '<div class="view-bar">' +
          '<button type="button" class="btn btn-ghost btn-sm" id="c-back">' + App.ui.icon("chev-l") + " Home</button>" +
          '<div class="view-title" id="c-view-title"></div>' +
          '<div class="view-links">' +
            '<a class="btn btn-ghost btn-sm" href="/movers">Price movers</a>' +
            (readOnly ? "" : '<a class="btn btn-ghost btn-sm" href="/wishlist">Wishlist</a>') +
          "</div>" +
        "</div>" +
        '<div class="toolbar">' +
          '<div class="field grow"><label for="c-q">Search</label><input id="c-q" type="search" placeholder="Search your collection…" autocomplete="off"></div>' +
          '<div class="filter-actions">' +
            '<button class="btn btn-ghost btn-sm" id="c-filter-toggle" aria-expanded="false" aria-controls="c-filters">' + App.ui.icon("sliders") + ' Filters <span class="filter-count" id="c-filter-count" hidden></span></button>' +
            (readOnly ? "" : '<button class="btn btn-ghost btn-sm" id="c-refresh" title="Refresh prices" aria-label="Refresh prices">' + App.ui.icon("refresh") + " Refresh prices</button>") +
          "</div>" +
          '<div class="updated-note" id="c-updated"></div>' +
        "</div>" +
        '<div class="lang-pills" id="c-lang-pills" role="group" aria-label="Filter collection by language"></div>' +
        '<div class="filter-panel" id="c-filters" hidden>' +
          '<div class="field"><label for="c-artist">Artist</label><input id="c-artist" type="text" placeholder="Artist name" autocomplete="off" list="c-artist-list"><datalist id="c-artist-list"></datalist></div>' +
          '<div class="field"><label for="c-set">Set</label><select id="c-set"><option value="">All sets</option></select></div>' +
          '<div class="field"><label>Price range</label><div class="price-presets" id="c-price-presets">' +
            '<button type="button" data-min="" data-max="">Any</button>' +
            '<button type="button" data-min="" data-max="10">Under $10</button>' +
            '<button type="button" data-min="10" data-max="50">$10–$50</button>' +
            '<button type="button" data-min="50" data-max="100">$50–$100</button>' +
            '<button type="button" data-min="100" data-max="">$100+</button>' +
          "</div>" + '<div class="value-range">' +
            '<input id="c-min" type="number" min="0" step="0.01" placeholder="Min" aria-label="Minimum value">' +
            "<span>–</span>" +
            '<input id="c-max" type="number" min="0" step="0.01" placeholder="Max" aria-label="Maximum value">' +
          "</div></div>" +
          '<div class="field"><label for="c-sort">Sort by</label><select id="c-sort">' +
            '<option value="value">Value (high → low)</option>' +
            '<option value="recent">Recently added</option>' +
            '<option value="name">Name (A–Z)</option>' +
            '<option value="set">Set</option>' +
          "</select></div>" +
          '<div class="filter-actions"><button class="btn btn-ghost btn-sm" id="c-clear">Clear filters</button></div>' +
        "</div>" +
        '<div class="result-meta" id="c-meta"></div>' +
        '<div id="c-grid"></div>'
      );
    }

    function viewTitle() {
      var parts = [];
      if (state.lang === "en") parts.push("English");
      else if (state.lang === "ja") parts.push("日本語");
      if (state.set) parts.push(state.set);
      if (state.min !== "" || state.max !== "") {
        var b = null;
        BUDGETS.forEach(function (x) { if (x.min === state.min && x.max === state.max) b = x; });
        if (b) parts.push(b.label);
        else if (state.min !== "" && state.max !== "") parts.push("$" + state.min + "–$" + state.max);
        else if (state.min !== "") parts.push("$" + state.min + "+");
        else parts.push("Under $" + state.max);
      }
      if (state.q.trim()) parts.push("\u201C" + state.q.trim() + "\u201D");
      return parts.length ? parts.join(" · ") : "All cards";
    }

    function filtered() {
      var q = state.q.trim().toLowerCase();
      var artist = state.artist.trim().toLowerCase();
      var min = state.min === "" ? null : parseFloat(state.min);
      var max = state.max === "" ? null : parseFloat(state.max);
      var list = items.filter(function (it) {
        if (q && (it.card_name || "").toLowerCase().indexOf(q) === -1) return false;
        if (artist && (it.artist || "").toLowerCase().indexOf(artist) === -1) return false;
        if (state.set && it.set_name !== state.set) return false;
        if (state.lang && App.util.langOf(it) !== state.lang) return false;
        var v = rowValue(it);
        if (min !== null && (v === null || v < min)) return false;
        if (max !== null && (v === null || v > max)) return false;
        return true;
      });
      var val = function (it) {
        var v = rowValue(it);
        return v === null ? -1 : v;
      };
      list.sort(function (a, b) {
        if (state.sort === "name") return (a.card_name || "").localeCompare(b.card_name || "");
        if (state.sort === "value") return val(b) - val(a);
        if (state.sort === "set") return ((a.set_name || "") + (a.card_name || "")).localeCompare((b.set_name || "") + (b.card_name || ""));
        return new Date(b.added_at) - new Date(a.added_at);
      });
      return list;
    }

    function renderGrid() {
      var gridEl = el("c-grid");
      if (!gridEl) return;
      var vt = el("c-view-title");
      if (vt) vt.textContent = viewTitle();
      var list = filtered();
      if (!state.limit || state.limit < GRID_PAGE) state.limit = GRID_PAGE;
      var shown = list.slice(0, state.limit);
      var remaining = list.length - shown.length;
      el("c-meta").innerHTML = "Showing <strong>" + shown.length + "</strong> of <strong>" + list.length + "</strong> cards" +
        (list.length !== items.length ? " <span style=\"color:var(--muted)\">(" + items.length + " total)</span>" : "") + ".";
      if (!list.length) {
        gridEl.innerHTML = App.ui.emptyState({
          title: items.length ? "No matches" : "The shelf is empty",
          body: items.length
            ? "Try loosening the filters."
            : (readOnly
                ? "This collection doesn't have any cards yet."
                : "Head to Browse to find cards — search by name, or open a set and bulk-add the ones you own."),
          actionHtml: (items.length || readOnly) ? "" : '<a class="btn btn-primary" href="/browse">Browse cards</a>'
        });
        return;
      }
      gridEl.innerHTML = '<div class="card-grid">' + shown.map(function (it) { return tileHtml(it, readOnly); }).join("") + "</div>" +
        (remaining > 0
          ? '<div style="text-align:center;margin:18px 0"><button class="btn btn-ghost" id="c-more">Show more (' + remaining + " remaining)</button></div>"
          : "");

      var moreBtn = el("c-more");
      if (moreBtn) moreBtn.addEventListener("click", function () { state.limit += GRID_PAGE; renderGrid(); });

      gridEl.querySelectorAll(".card-tile").forEach(function (tile) {
        tile.querySelector(".art").addEventListener("click", function () {
          var rowId = tile.getAttribute("data-row");
          var item = items.filter(function (x) { return x.id === rowId; })[0];
          var cid = tile.getAttribute("data-card");
          /* Japanese cards live under ja- set ids; the catalog lookup must
           * use the Japanese namespace or TCGdex returns 404. */
          var lang = (App.util.isJa(item) || App.util.isJa(cid)) ? "ja" : "en";
          App.openCardModal(cid, lang, item);
        });
        tile.querySelectorAll("[data-act]").forEach(function (btn) {
          btn.addEventListener("click", async function (e) {
            e.stopPropagation();
            var rowId = tile.getAttribute("data-row");
            var item = items.filter(function (x) { return x.id === rowId; })[0];
            if (!item) return;
            var act = btn.getAttribute("data-act");
            btn.disabled = true;
            try {
              if (act === "inc") { item.quantity++; await App.collection.setQuantity(rowId, item.quantity); }
              else if (act === "dec") {
                if (item.quantity <= 1) {
                  if (!window.confirm('Remove "' + item.card_name + '" from your collection?')) { btn.disabled = false; return; }
                }
                item.quantity--;
                await App.collection.setQuantity(rowId, item.quantity);
                if (item.quantity <= 0) items = items.filter(function (x) { return x.id !== rowId; });
              } else if (act === "rm") {
                if (!window.confirm('Remove "' + item.card_name + '" from your collection?')) { btn.disabled = false; return; }
                await App.collection.remove(rowId);
                items = items.filter(function (x) { return x.id !== rowId; });
              } else if (act === "trade") {
                // Trade binder toggle (Feature 6): list the card or pull it.
                if (!App.trade) { App.ui.toast("Trade binder isn't available right now.", "info"); btn.disabled = false; return; }
                var next = App.trade.effectiveQty(item) > 0 ? 0 : item.quantity;
                await App.trade.setTradeQty(item.id, next);
                item.trade_qty = next;
                App.ui.toast(next === 0
                  ? 'Removed "' + item.card_name + '" from the trade binder.'
                  : 'Listed ' + next + '× "' + item.card_name + '" for trade.', "success");
              }
              renderStats();
              renderLangPills();
              renderGrid();
            } catch (err) {
              App.handleApiError(err);
              btn.disabled = false;
            }
          });
        });
      });
      App.ui.staggerTiles(gridEl, ".card-tile");
    }

    function readFilters() {
      state.q = el("c-q").value;
      state.artist = el("c-artist").value;
      state.set = el("c-set").value;
      state.min = el("c-min").value;
      state.max = el("c-max").value;
      state.sort = el("c-sort").value;
      state.limit = GRID_PAGE; /* new filter set — start from the first page */
    }

    // Language quick pills: one-tap All / English / 日本語, always visible
    // and working for signed-out viewers too.
    function renderLangPills() {
      var pillsEl = el("c-lang-pills");
      if (!pillsEl) return;
      var counts = { en: 0, ja: 0 };
      items.forEach(function (it) { counts[App.util.langOf(it)]++; });
      var defs = [
        { v: "", label: "All cards", n: items.length },
        { v: "en", label: "English", n: counts.en },
        { v: "ja", label: "日本語", n: counts.ja }
      ];
      pillsEl.innerHTML = defs.map(function (d) {
        return '<button type="button" class="lang-pill' + (state.lang === d.v ? " active" : "") + '" data-lang="' + d.v + '">' +
          App.esc(d.label) + ' <span class="n">' + d.n + "</span></button>";
      }).join("");
      pillsEl.querySelectorAll(".lang-pill").forEach(function (b) {
        b.addEventListener("click", function () {
          state.lang = b.getAttribute("data-lang");
          renderLangPills();
          renderGrid();
        });
      });
    }

    // Price bucket presets: one tap fills the min/max range.
    function markPricePreset() {
      var presetsEl = el("c-price-presets");
      if (!presetsEl) return;
      var min = el("c-min").value, max = el("c-max").value;
      presetsEl.querySelectorAll("button").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-min") === min && b.getAttribute("data-max") === max);
      });
    }

    function updateFilterBadge() {
      var n = 0;
      if (state.artist.trim()) n++;
      if (state.set) n++;
      if (state.min !== "") n++;
      if (state.max !== "") n++;
      var filterCount = el("c-filter-count");
      if (!filterCount) return;
      filterCount.hidden = n === 0;
      filterCount.textContent = n ? "(" + n + ")" : "";
    }

    function updateTimestampNote() {
      var updatedEl = el("c-updated");
      if (!updatedEl) return;
      var ts = localStorage.getItem(PRICE_KEY);
      updatedEl.textContent = ts ? "Prices last updated " + App.ui.timeAgo(ts) + "." : "Prices update automatically when cards are added.";
    }

    function wireGrid() {
      var debounced = App.ui.debounce(function () { readFilters(); renderGrid(); updateFilterBadge(); markPricePreset(); }, 300);
      ["c-q", "c-artist", "c-min", "c-max"].forEach(function (id) {
        el(id).addEventListener("input", debounced);
      });
      ["c-set", "c-sort"].forEach(function (id) {
        el(id).addEventListener("change", function () { readFilters(); renderGrid(); updateFilterBadge(); });
      });

      el("c-back").addEventListener("click", function () { App.navigate("/"); });

      // Collapsible filter panel (pkmn.gg-style): search stays front and
      // center, the rest tucks behind a toggle with an active-filter count.
      var filterPanel = el("c-filters");
      var filterToggle = el("c-filter-toggle");
      filterToggle.addEventListener("click", function () {
        var open = filterPanel.hidden;
        filterPanel.hidden = !open;
        filterToggle.setAttribute("aria-expanded", open ? "true" : "false");
        filterToggle.classList.toggle("active", open);
      });

      el("c-price-presets").querySelectorAll("button").forEach(function (b) {
        b.addEventListener("click", function () {
          el("c-min").value = b.getAttribute("data-min");
          el("c-max").value = b.getAttribute("data-max");
          readFilters(); renderGrid(); updateFilterBadge(); markPricePreset();
        });
      });

      el("c-clear").addEventListener("click", function () {
        el("c-artist").value = "";
        el("c-min").value = "";
        el("c-max").value = "";
        el("c-set").value = "";
        el("c-sort").value = "value";
        state.lang = "";
        renderLangPills();
        readFilters(); renderGrid(); updateFilterBadge(); markPricePreset();
      });

      var refreshBtn = el("c-refresh");
      if (refreshBtn) refreshBtn.addEventListener("click", async function () {
        var btn = el("c-refresh");
        btn.disabled = true;
        var label = btn.innerHTML;
        try {
          var res = await App.collection.refreshPrices(function (done, total) {
            btn.innerHTML = "Updating " + done + "/" + total + "…";
          });
          if (res) {
            localStorage.setItem(PRICE_KEY, res.at);
            updateTimestampNote();
            App.ui.toast("Updated prices for " + res.updated + " card" + (res.updated === 1 ? "" : "s") + ".", "success");
            items = (await reloadItems()) || [];
            refreshViews();
          }
        } catch (e) {
          App.handleApiError(e);
        } finally {
          btn.disabled = false;
          btn.innerHTML = label;
        }
      });
    }

    function populateGridInputs() {
      var setCounts = {};
      var artistNames = {};
      items.forEach(function (it) {
        if (it.set_name) setCounts[it.set_name] = (setCounts[it.set_name] || 0) + 1;
        if (it.artist) artistNames[it.artist] = true;
      });
      el("c-set").innerHTML = '<option value="">All sets</option>' +
        Object.keys(setCounts).sort().map(function (n) {
          return '<option value="' + App.esc(n) + '">' + App.esc(n) + " (" + setCounts[n] + ")</option>";
        }).join("");
      el("c-artist-list").innerHTML =
        Object.keys(artistNames).sort().map(function (n) {
          return '<option value="' + App.esc(n) + '">';
        }).join("");
      el("c-q").value = state.q;
      el("c-artist").value = state.artist;
      el("c-set").value = state.set;
      el("c-min").value = state.min;
      el("c-max").value = state.max;
      el("c-sort").value = state.sort;
    }

    function showGrid(preset) {
      root.innerHTML = gridHtml();
      wireGrid();
      el("c-back").innerHTML = App.ui.icon("chev-l") + " Home";
      populateGridInputs();
      renderStats();
      renderLangPills();
      renderGrid();
      markPricePreset();
      updateFilterBadge();
      updateTimestampNote();
      if (preset && preset.openFilters) {
        var filterPanel = el("c-filters");
        var filterToggle = el("c-filter-toggle");
        filterPanel.hidden = false;
        filterToggle.setAttribute("aria-expanded", "true");
        filterToggle.classList.add("active");
      }
      window.scrollTo(0, 0);
    }

    // Re-render the grid (collection changed elsewhere, prices refreshed,
    // quantities edited).
    function refreshViews() {
      renderStats(); renderLangPills(); renderGrid();
    }

    function reloadItems() {
      return readOnly ? App.collection.listPublic() : App.collection.list();
    }

    // Daily auto-refresh (owner only): when the stored prices are older
    // than 24h, refresh them quietly in the background so visitors always
    // see fresh values. Signed-out visitors never trigger price fetches.
    async function autoRefreshPrices() {
      try {
        var updatedEl = el("c-updated");
        if (updatedEl) updatedEl.textContent = "Refreshing prices…";
        var res = await App.collection.refreshPrices();
        if (res) {
          localStorage.setItem(PRICE_KEY, res.at);
          items = (await reloadItems()) || [];
          refreshViews();
          updateTimestampNote();
          App.ui.toast("Prices refreshed.", "success");
        }
      } catch (e) {
        updateTimestampNote(); /* stay quiet; manual refresh still available */
      }
    }

    // load
    // Refresh when the collection changes through another path (e.g. the
    // card modal's Add button opened from a collection tile). One active
    // subscription per render; our own steppers already update locally and
    // this re-list simply converges to the same state.
    if (App._collectionUnsub) { try { App._collectionUnsub(); } catch (e) {} App._collectionUnsub = null; }
    App._collectionUnsub = App.on("collection:changed", async function () {
      try {
        items = (await reloadItems()) || [];
        refreshViews();
      } catch (e) { /* keep current view */ }
    });
    root.innerHTML = '<div class="stats-row"></div><div id="c-loading"></div>';
    App.ui.skeletonGrid(el("c-loading"), 6);
    try {
      items = (await reloadItems()) || [];
      showGrid();
      if (!readOnly && items.length) {
        // Refresh when any row is missing a price or is older than 24h —
        // not just when the newest price is stale. (The old newest-only
        // check meant ~1,500 unpriced Japanese rows never triggered a pass.)
        var cutoff = Date.now() - 24 * 60 * 60 * 1000;
        var needsRefresh = items.some(function (it) {
          var t = it.price_updated_at ? Date.parse(it.price_updated_at) : 0;
          return !t || t < cutoff;
        });
        if (needsRefresh) autoRefreshPrices();
      }
    } catch (e) {
      root.innerHTML = App.ui.emptyState({ title: "Couldn't load your collection", body: (e && e.message) || "Something went wrong." });
      App.handleApiError(e);
    }
  };
})();
