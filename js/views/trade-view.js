/* VaultDex — trade binder view (Feature 6): public listings page at /trade.
 *
 * Public for everyone (signed-in owner, signed-in non-owner, signed out).
 * Only the actual owner (App.auth.isOwner()) gets the per-tile steppers
 * that set trade_qty explicitly. No contact / trade-offer mechanics —
 * listings only.
 *
 * Hub layout mirrors the collection: a landing with "The full binder" plus
 * Browse by language / budget / set, each opening a filtered card grid.
 */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

  /* Shared: App.util.BUDGETS (js/util.js). */
  var BUDGETS = App.util.BUDGETS;

  /* Shared: App.util.langOf (js/util.js). */
  var langOf = App.util.langOf;
  // Trade budgets are per-copy prices — what a trader would pay for one card.
  function copyPrice(row) {
    return typeof row.market_price === "number" ? row.market_price : null;
  }
  function inBudget(row, b) {
    var v = copyPrice(row);
    if (v === null) return false;
    var lo = b.min === "" ? null : parseFloat(b.min);
    var hi = b.max === "" ? null : parseFloat(b.max);
    return (lo === null || v >= lo) && (hi === null || v <= hi);
  }

  // Hub card with card art — same split/hero treatment as the collection hub.
  function mediaCard(attrs, img, kicker, title, meta, hero) {
    if (hero) {
      return '<button type="button" class="hub-card hub-media hub-hero"' + attrs + ">" +
        (img ? '<span class="hub-bg" style="background-image:url(\'' + App.esc(img) + '\')"></span><span class="hub-shade"></span>' : "") +
        '<span class="hub-body">' +
          (kicker ? '<span class="hub-kicker">' + kicker + "</span>" : "") +
          '<span class="hub-title">' + title + "</span>" +
          '<span class="hub-meta">' + meta + "</span>" +
        "</span></button>";
    }
    return '<button type="button" class="hub-card hub-split"' + attrs + ">" +
      (img ? '<span class="hub-thumb" style="background-image:url(\'' + App.esc(img) + '\')"></span>' : "") +
      '<span class="hub-caption">' +
        (kicker ? '<span class="hub-kicker">' + kicker + "</span>" : "") +
        '<span class="hub-title">' + title + "</span>" +
        '<span class="hub-meta">' + meta + "</span>" +
      "</span></button>";
  }

  // Most valuable listing image from a set of rows — the face of a hub card.
  // Shared: App.util.topImage (js/util.js); trade budgets rank by per-copy
  // price times copies available.
  function topImage(list, used) {
    return App.util.topImage(list, used, function (r) {
      var v = copyPrice(r);
      return (v === null ? 0 : v) * App.trade.effectiveQty(r);
    });
  }

  /* Shared tile: App.ui.tileHtml (js/ui.js). */
  function tileHtml(row, isOwner) {
    var avail = App.trade.effectiveQty(row);
    // Defensive: grading columns may be added by a parallel feature.
    var grade = [row.grading_company, row.grade]
      .filter(function (x) { return x !== null && x !== undefined && x !== ""; })
      .map(App.esc).join(" ");
    var stepper = isOwner
      ? '<div class="trade-controls">' +
          '<div class="stepper trade-stepper" role="group" aria-label="Copies up for trade for ' + App.esc(row.card_name) + '">' +
            '<button type="button" data-act="tdec" aria-label="Offer one fewer copy of ' + App.esc(row.card_name) + '">' + App.ui.icon("minus") + "</button>" +
            '<span class="qty">×' + avail + "</span>" +
            '<button type="button" data-act="tinc" aria-label="Offer one more copy of ' + App.esc(row.card_name) + '">' + App.ui.icon("plus") + "</button>" +
          "</div>" +
        "</div>"
      : "";
    return App.ui.tileHtml(row, {
      cls: "trade-tile",
      dataRow: row.id,
      activatable: false,
      setHtml: App.esc(row.set_name || ""),
      priceHtml:
        '<span class="price-badge">' + App.ui.money(row.market_price, row.price_currency) + "</span>" +
        '<span class="trade-chips"><span class="variant-chip">' + App.esc(row.variant) + "</span>" +
        (grade ? '<span class="grade-badge">' + grade + "</span>" : "") + "</span>",
      postPrice: '<div class="avail-note">×' + avail + " available</div>" + stepper
    });
  }

  /* Sets with trade listings in one language, newest era first (catalog
   * order). Sets missing from the catalog still appear under "Other". */
  async function tradeSetRows(lang, rows) {
    var counts = {}, nameById = {};
    rows.forEach(function (r) {
      if (!r.set_id) return;
      var l = langOf(r);
      if (lang === "ja" ? l !== "ja" : l === "ja") return;
      counts[r.set_id] = (counts[r.set_id] || 0) + 1;
      if (r.set_name && !nameById[r.set_id]) nameById[r.set_id] = r.set_name;
    });
    var catalog = [];
    try { catalog = await App.tcg.getSets(); } catch (e) { /* offline: row data only */ }
    var byAppId = {}, order = {};
    catalog.forEach(function (s, i) { byAppId[s.appId] = s; order[s.appId] = i; });
    var out = [];
    Object.keys(counts).forEach(function (appId) {
      var s = byAppId[appId];
      var l = s ? s.lang : App.util.langOf(appId);
      if (lang === "ja" ? l !== "ja" : l === "ja") return;
      out.push({
        set: s || { appId: appId, name: nameById[appId] || appId, series: "Other", images: {} },
        listed: counts[appId],
        setName: nameById[appId] || (s && s.name) || appId
      });
    });
    out.sort(function (a, b) {
      var oa = order[a.set.appId], ob = order[b.set.appId];
      if (oa === undefined) return 1;
      if (ob === undefined) return -1;
      return oa - ob;
    });
    return out;
  }

  // Same tile look as Browse / the collection's set tiles, but the count is
  // trade listings, not set-completion progress.
  function setTile(s, listed, setName) {
    var simg = s.images || {};
    var img = simg.logo || simg.symbol;
    var cls = !simg.logo && img ? ' class="symbol"' : "";
    return (
      '<div class="set-tile" data-trade-set="' + App.esc(setName) + '" tabindex="0" role="button"' +
        ' aria-label="Show trade listings from ' + App.esc(s.name) + '">' +
        '<div class="logo">' + (img ? '<img loading="lazy" src="' + App.esc(img) + '" alt=""' + cls + ">" : "") + "</div>" +
        "<h3>" + App.esc(s.name) + "</h3>" +
        '<div class="meta">' + listed + (listed === 1 ? " card listed" : " cards listed") + "</div>" +
      "</div>"
    );
  }

  App.views.trade = async function (root) {
    if (!App.isConfigured()) {
      root.innerHTML = App.ui.emptyState({
        title: "Supabase isn't configured",
        body: "Add your Supabase URL and anon key to js/config.js (see SETUP.md), then reload."
      });
      return;
    }

    var isOwner = App.auth.isOwner();
    App.ui.skeletonGrid(root);

    var rows;
    try {
      rows = await App.trade.listForTrade();
    } catch (e) {
      App.handleApiError(e);
      root.innerHTML = App.ui.emptyState({
        title: "Couldn't load the trade binder",
        body: "Please try again in a moment."
      });
      return;
    }
    if (!rows) rows = [];

    var curSection = null; // null | "language" | "budget" | "set"
    var setLang = null;    // "en" | "ja" — "Browse by set" step 2
    var setList = null;    // stashed set rows for the search box
    var setListLabel = "";
    var curView = { name: "hub" }; // or { name: "grid", title, pred }

    // Value-first, consistent with the collection's default sort.
    function sorted(list) {
      return list.slice().sort(function (a, b) {
        var pa = copyPrice(a), pb = copyPrice(b);
        pa = pa === null ? -1 : pa;
        pb = pb === null ? -1 : pb;
        if (pb !== pa) return pb - pa;
        return String(a.card_name || "").localeCompare(String(b.card_name || ""));
      });
    }

    function totalCopies(list) {
      return list.reduce(function (n, r) { return n + App.trade.effectiveQty(r); }, 0);
    }

    function introHtml() {
      return '<div class="hub-intro">' +
        '<h1 class="hub-page-title">Trade Binder</h1>' +
        '<p class="hub-page-sub">' + rows.length.toLocaleString() + (rows.length === 1 ? " card" : " cards") +
          " listed · " + totalCopies(rows).toLocaleString() + " copies available</p>" +
        "</div>" +
        '<div class="trade-philosophy">' +
        '<span class="trade-philosophy-ico" aria-hidden="true">🤝</span>' +
        "<span>I always trade at face value — especially to help people complete their personal collections.</span>" +
        "</div>";
    }

    function ownerNote() {
      return isOwner
        ? '<p class="trade-auto-note">' + App.ui.icon("tag") +
          "<span>Cards with 2+ copies automatically list the surplus — adjust or exclude them here.</span></p>"
        : "";
    }

    function counts() {
      var c = { en: 0, ja: 0, budgets: [0, 0, 0, 0], sets: {} };
      rows.forEach(function (r) {
        c[langOf(r)]++;
        BUDGETS.forEach(function (b, i) { if (inBudget(r, b)) c.budgets[i]++; });
        if (r.set_name) c.sets[r.set_name] = (c.sets[r.set_name] || 0) + 1;
      });
      return c;
    }

    /* ---------------- hub ---------------- */
    async function showHub(section) {
      curSection = section || null;
      curView = { name: "hub" };
      var html = introHtml() + ownerNote();
      if (!rows.length) {
        root.innerHTML = html + App.ui.emptyState({
          title: "Nothing listed for trade yet",
          body: "Cards with 2+ copies appear here automatically."
        });
        return;
      }
      var c = counts();
      var used = {};
      var isEn = function (r) { return langOf(r) === "en"; };
      var isJa = function (r) { return langOf(r) === "ja"; };

      html += '<div class="hub">';
      if (!curSection) {
        var face = topImage(rows, used);
        html += mediaCard(' data-trade="all"', face, "The full case", "The full binder",
          rows.length.toLocaleString() + (rows.length === 1 ? " card" : " cards") +
            " · " + totalCopies(rows).toLocaleString() + " copies", true);
        var jaTop = topImage(rows.filter(isJa), used) || topImage(rows, used);
        var midTop = topImage(rows.filter(function (r) { return inBudget(r, BUDGETS[1]); }), used)
          || topImage(rows.filter(function (r) { return inBudget(r, BUDGETS[2]); }), used)
          || topImage(rows, used);
        var topSetName = Object.keys(c.sets).sort(function (a, b) { return c.sets[b] - c.sets[a]; })[0];
        var setTop = (topSetName ? topImage(rows.filter(function (r) { return r.set_name === topSetName; }), used) : "")
          || topImage(rows, used);
        html +=
          '<div class="hub-row-3">' +
            mediaCard(' data-trade-section="language"', jaTop, null, "Browse by language", "English · 日本語") +
            mediaCard(' data-trade-section="budget"', midTop, null, "Browse by budget", "Under $10 · $100+") +
            mediaCard(' data-trade-section="set"', setTop, null, "Browse by set",
              Object.keys(c.sets).length + (Object.keys(c.sets).length === 1 ? " set" : " sets")) +
          "</div>";
      } else if (curSection === "language") {
        html += '<div class="view-bar"><button type="button" class="btn btn-ghost btn-sm" data-trade-hub>' +
          App.ui.icon("chev-l") + " All views</button>" +
          '<div class="view-title">Browse by language</div></div>' +
          '<div class="hub-row">' +
            mediaCard(' data-trade-lang="en"', topImage(rows.filter(isEn), used), null, "English", c.en + (c.en === 1 ? " card" : " cards")) +
            mediaCard(' data-trade-lang="ja"', topImage(rows.filter(isJa), used), null, "日本語", c.ja + (c.ja === 1 ? " card" : " cards")) +
          "</div>";
      } else if (curSection === "budget") {
        html += '<div class="view-bar"><button type="button" class="btn btn-ghost btn-sm" data-trade-hub>' +
          App.ui.icon("chev-l") + " All views</button>" +
          '<div class="view-title">Browse by budget</div></div>' +
          '<div class="hub-row">' +
            BUDGETS.map(function (b, i) {
              return mediaCard(' data-trade-budget="' + i + '"',
                topImage(rows.filter(function (r) { return inBudget(r, b); }), used),
                null, App.esc(b.label), c.budgets[i] + (c.budgets[i] === 1 ? " card" : " cards"));
            }).join("") +
          "</div>";
      } else {
        // "Browse by set": language picker first, then the sets with
        // listings in that language, newest era first.
        setList = null;
        var setLangLabel = setLang === "ja" ? "Japanese" : "English";
        html += '<div class="view-bar">' +
          (setLang
            ? '<button type="button" class="btn btn-ghost btn-sm" data-trade-setlang-back>' + App.ui.icon("chev-l") + " Languages</button>"
            : '<button type="button" class="btn btn-ghost btn-sm" data-trade-hub>' + App.ui.icon("chev-l") + " All views</button>") +
          '<div class="view-title">Browse by set' + (setLang ? " · " + setLangLabel : "") + "</div></div>";
        if (!setLang) {
          var enRows = await tradeSetRows("en", rows);
          var jaRows = await tradeSetRows("ja", rows);
          html += '<div class="result-meta">Pick a language to browse the sets in your trade binder.</div>' +
            '<div class="lang-grid">' +
            '<div class="lang-card" data-trade-setlang="en" tabindex="0" role="button" aria-label="Browse your English trade sets">' +
              '<div class="lang-name">English</div><div class="meta">' + enRows.length + (enRows.length === 1 ? " set" : " sets") + "</div></div>" +
            '<div class="lang-card" data-trade-setlang="ja" tabindex="0" role="button" aria-label="Browse your Japanese trade sets">' +
              '<div class="lang-name">日本語</div><div class="meta">' + jaRows.length + (jaRows.length === 1 ? " set" : " sets") + "</div></div>" +
            "</div>";
        } else {
          setList = await tradeSetRows(setLang, rows);
          setListLabel = setLangLabel;
          html += '<div class="search-row set-search-row">' +
            '<div class="field"><input id="t-set-q" type="search" placeholder="Search your ' + setLangLabel +
            ' trade sets" autocomplete="off" aria-label="Search your trade sets"></div></div>' +
            '<div id="t-era-wrap"></div>';
        }
      }
      root.innerHTML = html + "</div>";

      var hubBtn = root.querySelector("[data-trade-hub]");
      if (hubBtn) hubBtn.addEventListener("click", function () { showHub(null); });
      var all = root.querySelector('[data-trade="all"]');
      if (all) all.addEventListener("click", function () {
        showGrid("The full binder", function () { return true; });
      });
      root.querySelectorAll("[data-trade-section]").forEach(function (b) {
        b.addEventListener("click", function () {
          var sec = b.getAttribute("data-trade-section");
          if (sec === "set") setLang = null; // fresh entry starts at the language picker
          showHub(sec);
        });
      });
      root.querySelectorAll("[data-trade-lang]").forEach(function (b) {
        b.addEventListener("click", function () {
          var l = b.getAttribute("data-trade-lang");
          showGrid(l === "ja" ? "日本語" : "English", function (r) { return langOf(r) === l; });
        });
      });
      root.querySelectorAll("[data-trade-budget]").forEach(function (b) {
        b.addEventListener("click", function () {
          var bd = BUDGETS[parseInt(b.getAttribute("data-trade-budget"), 10)];
          showGrid(bd.label, function (r) { return inBudget(r, bd); });
        });
      });
      root.querySelectorAll("[data-trade-setlang]").forEach(function (b) {
        function pick() { setLang = b.getAttribute("data-trade-setlang"); showHub("set"); }
        b.addEventListener("click", pick);
        b.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      });
      var setLangBack = root.querySelector("[data-trade-setlang-back]");
      if (setLangBack) setLangBack.addEventListener("click", function () { setLang = null; showHub("set"); });

      // "Browse by set" step 2: era sections of sets with listings, with a name search.
      var eraWrap = root.querySelector("#t-era-wrap");
      if (eraWrap && setList) {
        var listRows = setList, listLabel = setListLabel;
        var bindSetTiles = function () {
          eraWrap.querySelectorAll("[data-trade-set]").forEach(function (t) {
            function go() {
              var sn = t.getAttribute("data-trade-set");
              showGrid(sn, function (r) { return r.set_name === sn; });
            }
            t.addEventListener("click", go);
            t.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
          });
        };
        var paintSets = function (filter) {
          var q = (filter || "").trim().toLowerCase();
          var list = q
            ? listRows.filter(function (x) { return (x.set.name || "").toLowerCase().indexOf(q) !== -1; })
            : listRows;
          var groups = [], bySeries = {};
          list.forEach(function (x) {
            var key = x.set.series || "Other";
            if (!bySeries[key]) { bySeries[key] = { series: key, rows: [] }; groups.push(bySeries[key]); }
            bySeries[key].rows.push(x);
          });
          if (!list.length) {
            eraWrap.innerHTML = App.ui.emptyState({ title: "No sets found", body: "Try a different search." });
            return;
          }
          eraWrap.innerHTML =
            '<div class="result-meta"><strong>' + list.length + "</strong> " + App.esc(listLabel) +
            " sets in your trade binder — pick one to see its listings.</div>" +
            groups.map(function (g) {
              return '<section class="era-section"><h2 class="era-title">' + App.esc(g.series) +
                ' <span class="era-count">' + g.rows.length + "</span></h2>" +
                '<div class="set-grid">' +
                g.rows.map(function (x) { return setTile(x.set, x.listed, x.setName); }).join("") +
                "</div></section>";
            }).join("");
          bindSetTiles();
        };
        var setQ = root.querySelector("#t-set-q");
        if (setQ) setQ.addEventListener("input", App.ui.debounce(function () { paintSets(setQ.value); }, 250));
        paintSets("");
      }
      window.scrollTo(0, 0);
    }

    /* ---------------- filtered grid ---------------- */
    function showGrid(title, pred) {
      curView = { name: "grid", title: title, pred: pred };
      var list = sorted(rows.filter(pred));
      var html = '<div class="view-bar">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-trade-back>' + App.ui.icon("chev-l") + " All views</button>" +
          '<div class="view-title">' + App.esc(title) + "</div></div>";
      if (!list.length) {
        root.innerHTML = html + App.ui.emptyState({
          title: "No trade listings here",
          body: "Try another view."
        });
      } else {
        html += '<div class="result-meta">' + list.length.toLocaleString() + (list.length === 1 ? " card" : " cards") +
          " · " + totalCopies(list).toLocaleString() + " copies available</div>" +
          '<div class="card-grid trade-grid">' +
          list.map(function (r) { return tileHtml(r, isOwner); }).join("") + "</div>";
        root.innerHTML = html;
      }
      var back = root.querySelector("[data-trade-back]");
      if (back) back.addEventListener("click", function () { showHub(curSection); });
      wireGrid();
      window.scrollTo(0, 0);
    }

    function wireGrid() {
      var grid = root.querySelector(".trade-grid");
      if (!grid) return;
      grid.querySelectorAll(".card-tile").forEach(function (tile) {
        tile.querySelectorAll("[data-act]").forEach(function (btn) {
          btn.addEventListener("click", async function (e) {
            e.stopPropagation();
            if (!isOwner) return;
            var rowId = tile.getAttribute("data-row");
            var row = rows.filter(function (x) { return x.id === rowId; })[0];
            if (!row) return;
            var cur = App.trade.effectiveQty(row);
            var next = btn.getAttribute("data-act") === "tinc" ? cur + 1 : cur - 1;
            if (next < 0) next = 0;
            // You can't offer more copies than you own.
            if (next > row.quantity) next = row.quantity;
            btn.disabled = true;
            try {
              await App.trade.setTradeQty(rowId, next);
              row.trade_qty = next; // keep the local copy in sync
              if (next === 0) rows = rows.filter(function (x) { return x.id !== rowId; });
              if (curView.name === "grid") showGrid(curView.title, curView.pred);
              else showHub(curSection);
              if (next === 0) App.ui.toast('Removed "' + row.card_name + '" from the trade binder.');
              else App.ui.toast('Now offering ×' + next + ' "' + row.card_name + '" for trade.');
            } catch (err) {
              App.handleApiError(err);
              btn.disabled = false;
            }
          });
        });
      });
      App.ui.staggerTiles(grid, ".card-tile");
    }

    showHub(null);
  };
})();
