/* VaultDex — Binder Studio: owner-only binder page idea generator.
 *
 * Pick 1-3 anchor cards, choose a vibe + recipe + layout, and the
 * generator (js/binder.js) deals three 3x3 page ideas. Tap any pocket
 * to see why it's there, lock pockets you love, and reshuffle the rest.
 * Saved pages persist in localStorage (vd_binder_pages).
 */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

  var SAVED_KEY = "vd_binder_pages";
  var CTX = null;

  var RECIPES = [
    ["color", "Color story", "Nine cards that melt in one palette"],
    ["gradient", "Gradient", "A hue melt left to right"],
    ["evolution", "Evolution line", "The full family, stage by stage"],
    ["artist", "Artist spotlight", "One illustrator's best work"],
    ["species", "Species shrine", "Every printing of one Pokémon"],
    ["set", "Set showcase", "The era your anchor came from"]
  ];
  var LAYOUTS = [
    ["classic", "Classic", "Nine pockets, full bleed"],
    ["panorama", "Panorama", "Art-crop panorama across the bottom"],
    ["gallery", "Gallery wall", "Heroes up top, air below"]
  ];
  var HUES = [
    [null, "Auto", null],
    [0, "Ember", "#e3350d"],
    [30, "Amber", "#e8912d"],
    [55, "Gold", "#d9b62c"],
    [120, "Forest", "#3f9e4d"],
    [180, "Teal", "#2aa8a0"],
    [215, "Ocean", "#2a75bb"],
    [275, "Violet", "#8b5cf6"],
    [330, "Rose", "#e0559a"]
  ];
  var MOODS = [
    [null, "Auto"],
    ["vibrant", "Vibrant"],
    ["muted", "Muted"],
    ["dark", "Dark"],
    ["pastel", "Pastel"]
  ];

  /* ---------- generator context (cached) ---------- */

  function parseKey(k) {
    var i = String(k).indexOf(":");
    var lang = String(k).slice(0, i), id = String(k).slice(i + 1);
    var d = id.lastIndexOf("-");
    var sid = d > 0 ? id.slice(0, d) : id;
    return { lang: lang, id: id, appSetId: lang === "ja" ? "ja-" + sid : sid };
  }

  async function evoChain(slug) {
    var ck = "vd_evo_" + slug;
    try {
      var cached = localStorage.getItem(ck);
      if (cached) return JSON.parse(cached);
      var sp = await fetch("https://pokeapi.co/api/v2/pokemon-species/" + encodeURIComponent(slug))
        .then(function (r) { if (!r.ok) throw new Error("no species"); return r.json(); });
      var chain = await fetch(sp.evolution_chain.url).then(function (r) { return r.json(); });
      var out = [];
      (function walk(n) { out.push(n.species.name); (n.evolves_to || []).forEach(walk); })(chain.chain);
      try { localStorage.setItem(ck, JSON.stringify(out)); } catch { /* private mode */ }
      return out;
    } catch { return [slug]; }
  }

  async function getCtx() {
    if (CTX) return CTX;
    var results = await Promise.all([
      fetch("/data/card-colors.json").then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
      fetch("/data/binder-inserts.json").then(function (r) { return r.ok ? r.json() : { inserts: [] }; }).then(function (j) { return j.inserts || []; }).catch(function () { return []; }),
      fetch("/data/artist-cards.json").then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
      fetch("/data/species-printings.json").then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
      App.tcg.getIndex(),
      App.tcg.getSets(),
      App.collection.list().catch(function () { return []; })
    ]);
    var palettes = results[0], inserts = results[1], artistCards = results[2],
        speciesPrintings = results[3], index = results[4], sets = results[5], rows = results[6];
    var indexById = {};
    (index || []).forEach(function (e) { indexById[(e.lang || "en") + ":" + e.id] = e; });
    var setNames = {}, setRank = {};
    (sets || []).forEach(function (s) {
      setNames[s.appId] = s.name;
      setRank[s.appId] = s.eraRank != null ? s.eraRank : 999;
    });
    var ownedKeys = new Set();
    (rows || []).forEach(function (r) {
      var lang = App.util.isJa(r.set_id) ? "ja" : "en";
      ownedKeys.add(lang + ":" + r.card_id);
    });
    CTX = {
      palettes: palettes, inserts: inserts, artistCards: artistCards,
      speciesPrintings: speciesPrintings, indexById: indexById,
      setNames: setNames, setRank: setRank, ownedKeys: ownedKeys, rows: rows || [],
      parseKey: parseKey,
      keyOf: function (c) { return c.set.lang + ":" + c.id; },
      speciesSlug: function (n) { return App.species.slugForCardName(n); },
      getSetCards: function (appId) { return App.tcg.getSetCardList(appId); },
      evoChain: evoChain
    };
    return CTX;
  }

  /* ---------- saved pages ---------- */

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"); }
    catch { return []; }
  }
  function storeSaved(list) {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* private mode */ }
  }

  /* ---------- the view ---------- */

  App.views.binder = async function (root) {
    var S = {
      anchors: [null, null, null],
      hue: null, mood: null, recipe: "color", layout: "classic",
      ownedOnly: false, density: 70,
      pages: [], locks: [], sel: null, dealing: false,
      ctx: null, saved: loadSaved()
    };

    root.innerHTML =
      '<div class="page binder-page">' +
        '<div class="binder-head">' +
          '<h1 class="page-title">Binder Studio</h1>' +
          '<p class="page-sub">Deal yourself three binder page ideas from 1&ndash;3 anchor cards. ' +
          "Tap any pocket to see why it's there, lock the ones you love, reshuffle the rest.</p>" +
        "</div>" +
        '<div class="composer card" id="composer"></div>' +
        '<div id="bpages"></div>' +
        '<div id="bsaved"></div>' +
      "</div>";

    renderComposer();
    // Load the generator context in the background; anchor buttons unlock when ready.
    getCtx().then(function (ctx) {
      S.ctx = ctx;
      renderComposer();
    }).catch(function (e) {
      console.warn("[VaultDex] binder ctx failed:", e);
      App.ui.toast("Couldn't load the idea engine — try reloading.");
    });

    /* ----- composer ----- */

    function anchorSlot(i) {
      var a = S.anchors[i];
      if (a) {
        return '<div class="anchor-slot filled">' +
          '<img src="' + App.esc(a.card.images && a.card.images.small || "") + '" alt="' + App.esc(a.card.name) + '" loading="lazy">' +
          '<button class="anchor-x" data-anchor-x="' + i + '" aria-label="Remove anchor">' + App.ui.icon("x") + "</button>" +
          (a.owned ? '<span class="bown">In vault</span>' : "") +
        "</div>";
      }
      return '<button class="anchor-slot empty" data-anchor-pick="' + i + '"' + (S.ctx ? "" : " disabled") + ">" +
        '<span class="anchor-plus">' + App.ui.icon("plus") + "</span>" +
        '<span class="anchor-label">Anchor ' + (i + 1) + "</span>" +
      "</button>";
    }

    function renderComposer() {
      var el = root.querySelector("#composer");
      if (!el) return;
      var palCount = S.ctx ? Object.keys(S.ctx.palettes || {}).length : 0;
      el.innerHTML =
        '<div class="composer-sec">' +
          '<h3 class="composer-h">Anchors <span class="composer-hint">1&ndash;3 cards the page is built around</span></h3>' +
          '<div class="anchor-row">' + anchorSlot(0) + anchorSlot(1) + anchorSlot(2) + "</div>" +
        "</div>" +
        '<div class="composer-sec">' +
          '<h3 class="composer-h">Vibe</h3>' +
          '<div class="chip-row" data-group="hue">' +
            HUES.map(function (h) {
              var on = (S.hue === h[0]) ? " on" : "";
              var dot = h[2] ? '<span class="hue-dot" style="background:' + h[2] + '"></span>' : '<span class="hue-dot auto">A</span>';
              return '<button class="chip' + on + '" data-hue="' + (h[0] === null ? "" : h[0]) + '">' + dot + h[1] + "</button>";
            }).join("") +
          "</div>" +
          '<div class="chip-row" data-group="mood">' +
            MOODS.map(function (m) {
              return '<button class="chip' + (S.mood === m[0] ? " on" : "") + '" data-mood="' + (m[0] === null ? "" : m[0]) + '">' + m[1] + "</button>";
            }).join("") +
          "</div>" +
          (S.ctx && palCount < 100
            ? '<p class="composer-note">Color engine still warming up &mdash; palettes are computing in the background. Color recipes get sharper as it fills in.</p>'
            : "") +
        "</div>" +
        '<div class="composer-sec">' +
          '<h3 class="composer-h">Recipe</h3>' +
          '<div class="chip-row wrap" data-group="recipe">' +
            RECIPES.map(function (r) {
              return '<button class="chip recipe' + (S.recipe === r[0] ? " on" : "") + '" data-recipe="' + r[0] + '">' +
                "<b>" + r[1] + "</b><i>" + r[2] + "</i></button>";
            }).join("") +
          "</div>" +
        "</div>" +
        '<div class="composer-sec">' +
          '<h3 class="composer-h">Layout</h3>' +
          '<div class="chip-row wrap" data-group="layout">' +
            LAYOUTS.map(function (l) {
              return '<button class="chip recipe' + (S.layout === l[0] ? " on" : "") + '" data-layout="' + l[0] + '">' +
                "<b>" + l[1] + "</b><i>" + l[2] + "</i></button>";
            }).join("") +
          "</div>" +
        "</div>" +
        '<div class="composer-sec composer-opts">' +
          '<label class="check-line"><input type="checkbox" id="owned-only"' + (S.ownedOnly ? " checked" : "") + "> Only cards I own</label>" +
          '<label class="density-line">Density <span class="density-word">' + densityWord() + '</span>' +
            '<input type="range" id="density" min="0" max="100" step="5" value="' + S.density + '">' +
          "</label>" +
        "</div>" +
        '<button class="btn btn-primary btn-deal" id="deal-btn"' + (S.dealing || !S.ctx ? " disabled" : "") + ">" +
          (S.dealing ? "Dealing&hellip;" : "Deal me pages") +
        "</button>";

      el.querySelectorAll("[data-anchor-pick]").forEach(function (b) {
        b.addEventListener("click", function () { openPicker(parseInt(b.getAttribute("data-anchor-pick"), 10)); });
      });
      el.querySelectorAll("[data-anchor-x]").forEach(function (b) {
        b.addEventListener("click", function () {
          S.anchors[parseInt(b.getAttribute("data-anchor-x"), 10)] = null;
          renderComposer();
        });
      });
      el.querySelectorAll("[data-hue]").forEach(function (b) {
        b.addEventListener("click", function () {
          var v = b.getAttribute("data-hue");
          S.hue = v === "" ? null : parseInt(v, 10);
          renderComposer();
        });
      });
      el.querySelectorAll("[data-mood]").forEach(function (b) {
        b.addEventListener("click", function () {
          var v = b.getAttribute("data-mood");
          S.mood = v === "" ? null : v;
          renderComposer();
        });
      });
      el.querySelectorAll("[data-recipe]").forEach(function (b) {
        b.addEventListener("click", function () { S.recipe = b.getAttribute("data-recipe"); renderComposer(); });
      });
      el.querySelectorAll("[data-layout]").forEach(function (b) {
        b.addEventListener("click", function () { S.layout = b.getAttribute("data-layout"); renderComposer(); });
      });
      el.querySelector("#owned-only").addEventListener("change", function (e) { S.ownedOnly = e.target.checked; });
      el.querySelector("#density").addEventListener("input", function (e) {
        S.density = parseInt(e.target.value, 10);
        var w = el.querySelector(".density-word");
        if (w) w.textContent = densityWord();
      });
      el.querySelector("#deal-btn").addEventListener("click", function () { deal(null); });
    }

    function densityWord() {
      return S.density <= 30 ? "Airy" : S.density >= 70 ? "Packed" : "Balanced";
    }

    /* ----- anchor picker ----- */

    function openPicker(slotIdx) {
      var ctx = S.ctx;
      if (!ctx) return;
      var m = App.ui.openModal(
        '<h3 class="picker-title">Pick anchor ' + (slotIdx + 1) + "</h3>" +
        '<input class="picker-search" id="picker-q" type="search" placeholder="Search your vault & the catalog&hellip;" autocomplete="off">' +
        '<div class="picker-results" id="picker-results"><p class="picker-hint">Type at least 2 characters.</p></div>',
        { narrow: true }
      );
      var input = m.el.querySelector("#picker-q");
      var box = m.el.querySelector("#picker-results");
      var timer = null;
      input.focus();
      input.addEventListener("input", function () {
        clearTimeout(timer);
        var q = input.value.trim();
        if (q.length < 2) { box.innerHTML = '<p class="picker-hint">Type at least 2 characters.</p>'; return; }
        box.innerHTML = '<p class="picker-hint">Searching&hellip;</p>';
        timer = setTimeout(function () { runPickerSearch(q, box, m, slotIdx); }, 250);
      });
    }

    async function runPickerSearch(q, box, m, slotIdx) {
      var ctx = S.ctx;
      var ql = q.toLowerCase();
      // Owned first: rows whose name matches, resolved to real catalog cards.
      var ownedRows = (ctx.rows || []).filter(function (r) {
        return String(r.card_name || "").toLowerCase().indexOf(ql) >= 0;
      });
      var seen = {};
      var ownedCards = [];
      for (var i = 0; i < ownedRows.length && ownedCards.length < 8; i++) {
        var r = ownedRows[i];
        var dk = r.set_id + ":" + r.card_id;
        if (seen[dk]) continue;
        seen[dk] = true;
        try {
          var list = await App.tcg.getSetCardList(r.set_id);
          var c = (list || []).find(function (x) { return x.id === r.card_id; });
          if (c) ownedCards.push({ card: c, owned: true });
        } catch { /* skip */ }
      }
      // Catalog below.
      var cat = [];
      try {
        var res = await App.tcg.searchCards({ name: q, pageSize: 12 });
        cat = (res.data || []).filter(function (c) {
          return ownedCards.every(function (o) { return o.card.id !== c.id || o.card.set.lang !== c.set.lang; });
        }).map(function (c) {
          var k = ctx.keyOf(c);
          return { card: c, owned: ctx.ownedKeys.has(k) };
        });
      } catch { /* catalog search failed; owned results still show */ }

      var html = "";
      var all = ownedCards.concat(cat);
      if (ownedCards.length) {
        html += '<h4 class="picker-h">In your vault</h4><div class="picker-grid">' +
          ownedCards.map(function (o) { return pickerTile(o, all.indexOf(o)); }).join("") + "</div>";
      }
      if (cat.length) {
        html += '<h4 class="picker-h">Catalog</h4><div class="picker-grid">' +
          cat.map(function (o) { return pickerTile(o, all.indexOf(o)); }).join("") + "</div>";
      }
      if (!html) html = '<p class="picker-hint">No cards found for &ldquo;' + App.esc(q) + "&rdquo;.</p>";
      box.innerHTML = html;
      box.querySelectorAll("[data-pick]").forEach(function (t) {
        t.addEventListener("click", function () {
          var idx = parseInt(t.getAttribute("data-pick"), 10);
          var item = all[idx];
          if (!item) return;
          var key = ctx.keyOf(item.card);
          S.anchors[slotIdx] = {
            key: key, card: item.card,
            speciesSlug: ctx.speciesSlug(item.card.name),
            owned: item.owned
          };
          m.close();
          renderComposer();
        });
      });
    }

    function pickerTile(o, idx) {
      var c = o.card;
      var img = (c.images && c.images.small) || "";
      return '<button class="picker-tile" data-pick="' + idx + '">' +
        (img ? '<img src="' + App.esc(img) + '" alt="' + App.esc(c.name) + '" loading="lazy">' : '<div class="picker-noimg"></div>') +
        '<span class="picker-name">' + App.esc(c.name) + "</span>" +
        '<span class="picker-set">' + App.esc((c.set && c.set.name) || "") + "</span>" +
        (o.owned ? '<span class="bown">In vault</span>' : "") +
      "</button>";
    }

    /* ----- deal ----- */

    function opts() {
      return {
        recipe: S.recipe, layout: S.layout,
        vibe: { hue: S.hue, mood: S.mood },
        ownedOnly: S.ownedOnly, density: S.density / 100,
        seed: Date.now() % 1000000
      };
    }

    async function deal(pgIdx) {
      if (S.dealing) return;
      var anchors = S.anchors.filter(Boolean);
      if (!anchors.length) { App.ui.toast("Pick at least one anchor card first."); return; }
      S.dealing = true;
      var btn = document.getElementById("deal-btn");
      if (btn) { btn.disabled = true; btn.innerHTML = "Dealing&hellip;"; }
      try {
        var ctx = await getCtx();
        if (pgIdx == null) {
          S.pages = await App.binder.generatePages(anchors, opts(), ctx);
          S.locks = S.pages.map(function () { return new Array(9).fill(false); });
          S.sel = null;
        } else {
          var locked = S.locks[pgIdx].map(function (f, i) { return f ? S.pages[pgIdx].slots[i] : null; });
          var fresh = await App.binder.generatePages(anchors, opts(), ctx, locked);
          S.pages[pgIdx] = fresh[0];
          S.sel = null;
        }
        renderPages();
        var bp = document.getElementById("bpages");
        if (bp && pgIdx == null) bp.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {
        console.warn("[VaultDex] deal failed:", e);
        App.ui.toast("Couldn't deal pages — try again.");
      }
      S.dealing = false;
      renderComposer();
    }

    /* ----- page rendering ----- */

    function cellHtml(pg, i) {
      var slot = S.pages[pg].slots[i];
      if (!slot) return "";
      var locked = S.locks[pg][i] ? " locked" : "";
      if (slot.kind === "card") {
        return '<div class="bcell bcard' + (slot.anchor ? " anchor" : "") + locked + '" data-pg="' + pg + '" data-i="' + i + '" role="button" tabindex="0" aria-label="' + App.esc(slot.name) + '">' +
          (slot.image ? '<img src="' + App.esc(slot.image) + '" alt="' + App.esc(slot.name) + '" loading="lazy">' : '<div class="bnoimg"></div>') +
          (slot.anchor ? '<span class="banchor-tag">Anchor</span>' : "") +
          (slot.owned ? '<span class="bown">In vault</span>' : "") +
          (S.locks[pg][i] ? '<span class="block-tag">' + App.ui.icon("check") + "</span>" : "") +
        "</div>";
      }
      if (slot.kind === "insert") {
        var src = slot.src || (slot.insert && (slot.insert.image || slot.insert.src)) || "";
        var spanCls = slot.span >= 3 ? " span-3" : slot.span === 2 ? " span-2" : "";
        var divs = "";
        if (slot.span >= 3) divs = '<i class="bdiv" style="left:33.333%"></i><i class="bdiv" style="left:66.666%"></i>';
        else if (slot.span === 2) divs = '<i class="bdiv" style="left:50%"></i>';
        var title = (slot.insert && (slot.insert.title || slot.insert.name)) || "Insert";
        var tag = slot.insert && slot.insert.kind === "art" ? "Panorama" : "Insert";
        return '<div class="bcell binsert' + spanCls + locked + '" data-pg="' + pg + '" data-i="' + i + '" role="button" tabindex="0" aria-label="' + App.esc(title) + '"' +
          (slot.span > 1 ? ' style="grid-column: span ' + slot.span + '"' : "") + ">" +
          (src ? '<img src="' + App.esc(src) + '" alt="' + App.esc(title) + '" loading="lazy">' : "") +
          divs +
          '<span class="binsert-tag">' + tag + "</span>" +
          (S.locks[pg][i] ? '<span class="block-tag">' + App.ui.icon("check") + "</span>" : "") +
        "</div>";
      }
      return '<div class="bcell bblank' + locked + '" data-pg="' + pg + '" data-i="' + i + '" role="button" tabindex="0" aria-label="Empty pocket">' +
        (S.locks[pg][i] ? '<span class="block-tag">' + App.ui.icon("check") + "</span>" : "") +
      "</div>";
    }

    function renderPages() {
      var wrap = root.querySelector("#bpages");
      if (!wrap) return;
      if (!S.pages.length) { wrap.innerHTML = ""; return; }
      wrap.innerHTML = S.pages.map(function (pg, pi) {
        var seenSlots = new Set();
        var cells = "";
        for (var i = 0; i < 9; i++) {
          var slot = pg.slots[i];
          if (!slot) continue;
          // Spanning inserts render once at their first position. After a
          // JSON round-trip (saved pages) the positions hold separate object
          // copies, so dedupe by position, not object identity.
          if (slot.kind === "insert" && slot.positions && slot.positions[0] !== i) continue;
          if (seenSlots.has(slot)) continue; // same object referenced twice
          seenSlots.add(slot);
          cells += cellHtml(pi, i);
        }
        return '<section class="bpage card">' +
          '<div class="bpage-head">' +
            '<div><h3 class="bpage-title">' + App.esc(pg.title) + "</h3>" +
            '<p class="bpage-story">' + App.esc(pg.story) + "</p></div>" +
            '<div class="bpage-actions">' +
              '<button class="btn btn-ghost btn-sm" data-shuffle="' + pi + '">' + App.ui.icon("refresh") + " Shuffle</button>" +
              '<button class="btn btn-ghost btn-sm" data-save="' + pi + '">Save</button>' +
            "</div>" +
          "</div>" +
          '<div class="bgrid">' + cells + "</div>" +
          '<div class="bpocket" id="bpocket-' + pi + '">' +
            '<p class="bpocket-hint">Tap any pocket to see why it&rsquo;s there.</p>' +
          "</div>" +
        "</section>";
      }).join("");

      wrap.querySelectorAll("[data-shuffle]").forEach(function (b) {
        b.addEventListener("click", function () { deal(parseInt(b.getAttribute("data-shuffle"), 10)); });
      });
      wrap.querySelectorAll("[data-save]").forEach(function (b) {
        b.addEventListener("click", function () { openSave(parseInt(b.getAttribute("data-save"), 10)); });
      });
      wrap.querySelectorAll(".bcell").forEach(function (c) {
        function pick() {
          selectPocket(parseInt(c.getAttribute("data-pg"), 10), parseInt(c.getAttribute("data-i"), 10));
        }
        c.addEventListener("click", pick);
        c.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      });
      renderSaved();
    }

    function selectPocket(pg, i) {
      S.sel = { pg: pg, i: i };
      var slot = S.pages[pg].slots[i];
      var box = root.querySelector("#bpocket-" + pg);
      if (!box || !slot) return;
      var title, sub, reason = slot.reason || "";
      if (slot.kind === "card") {
        title = slot.name;
        sub = (slot.anchor ? "Anchor card · " : "") + (slot.owned ? "In your vault" : "Not in your vault");
      } else if (slot.kind === "insert") {
        title = (slot.insert && (slot.insert.title || slot.insert.name)) || "Art insert";
        sub = slot.insert && slot.insert.kind === "art" ? "Real card art · panorama crop" : "Generated backdrop";
      } else {
        title = "Empty pocket";
        sub = "Left blank on purpose";
      }
      var locked = S.locks[pg][i];
      box.innerHTML =
        '<div class="bpocket-body">' +
          "<div><b>" + App.esc(title) + "</b>" +
          '<p class="bpocket-sub">' + App.esc(sub) + "</p>" +
          (reason ? '<p class="bpocket-why">' + App.esc(reason) + "</p>" : "") + "</div>" +
          '<button class="btn btn-ghost btn-sm" id="bpocket-lock">' + (locked ? "Unlock pocket" : "Lock pocket") + "</button>" +
        "</div>";
      box.querySelector("#bpocket-lock").addEventListener("click", function () {
        S.locks[pg][i] = !S.locks[pg][i];
        // Spanning inserts lock all their positions together.
        if (slot.positions && slot.positions.length > 1) {
          slot.positions.forEach(function (p) { S.locks[pg][p] = S.locks[pg][i]; });
        }
        renderPages();
        selectPocket(pg, i);
      });
      // Highlight the selected cell.
      root.querySelectorAll(".bcell.sel").forEach(function (c) { c.classList.remove("sel"); });
      var cell = root.querySelector('.bcell[data-pg="' + pg + '"][data-i="' + i + '"]');
      if (cell) cell.classList.add("sel");
    }

    /* ----- save / saved pages ----- */

    function openSave(pi) {
      var pg = S.pages[pi];
      if (!pg) return;
      var m = App.ui.openModal(
        '<h3 class="picker-title">Save this page idea</h3>' +
        '<input class="picker-search" id="save-name" type="text" maxlength="60" value="' + App.esc(pg.title) + '">' +
        '<div class="save-row"><button class="btn btn-primary" id="save-go">Save page</button></div>'
      );
      var input = m.el.querySelector("#save-name");
      input.focus();
      input.select();
      m.el.querySelector("#save-go").addEventListener("click", function () {
        var name = input.value.trim() || pg.title;
        var list = loadSaved();
        list.unshift({
          id: "bp" + Date.now().toString(36),
          name: name,
          savedAt: new Date().toISOString(),
          recipe: S.recipe, layout: S.layout,
          anchors: S.anchors.filter(Boolean).map(function (a) {
            return { key: a.key, name: a.card.name, image: (a.card.images && a.card.images.small) || "" };
          }),
          page: pg
        });
        storeSaved(list.slice(0, 30));
        S.saved = list.slice(0, 30);
        m.close();
        App.ui.toast("Page saved.");
        renderSaved();
      });
    }

    function renderSaved() {
      var wrap = root.querySelector("#bsaved");
      if (!wrap) return;
      if (!S.saved.length) { wrap.innerHTML = ""; return; }
      wrap.innerHTML =
        '<section class="bsaved card"><h3 class="bsaved-h">Saved pages</h3>' +
        S.saved.map(function (s) {
          var d = new Date(s.savedAt);
          var when = isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          return '<div class="bsaved-row" data-saved="' + App.esc(s.id) + '">' +
            '<div><b>' + App.esc(s.name) + "</b>" +
            '<p class="bsaved-meta">' + App.esc(recipeLabel(s.recipe)) + " · " + App.esc(layoutLabel(s.layout)) + (when ? " · " + when : "") + "</p></div>" +
            '<div class="bsaved-actions">' +
              '<button class="btn btn-ghost btn-sm" data-open-saved="' + App.esc(s.id) + '">Open</button>' +
              '<button class="btn btn-ghost btn-sm" data-del-saved="' + App.esc(s.id) + '">' + App.ui.icon("trash") + "</button>" +
            "</div></div>";
        }).join("") + "</section>";
      wrap.querySelectorAll("[data-open-saved]").forEach(function (b) {
        b.addEventListener("click", function () {
          var s = S.saved.find(function (x) { return x.id === b.getAttribute("data-open-saved"); });
          if (!s) return;
          S.pages = [s.page];
          S.locks = [new Array(9).fill(false)];
          S.sel = null;
          renderPages();
          var bp = document.getElementById("bpages");
          if (bp) bp.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
      wrap.querySelectorAll("[data-del-saved]").forEach(function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-del-saved");
          S.saved = S.saved.filter(function (x) { return x.id !== id; });
          storeSaved(S.saved);
          renderSaved();
        });
      });
    }

    function recipeLabel(r) {
      var f = RECIPES.find(function (x) { return x[0] === r; });
      return f ? f[1] : r;
    }
    function layoutLabel(l) {
      var f = LAYOUTS.find(function (x) { return x[0] === l; });
      return f ? f[1] : l;
    }
  };
})();
