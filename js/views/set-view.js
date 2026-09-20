/* VaultDex — set view: visual grid of every card in a set with per-variant
 * owned checkboxes (pkmn.gg-inspired). Each card tile shows one small
 * checkbox per actual printing (Normal, Poké Ball, Energy Symbol, Holo, …)
 * in the bottom-right corner of the card art, exactly like pkmn.gg. The variant
 * list comes free from TCGdex print data (local snapshot when available);
 * checking a box lazily matches the exact PkmnPrices record for Near Mint
 * pricing — a few credits per check, never a bulk scan. Unchecking removes
 * it. The set header shows X/Y collected progress. Tapping a tile (outside
 * the checkboxes) opens the card detail modal. Login required for writes. */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

  var PAGE_SIZE = 48;

  /* Checkbox variants for a card: real printings from TCGdex once details
   * (or the snapshot) provide them; a single "unknown" placeholder before. */
  function boxesFor(card) {
    var pv = App.tcg.printVariants(card);
    if (pv.length) return pv;
    return [{ key: "unknown", label: "Standard", vlabel: "unknown", pkmnLabel: null, priceVariant: "normal" }];
  }
  function displayName(card, v) {
    if (!v || v.vlabel === "normal" || v.vlabel === "unknown") return card.name;
    return card.name + " (" + v.label + ")";
  }
  function checksHtml(card, boxes) {
    return boxes.map(function (v) {
      return '<button type="button" class="variant-check vc-' + App.esc(v.vlabel || "unknown") + '" aria-pressed="false" title="' +
        App.esc(v.label) + '" aria-label="Mark ' + App.esc(displayName(card, v)) + ' as owned">' +
        App.ui.icon("check") + "</button>";
    }).join("");
  }

  App.views.setView = async function (root, setId) {
    // Set pages are part of the owner's workspace — owner-only.
    if (!App.auth.isOwner()) {
      root.innerHTML = App.ui.emptyState({
        title: "Owner only",
        body: "Set checklists are the owner's workspace — you're seeing their public collection instead.",
        actionHtml: '<a class="btn btn-primary" href="/collection">View collection</a>'
      });
      return;
    }
    var page = 1;
    var totalPages = 1;
    var totalCount = 0;
    var progressTotal = 0; // full-set card count for the progress bar — never narrowed by search/rarity filters
    var query = ""; // in-set card search text
    var sort = "number"; // number | priceDesc | priceAsc | name
    var rarity = ""; // "" = all rarities, else exact rarity label
    var owned = {}; // cardId -> [{ id, vlabel }] (this set)
    var setInfo = null;
    var toggling = {}; // cardId|vlabel -> true while a toggle is in flight
    // App-level set ids prefix Japanese sets with "ja-". Collection rows
    // store set_id in exactly this appId style ("ja-M4"), so the page URL
    // id matches rows directly — for both languages.
    var setLang = App.tcg.parseSetId(setId).lang;

    root.innerHTML =
      '<a class="back-link set-back" href="/browse">' + App.ui.icon("chev-l") + " Back to browse</a>" +
      '<div id="set-head"></div>' +
      '<div class="collect-progress" id="set-progress" hidden>' +
        '<div class="cp-top"><strong id="cp-count"></strong><span id="cp-pct"></span></div>' +
        '<div class="cp-bar"><div class="cp-fill" id="cp-fill"></div></div>' +
      "</div>" +
      '<div class="search-row set-card-search">' +
        '<div class="field grow"><input id="set-card-q" type="search" placeholder="Search cards in this set — try &quot;pikachu&quot;" autocomplete="off" aria-label="Search cards in this set"></div>' +
        '<div class="field shrink"><select id="set-sort" aria-label="Sort cards">' +
          '<option value="number">Set number</option>' +
          '<option value="priceDesc">Price: high to low</option>' +
          '<option value="priceAsc">Price: low to high</option>' +
          '<option value="name">Name A–Z</option>' +
        "</select></div>" +
        '<div class="field shrink"><select id="set-rarity" aria-label="Filter by rarity"><option value="">All rarities</option></select></div>' +
      "</div>" +
      '<div class="variant-legend" aria-label="Checkbox colors by variant">' +
        '<span><i class="sw vc-normal"></i>Normal</span>' +
        '<span><i class="sw vc-pokeball"></i>Poké Ball</span>' +
        '<span><i class="sw vc-energy"></i>Energy Symbol</span>' +
        '<span><i class="sw vc-holo"></i>Holo</span>' +
        '<span><i class="sw vc-reverse"></i>Reverse Holo</span>' +
      "</div>" +
      '<div id="set-grid-wrap"></div>' +
      '<div class="pagination" id="set-pagination" hidden>' +
        '<button class="btn btn-ghost btn-sm" id="pg-prev">' + App.ui.icon("chev-l") + " Prev</button>" +
        '<span class="page-info" id="pg-info"></span>' +
        '<button class="btn btn-ghost btn-sm" id="pg-next">Next ' + App.ui.icon("chev-r") + "</button>" +
      "</div>";

    var headEl = root.querySelector("#set-head");
    var gridWrap = root.querySelector("#set-grid-wrap");
    var progEl = root.querySelector("#set-progress");

    /* The set page's X: distinct owned card ids for this set, from the
     * shared session-cached index — the same source as the browse tiles,
     * so both always agree. Falls back to the tile-level `owned` map when
     * the shared module hasn't loaded. */
    var spMap = null;
    function ownedCount() {
      var set = spMap && spMap[setId];
      if (set) return set.size;
      return Object.keys(owned).filter(function (k) { return (owned[k] || []).length > 0; }).length;
    }

    function updateProgress() {
      var n = ownedCount();
      if (!progressTotal) { progEl.hidden = true; return; }
      progEl.hidden = false;
      var pct = Math.round((n / progressTotal) * 100);
      root.querySelector("#cp-count").textContent = "you own " + n + " of " + progressTotal;
      root.querySelector("#cp-pct").textContent = pct + "%";
      root.querySelector("#cp-fill").style.width = pct + "%";
    }

    /* (Re)load the shared owned-by-set index and repaint the header.
     * Concurrent calls share one query via getOwnedBySet's in-flight
     * promise, so a checkbox toggle + the collection:changed refresh
     * never double-fetch. */
    async function loadProgress() {
      if (App.setProgress) {
        try { spMap = await App.setProgress.getOwnedBySet(); }
        catch { /* fallback counting from `owned` keeps working */ }
      }
      updateProgress();
    }

    /* Is one checkbox lit? A row matches its own variant label; on a
     * single-printing card (or before details load) any row counts.
     * matchRows lives in App.util now (hoisted from here so the
     * checkbox-bug logic can be unit-tested); behavior is unchanged. */
    function boxChecked(cardId, box, boxes) {
      return App.util.matchRows(owned[cardId], box, boxes).length > 0;
    }

    /* Sync every checkbox on a tile (and the tile's owned ring) with `owned`. */
    function paintTile(tile) {
      var cardId = tile._cardId;
      var boxes = tile._boxes || [];
      var btns = tile.querySelectorAll(".variant-check");
      var anyOwned = false;
      for (var i = 0; i < btns.length; i++) {
        var on = boxChecked(cardId, boxes[i], boxes);
        if (on) anyOwned = true;
        btns[i].setAttribute("aria-pressed", String(on));
      }
      tile.classList.toggle("owned", anyOwned);
      paintQtyBadge(tile, cardId);
    }

    /* Total owned copies across every variant row for one card. */
    function tileQty(cardId) {
      return (owned[cardId] || []).reduce(function (n, r) {
        return n + (r.qty || 0);
      }, 0);
    }

    /* Owned-count badge (top-right, the same .qty-badge the collection
     * grid uses). Painted from the tile-level `owned` map, so checkbox
     * toggles update it immediately with no extra query. */
    function paintQtyBadge(tile, cardId) {
      var n = tileQty(cardId);
      var badge = tile.querySelector(".qty-badge");
      if (n > 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "qty-badge";
          badge.setAttribute("aria-label", "Owned copies");
          tile.insertBefore(badge, tile.firstChild);
        }
        badge.textContent = "×" + n;
        badge.setAttribute("aria-label", n + (n === 1 ? " copy" : " copies") + " in your collection");
      } else if (badge) {
        badge.remove();
      }
    }

    /* Which collection rows (ids + variant labels + quantities) the user
     * owns for one card. */
    async function refetchOwnedRows(u, cardId) {
      var res = await App.sb
        .from("collection_items")
        .select("id,variant,quantity")
        .eq("user_id", u.id)
        .eq("card_id", cardId);
      if (res.error) throw res.error;
      return (res.data || []).map(function (r) {
        return { id: r.id, vlabel: App.tcg.normVLabel(r.variant), qty: r.quantity || 1 };
      });
    }

    /* Toggle one variant checkbox. The variant list comes free from TCGdex
     * (or the local snapshot); only a check costs PkmnPrices credits —
     * one lazy exact-record match per check, never a bulk scan. Each box
     * adds/removes only its own variant; unchecking never touches siblings. */
    async function toggleVariant(card, box, tile, btn) {
      var key = card.id + "|" + box.vlabel;
      if (toggling[key]) return;
      var u = App.collection.needUser();
      if (!u) return; // prompts sign-in
      toggling[key] = true;
      btn.disabled = true;
      var rows = owned[card.id] || [];
      var match = App.util.matchRows(rows, box, tile._boxes || []);
      var was = match.length > 0;
      var name = displayName(card, box);
      // optimistic UI
      owned[card.id] = was
        ? rows.filter(function (r) { return match.indexOf(r) === -1; })
        : rows.concat([{ id: "pending", vlabel: box.vlabel, qty: 1 }]);
      paintTile(tile);
      try {
        if (was) {
          for (var i = 0; i < match.length; i++) {
            if (match[i].id !== "pending") await App.collection.remove(match[i].id);
          }
          App.ui.toast("Removed " + name + " from your collection.", "success");
        } else if (box.vlabel === "unknown") {
          // Details not loaded yet: add with the card's default variant.
          await App.collection.addItem(card, App.collection.defaultVariant(card), 1);
          App.ui.toast("Added " + name + " to your collection.", "success");
        } else {
          var m = null;
          try {
            m = await App.pkmn.findVariantPrice({
              name: card.name,
              setName: card.set && card.set.name,
              number: card.number,
              lang: (card.set && card.set.lang) || "en",
              pkmnLabel: box.pkmnLabel,
              priceVariant: box.priceVariant
            });
          } catch (e) {
            console.warn("[VaultDex] PkmnPrices variant match failed:", e && e.message);
          }
          // Pricing resolves quietly in the background: a miss here still
          // saves the card, and the next price refresh fills it in.
          await App.collection.addItem(card, box.label, 1, {
            pkmnId: m ? m.pkmnId : null,
            label: box.label,
            resolved: m // priced already; rowFromCard reuses it (no second lookup)
          });
          App.ui.toast("Added " + name + " to your collection.", "success");
        }
        owned[card.id] = await refetchOwnedRows(u, card.id);
        paintTile(tile);
        await loadProgress();
      } catch (e) {
        // roll back the optimistic toggle
        owned[card.id] = rows;
        paintTile(tile);
        App.handleApiError(e);
      } finally {
        toggling[key] = false;
        btn.disabled = false;
      }
    }

    /* Shared tile: App.ui.tileHtml (js/ui.js). */
    function renderGrid(cards) {
      gridWrap.innerHTML = '<div class="card-grid">' + cards.map(function (c) {
        var market = App.tcg.marketOf(c);
        return App.ui.tileHtml(c, {
          dataId: c.id,
          img: c.images && c.images.small,
          artExtra:
            '<div class="select-ring"></div>' +
            '<div class="variant-checks">' + checksHtml(c, boxesFor(c)) + "</div>",
          setHtml: "#" + App.esc(c.number || "?") + (c.rarity ? " · " + App.esc(c.rarity) : ""),
          priceHtml: '<span class="price-badge">' + App.ui.money(market, c.priceCurrency) + "</span>"
        });
      }).join("") + "</div>";

      gridWrap.querySelectorAll(".card-tile").forEach(function (tile, i) {
        var card = cards[i];
        tile._card = card;
        tile._cardId = card.id;
        tile._boxes = boxesFor(card);
        function open() { App.openCardModal(tile.getAttribute("data-id"), setLang, null, tile.querySelector(".art") || tile); }
        tile.addEventListener("click", open);
        tile.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
        });
        tile.querySelectorAll(".variant-check").forEach(function (btn, bi) {
          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            toggleVariant(tile._card, tile._boxes[bi], tile, btn);
          });
          // don't let the tile's keydown re-trigger when a checkbox has focus
          btn.addEventListener("keydown", function (e) { e.stopPropagation(); });
        });
        paintTile(tile);
      });
      App.ui.staggerTiles(gridWrap, ".card-tile");
    }

    /* Fill in rarity + market price + full variant checkboxes on each tile
     * once card details arrive. Snapshot cards already carry details, so
     * this is a no-op for them; for live cards it runs in the background so
     * the grid paints instantly. Guarded by page token so a stale fetch
     * can't scribble on a newer page. */
    async function enrichTiles(cards, forPage) {
      var needy = cards.filter(function (c) {
        return !c.variants_detailed || !c.variants_detailed.length;
      });
      if (!needy.length) return;
      var ids = needy.map(function (c) { return c.id; });
      var details;
      try {
        details = await App.tcg.getDetails(ids, 6, setLang);
      } catch { return; }
      if (forPage !== page) return;
      details.forEach(function (d) {
        if (!d) return;
        var tile = gridWrap.querySelector('.card-tile[data-id="' + d.id + '"]');
        if (!tile) return;
        tile._card = d; // richer card for checkbox adds + modal
        tile._boxes = boxesFor(d);
        var checks = tile.querySelector(".variant-checks");
        if (checks) {
          var bi = 0;
          checks.innerHTML = checksHtml(d, tile._boxes);
          checks.querySelectorAll(".variant-check").forEach(function (btn) {
            var idx = bi++;
            btn.addEventListener("click", function (e) {
              e.stopPropagation();
              toggleVariant(tile._card, tile._boxes[idx], tile, btn);
            });
            btn.addEventListener("keydown", function (e) { e.stopPropagation(); });
          });
        }
        paintTile(tile);
        var setLine = tile.querySelector(".set");
        if (setLine) setLine.textContent = "#" + (d.number || "?") + (d.rarity ? " · " + d.rarity : "");
        var badge = tile.querySelector(".price-badge");
        if (badge) badge.textContent = App.ui.money(App.tcg.marketOf(d), d.priceCurrency);
      });
    }

    /* Never let one stalled query wedge the page: reject if it takes too
     * long. The owned-rows fetch is non-essential for first paint — the
     * grid renders with unchecked boxes and repaints when rows land. */
    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error("Timed out waiting for " + label)); }, ms);
        })
      ]);
    }

    async function loadOwned() {
      owned = {};
      var u = App.auth.user;
      if (!u) return;
      try {
        var res = await withTimeout(
          App.sb
            .from("collection_items")
            .select("id,card_id,variant,pkmn_id,quantity")
            .eq("user_id", u.id)
            .eq("set_id", setId), // appId style ("ja-M4"), as rows are stored
          20000, "owned rows"
        );
        if (res.error) throw res.error;
        var rows = res.data || [];
        // Paint checkboxes from the rows immediately. Rows added before
        // per-variant checkboxes carry no pkmn_id; mapping each to its
        // exact PkmnPrices record costs API calls per row, so the backfill
        // runs in the background and never blocks the grid — with 100+
        // unmapped rows it used to wedge checkbox painting for minutes.
        rows.forEach(function (r) {
          (owned[r.card_id] = owned[r.card_id] || []).push({
            id: r.id,
            vlabel: App.tcg.normVLabel(r.variant),
            qty: r.quantity || 1
          });
        });
        var missing = rows.filter(function (r) { return !r.pkmn_id; });
        if (missing.length && App.collection.backfillPkmnIds) {
          App.collection.backfillPkmnIds(missing).catch(function () { /* per-row errors already logged */ });
        }
      } catch {
        // owned state stays empty; checkboxes still work (toggle will surface errors)
      }
    }

    /* Re-read owned rows after the collection changed through another
     * path (e.g. the card modal's Add button), then repaint every tile
     * and the progress count. Targeted when we know the card, full
     * re-read otherwise. Idempotent, so our own checkbox toggles (which
     * already repaint optimistically) converge to the same state. */
    async function refreshOwned(cardId) {
      var u = App.auth.user;
      if (!u) return;
      try {
        if (cardId) {
          owned[cardId] = await refetchOwnedRows(u, cardId);
        } else {
          await loadOwned();
        }
      } catch { /* keep last known owned state */ }
      gridWrap.querySelectorAll(".card-tile").forEach(paintTile);
      await loadProgress();
    }

    async function loadPage() {      App.ui.skeletonGrid(gridWrap, 16);
      try {
        var json = await App.tcg.getSetCards(setId, page, PAGE_SIZE, { name: query, sort: sort, rarity: rarity });
        var cards = json.data || [];
        totalCount = json.totalCount || 0;
        // The progress bar tracks whole-set completion, so only an
        // unfiltered query may set its denominator (sort never changes it).
        if (!query && !rarity) progressTotal = totalCount;
        totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
        if (!cards.length && query) {
          gridWrap.innerHTML = App.ui.emptyState({
            title: "No cards match",
            body: "Nothing in this set matches “" + query + "” — try a different name or number."
          });
        } else {
          // Variant checkboxes come from the cards' own print data (free via
          // TCGdex / local snapshot); pricing is matched lazily per check.
          renderGrid(cards);
          enrichTiles(cards, page);
        }
        var pag = root.querySelector("#set-pagination");
        pag.hidden = totalPages <= 1;
        root.querySelector("#pg-info").textContent = "Page " + page + " of " + totalPages + " · " + totalCount + " cards";
        root.querySelector("#pg-prev").disabled = page <= 1;
        root.querySelector("#pg-next").disabled = page >= totalPages;
        updateProgress();
      } catch (e) {
        gridWrap.innerHTML = App.ui.emptyState({ title: "Couldn't load this set", body: (e && e.message) || "Something went wrong." });
        App.handleApiError(e);
      }
    }

    async function loadHead() {
      try {
        setInfo = await App.tcg.getSet(setId);
        var simg = setInfo.images || {};
        var himg = simg.logo || simg.symbol;
        var hcls = !simg.logo && himg ? ' class="symbol"' : "";
        headEl.innerHTML =
          '<div class="set-header">' +
            '<div class="logo">' + (himg ? '<img src="' + App.esc(himg) + '" alt="' + App.esc(setInfo.name) + ' logo"' + hcls + ">" : "") + "</div>" +
            "<div><h2>" + App.esc(setInfo.name) + "</h2>" +
            '<div class="meta">' + App.esc(setInfo.series || "") + (setInfo.releaseDate ? " · Released " + App.esc(setInfo.releaseDate) : "") + " · " + (setInfo.total || setInfo.printedTotal || "?") + " cards</div>" +
            '<div class="meta">Tap a tile for details — check a box to add that print to your collection.</div></div>' +
          "</div>";
      } catch {
        headEl.innerHTML = '<div class="set-header"><div><h2>Set</h2><div class="meta">Details unavailable.</div></div></div>';
      }
    }

    root.querySelector("#pg-prev").addEventListener("click", function () { if (page > 1) { page--; loadPage(); window.scrollTo(0, 0); } });
    root.querySelector("#pg-next").addEventListener("click", function () { if (page < totalPages) { page++; loadPage(); window.scrollTo(0, 0); } });

    // In-set card search: filters the set's cards by name or card number.
    var searchInput = root.querySelector("#set-card-q");
    var debouncedSearch = App.ui.debounce(function () {
      query = searchInput.value;
      page = 1;
      loadPage();
    }, 300);
    searchInput.addEventListener("input", debouncedSearch);

    // Sort + rarity filter: re-run the query from page 1.
    root.querySelector("#set-sort").addEventListener("change", function (e) {
      sort = e.target.value;
      page = 1;
      loadPage();
    });
    root.querySelector("#set-rarity").addEventListener("change", function (e) {
      rarity = e.target.value;
      page = 1;
      loadPage();
    });

    // Rarity options come from the set's own cards (order of first
    // appearance, so commons first); the filter stays "All rarities"
    // if the list can't be read.
    async function loadRarities() {
      try {
        var rars = await App.tcg.getSetRarities(setId);
        var sel = root.querySelector("#set-rarity");
        rars.forEach(function (r) {
          var o = document.createElement("option");
          o.value = r;
          o.textContent = r;
          sel.appendChild(o);
        });
      } catch { /* keep "All rarities" */ }
    }

    // One active subscription per set page: drop the previous render's so
    // stale closures don't refetch for a page that's gone.
    if (App._setViewUnsub) { try { App._setViewUnsub(); } catch { /* ignored */ } App._setViewUnsub = null; }
    App._setViewUnsub = App.on("collection:changed", function (ev) {
      refreshOwned(ev && ev.cardId);
    });

    /* The header, grid, and filters paint immediately and never wait on the
     * owned-rows query: a stalled request used to wedge the whole page on
     * a blank screen (filter chrome visible, but no header, no cards, and
     * no error). When owned rows land, tiles repaint with their checkboxes
     * and the progress count updates. */
    loadHead();
    loadRarities();
    loadPage();
    loadProgress(); // header count resolves once the shared index loads
    loadOwned().then(function () {
      gridWrap.querySelectorAll(".card-tile").forEach(paintTile);
      loadProgress();
    });
  };
})();
