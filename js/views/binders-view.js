/* Binders views: the /binders hub and the /binder/<id> flip-through view.
 * Owner-only — signed-out visitors never see binder information. */
(function () {
  "use strict";

  var PAGE_SIZE = 9;

  function isOwner() {
    return App.auth && App.auth.isOwner && App.auth.isOwner();
  }

  function privateState(root) {
    root.innerHTML = App.ui.emptyState({
      title: "Binders are private",
      body: "Sign in as the owner to browse the physical binder collection.",
      icon: "cards"
    });
  }

  function rowValue(row) {
    var p = row.market_price;
    return (p === null || p === undefined) ? 0 : Number(p) * (row.quantity || 0);
  }

  function rowsByBinder(rows) {
    var map = {};
    (rows || []).forEach(function (r) {
      if (!r.binder_id) return;
      (map[r.binder_id] = map[r.binder_id] || []).push(r);
    });
    return map;
  }

  /* Deterministic cover hue per binder, so empty binders still get a
   * rich, visible cover in both light and dark mode. */
  /* Deterministic cover hue per binder, so empty binders still get a
   * rich, visible cover in both light and dark mode. */
  function binderHue(id) {
    var h = 0, s = String(id || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  /* ---------- /binders hub ---------- */

  App.views.binders = async function (root) {
    if (!isOwner()) { privateState(root); return; }
    root.innerHTML =
      '<div class="page-head"><h1>Binders</h1>' +
      '<div class="page-actions">' +
      '<button class="btn btn-ghost" id="bd-manage">Manage</button>' +
      '<button class="btn btn-primary" id="bd-new">New binder</button>' +
      "</div></div>" +
      '<div id="bd-grid" class="binder-grid"><div class="loading">Loading binders…</div></div>';

    root.querySelector("#bd-new").addEventListener("click", function () { openNewBinderModal(render); });
    root.querySelector("#bd-manage").addEventListener("click", function () { openManageModal(render); });

    async function render() {
      var grid = root.querySelector("#bd-grid");
      if (!grid || !grid.isConnected) return;
      try {
        var binders = await App.binders.list();
        var rows = await App.collection.list();
        var grouped = rowsByBinder(rows);
        if (!binders.length) {
          grid.innerHTML = App.ui.emptyState({
            title: "No binders yet",
            body: "Create a binder to start shelving your physical collection.",
            actionHtml: '<button class="btn btn-primary" id="bd-empty-new">New binder</button>'
          });
          var b = grid.querySelector("#bd-empty-new");
          if (b) b.addEventListener("click", function () { openNewBinderModal(render); });
          return;
        }
        grid.innerHTML = binders.map(function (bdr) {
          var items = grouped[bdr.id] || [];
          var copies = items.reduce(function (n, r) { return n + (r.quantity || 0); }, 0);
          var total = items.reduce(function (n, r) { return n + rowValue(r); }, 0);
          var cover = items.slice().sort(function (a, c) { return rowValue(c) - rowValue(a); })[0];
          var art;
          if (cover && cover.image_small) {
            art = '<img class="binder-art-img" src="' + App.esc(cover.image_small) + '" alt="" loading="lazy">';
          } else {
            var hue = binderHue(bdr.id), hue2 = (hue + 50) % 360;
            art = '<div class="binder-art-empty" style="background:linear-gradient(150deg,hsl(' + hue + ',55%,44%),hsl(' + hue2 + ',62%,24%))">' +
              App.ui.icon("cards") + "</div>";
          }
          return '<a class="binder-tile" href="/binder/' + App.esc(bdr.id) + '" data-binder="' + App.esc(bdr.id) + '">' +
            '<div class="binder-art">' + art + '<div class="binder-scrim"></div></div>' +
            '<div class="binder-overlay"><div class="binder-name">' + App.esc(bdr.name) + "</div>" +
            '<div class="binder-stats">' + copies + (copies === 1 ? " card" : " cards") +
            " · " + App.ui.money(total) + "</div></div></a>";
        }).join("");
      } catch (e) {
        console.warn("[VaultDex] binders hub failed:", e && e.message);
        grid.innerHTML = App.ui.emptyState({ title: "Couldn't load binders", body: "Check your connection and try again." });
      }
    }
    render();
  };

  function openNewBinderModal(onDone) {
    var m = App.ui.openModal(
      '<h2>New binder</h2>' +
      '<div class="field"><label for="nb-name">Name</label>' +
      '<input id="nb-name" type="text" maxlength="60" placeholder="e.g. Main binder" autocomplete="off"></div>' +
      '<div class="modal-actions"><button class="btn btn-primary" id="nb-create">Create</button></div>',
      { narrow: true }
    );
    var input = m.el.querySelector("#nb-name");
    input.focus();
    async function create() {
      var name = input.value.trim();
      if (!name) { input.focus(); return; }
      try {
        await App.binders.create(name);
        m.close();
        App.ui.toast('Created "' + name + '".', "success");
        if (onDone) onDone();
      } catch (e) { App.handleApiError(e); }
    }
    m.el.querySelector("#nb-create").addEventListener("click", create);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") create(); });
  }

  function openManageModal(onDone) {
    var m = App.ui.openModal('<h2>Manage binders</h2><div id="mb-list"><div class="loading">Loading…</div></div>', { narrow: true });
    var listEl = m.el.querySelector("#mb-list");
    async function render() {
      if (!listEl.isConnected) return;
      var binders;
      try { binders = await App.binders.list(); }
      catch (e) { listEl.innerHTML = "<p>Couldn't load binders.</p>"; return; }
      if (!binders.length) { listEl.innerHTML = "<p>No binders yet.</p>"; return; }
      listEl.innerHTML = binders.map(function (b, i) {
        return '<div class="mb-row" data-id="' + App.esc(b.id) + '">' +
          '<span class="mb-name">' + App.esc(b.name) + "</span>" +
          '<div class="mb-actions">' +
          (i > 0 ? '<button class="icon-btn-sm" data-act="up" aria-label="Move up">' + App.ui.icon("chev-l") + "</button>" : "") +
          (i < binders.length - 1 ? '<button class="icon-btn-sm" data-act="down" aria-label="Move down">' + App.ui.icon("chev-r") + "</button>" : "") +
          '<button class="icon-btn-sm" data-act="rename" aria-label="Rename">✎</button>' +
          '<button class="icon-btn-sm" data-act="del" aria-label="Delete">' + App.ui.icon("trash") + "</button>" +
          "</div></div>";
      }).join("");
      listEl.querySelectorAll(".mb-row").forEach(function (rowEl) {
        var id = rowEl.getAttribute("data-id");
        rowEl.querySelectorAll("[data-act]").forEach(function (btn) {
          btn.addEventListener("click", async function () {
            var act = btn.getAttribute("data-act");
            btn.disabled = true;
            try {
              if (act === "del") {
                if (!window.confirm("Delete this binder? Its cards stay in your collection, unshelved.")) return;
                await App.binders.remove(id);
              } else if (act === "rename") {
                var cur = binders.filter(function (x) { return x.id === id; })[0];
                var name = window.prompt("Rename binder", cur ? cur.name : "");
                if (name && name.trim()) await App.binders.rename(id, name.trim());
              } else {
                var ids = binders.map(function (x) { return x.id; });
                var ix = ids.indexOf(id);
                var jx = act === "up" ? ix - 1 : ix + 1;
                var tmp = ids[ix]; ids[ix] = ids[jx]; ids[jx] = tmp;
                await App.binders.reorder(ids);
              }
              await render();
              if (onDone) onDone();
            } catch (e) { App.handleApiError(e); }
            finally { btn.disabled = false; }
          });
        });
      });
    }
    render();
  }

  /* ---------- /binder/<id> flip-through view ---------- */

  var SORTS = [
    { id: "rarity", label: "Rarity" },
    { id: "value", label: "Value" },
    { id: "name", label: "Name" },
    { id: "set", label: "Set" }
  ];

  function sortRows(items, sortId) {
    var arr = items.slice();
    if (sortId === "value") {
      arr.sort(function (a, b) { return rowValue(b) - rowValue(a); });
    } else if (sortId === "name") {
      arr.sort(function (a, b) {
        var x = (a.card_name || ""), y = (b.card_name || "");
        return x < y ? -1 : x > y ? 1 : 0;
      });
    } else if (sortId === "set") {
      arr.sort(function (a, b) {
        var x = (a.set_name || "") + (a.card_name || ""), y = (b.set_name || "") + (b.card_name || "");
        return x < y ? -1 : x > y ? 1 : 0;
      });
    } else {
      arr = App.binders.sortByRarity(arr);
    }
    return arr;
  }

  App.views.binderDetail = async function (root, binderId) {
    if (!isOwner()) { privateState(root); return; }
    root.innerHTML =
      '<div class="page-head"><a class="btn btn-ghost" href="/binders">← Binders</a>' +
      '<h1 id="bdet-name">…</h1></div>' +
      '<div class="binder-bar"><label>Sort <select id="bdet-sort">' +
      SORTS.map(function (s) { return '<option value="' + s.id + '">' + s.label + "</option>"; }).join("") +
      "</select></label>" +
      '<div class="binder-pages"><button class="btn btn-ghost" id="bdet-prev" aria-label="Previous page">←</button>' +
      '<span id="bdet-page"></span>' +
      '<button class="btn btn-ghost" id="bdet-next" aria-label="Next page">→</button></div></div>' +
      '<div id="bdet-grid" class="card-grid binder-sheet"><div class="loading">Loading binder…</div></div>';

    var state = { sort: "rarity", page: 0, items: [], name: "" };
    var nameEl = root.querySelector("#bdet-name");
    var gridEl = root.querySelector("#bdet-grid");
    var pageEl = root.querySelector("#bdet-page");
    var prevBtn = root.querySelector("#bdet-prev");
    var nextBtn = root.querySelector("#bdet-next");
    var sortSel = root.querySelector("#bdet-sort");

    function pageCount() { return Math.max(1, Math.ceil(state.items.length / PAGE_SIZE)); }

    function renderPage(dir) {
      if (!gridEl.isConnected) return;
      var sorted = sortRows(state.items, state.sort);
      var pages = pageCount();
      if (state.page >= pages) state.page = pages - 1;
      if (state.page < 0) state.page = 0;
      var slice = sorted.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);
      pageEl.textContent = "Page " + (state.page + 1) + " of " + pages;
      prevBtn.disabled = state.page === 0;
      nextBtn.disabled = state.page >= pages - 1;
      if (!slice.length) {
        gridEl.innerHTML = App.ui.emptyState({
          title: "Nothing shelved here",
          body: "Open any card and pick this binder to shelve copies in it."
        });
        return;
      }
      gridEl.innerHTML = slice.map(function (it) { return detailTile(it); }).join("");
      /* Page-turn feel: a quick flip on every page change. */
      gridEl.classList.remove("binder-flip");
      void gridEl.offsetWidth;
      if (dir) gridEl.classList.add("binder-flip");
      wireTiles(gridEl, state.items);
    }

    function go(delta) {
      var pages = pageCount();
      var next = state.page + delta;
      if (next < 0 || next >= pages) return;
      state.page = next;
      renderPage(delta);
    }
    prevBtn.addEventListener("click", function () { go(-1); });
    nextBtn.addEventListener("click", function () { go(1); });
    sortSel.addEventListener("change", function () {
      state.sort = sortSel.value;
      state.page = 0;
      renderPage(0);
    });
    function onKey(e) {
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    }
    document.addEventListener("keydown", onKey);

    try {
      var binder = await App.binders.byId(binderId);
      if (!binder) {
        root.innerHTML = App.ui.emptyState({ title: "Binder not found", body: "It may have been deleted.", actionHtml: '<a class="btn btn-ghost" href="/binders">Back to binders</a>' });
        return;
      }
      state.name = binder.name;
      nameEl.textContent = binder.name;
      var rows = await App.collection.list();
      state.items = (rows || []).filter(function (r) { return r.binder_id === binderId; });
      renderPage(0);
    } catch (e) {
      console.warn("[VaultDex] binder detail failed:", e && e.message);
      gridEl.innerHTML = App.ui.emptyState({ title: "Couldn't load this binder", body: "Check your connection and try again." });
    }
  };

  /* Card tile for the flip view: mirrors the collection tile, plus a
   * move-copies action that splits quantities across binders. */
  function detailTile(item) {
    var value = rowValue(item);
    var gradeBadge = item.grading_company
      ? '<span class="grade-badge">' + App.esc(item.grading_company) + " " + App.esc(item.grade || "") + "</span>"
      : "";
    var qtyBadge = item.quantity > 1 ? '<span class="qty-badge">×' + item.quantity + "</span>" : "";
    var controls =
      '<div class="tile-controls">' +
      '<button class="icon-btn-sm" data-act="move" aria-label="Move copies of ' + App.esc(item.card_name) + ' to another binder" title="Move copies">' + App.ui.icon("tag") + "</button>" +
      "</div>";
    return App.ui.tileHtml(item, {
      dataRow: item.id,
      dataCard: item.card_id,
      qty: item.quantity,
      activatable: false,
      setHtml: App.esc(item.set_name || ""),
      priceHtml:
        '<span class="price-badge">' + App.ui.money(value, item.price_currency) + "</span>" +
        '<span class="price-chips">' + gradeBadge + qtyBadge + '<span class="variant-chip">' + App.esc(item.variant) + "</span></span>",
      postPrice: controls
    });
  }

  function wireTiles(gridEl, items) {
    gridEl.querySelectorAll(".card-tile").forEach(function (tile) {
      var art = tile.querySelector(".art");
      if (art) art.addEventListener("click", function () {
        var rowId = tile.getAttribute("data-row");
        var item = items.filter(function (x) { return x.id === rowId; })[0];
        var cid = tile.getAttribute("data-card");
        var lang = (App.util.isJa(item) || App.util.isJa(cid)) ? "ja" : "en";
        App.openCardModal(cid, lang, item, art);
      });
      tile.querySelectorAll('[data-act="move"]').forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var rowId = tile.getAttribute("data-row");
          var item = items.filter(function (x) { return x.id === rowId; })[0];
          if (item) openMoveModal(item);
        });
      });
    });
  }

  /* Move N copies of a row to another binder. Moving all copies just
   * re-shelves the row; moving fewer splits it into two rows. */
  function openMoveModal(item) {
    var m = App.ui.openModal(
      '<h2>Move copies</h2>' +
      '<p class="modal-sub">' + App.esc(item.card_name) + " · ×" + item.quantity + " in this binder</p>" +
      '<div class="field"><label for="mv-qty">Copies to move</label>' +
      '<input id="mv-qty" type="number" min="1" max="' + item.quantity + '" value="' + Math.min(1, item.quantity) + '"></div>' +
      '<div class="field"><label for="mv-binder">To binder</label><select id="mv-binder"><option value="">No binder (unshelve)</option></select></div>' +
      '<div class="modal-actions"><button class="btn btn-primary" id="mv-go">Move</button></div>',
      { narrow: true }
    );
    var sel = m.el.querySelector("#mv-binder");
    App.binders.list().then(function (binders) {
      if (!m.el.isConnected) return;
      binders.filter(function (b) { return b.id !== item.binder_id; }).forEach(function (b) {
        var opt = document.createElement("option");
        opt.value = b.id;
        opt.textContent = b.name;
        sel.appendChild(opt);
      });
    });
    m.el.querySelector("#mv-go").addEventListener("click", async function () {
      var qty = Math.floor(Number(m.el.querySelector("#mv-qty").value));
      var target = sel.value || null;
      if (!isFinite(qty) || qty < 1 || qty > item.quantity) {
        App.ui.toast("Move between 1 and " + item.quantity + " copies.", "info");
        return;
      }
      try {
        await App.collection.splitRow(item.id, qty, target);
        m.close();
        App.ui.toast(qty === item.quantity ? "Moved." : "Split — " + qty + " moved.", "success");
        App.navigate(window.location.pathname, { replace: true });
      } catch (e) { App.handleApiError(e); }
    });
  }
})();
