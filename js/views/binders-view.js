/* Binders views: the /binders hub and the /binder/<id> flip-through view.
 * Owner-only — signed-out visitors never see binder information. */
(function () {
  "use strict";

  App.views = App.views || {};

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
  /* Binder cover artwork: official Vault X Exo-Tec zip binder product
   * shots (Signature Black, Royal Blue, Forest Green, Fire Red), picked
   * deterministically per binder so each binder keeps its look. */
  var BINDER_COVERS = ["binder-black", "binder-blue", "binder-green", "binder-red"];
  function binderCover(id) {
    var h = 0, s = String(id || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return "/images/binder-covers/" + BINDER_COVERS[h % BINDER_COVERS.length] + ".webp";
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
          var art = '<img class="binder-art-img" src="' + binderCover(bdr.id) + '" alt="" loading="lazy">';
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
    { id: "binder", label: "Binder order" },
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
    } else if (sortId === "rarity") {
      arr = App.binders.sortByBinderRarity(arr);
    } else {
      arr = App.binders.sortBinderDefault(arr);
    }
    return arr;
  }

  App.views.binderDetail = async function (root, binderId) {
    if (!isOwner()) { privateState(root); return; }
    root.innerHTML =
      '<div class="page-head"><a class="btn btn-ghost" href="/binders">← Binders</a>' +
      '<h1 id="bdet-name">…</h1></div>' +
      '<div class="binder-bar"><button class="btn btn-ghost" id="bdet-add">Add cards</button>' +
      '<label>Sort <select id="bdet-sort">' +
      SORTS.map(function (s) { return '<option value="' + s.id + '">' + s.label + "</option>"; }).join("") +
      "</select></label>" +
      '<div class="binder-pages"><button class="btn btn-ghost" id="bdet-prev" aria-label="Previous page">←</button>' +
      '<span id="bdet-page"></span>' +
      '<button class="btn btn-ghost" id="bdet-next" aria-label="Next page">→</button></div></div>' +
      '<div id="bdet-grid" class="binder-sheet"><div class="loading">Loading binder…</div></div>';

    var state = { sort: "binder", page: 0, items: [], name: "" };
    var nameEl = root.querySelector("#bdet-name");
    var gridEl = root.querySelector("#bdet-grid");
    var pageEl = root.querySelector("#bdet-page");
    var prevBtn = root.querySelector("#bdet-prev");
    var nextBtn = root.querySelector("#bdet-next");
    var sortSel = root.querySelector("#bdet-sort");

    function pageCount() { return Math.max(1, Math.ceil(currentSlots().length / PAGE_SIZE)); }

    /* One slot per copy: a ×3 row fills three sleeves, copies adjacent. */
    function currentSlots() { return expandSlots(sortRows(state.items, state.sort)); }

    function renderPage(dir) {
      if (!gridEl.isConnected) return;
      var slots = currentSlots();
      var pages = pageCount();
      if (state.page >= pages) state.page = pages - 1;
      if (state.page < 0) state.page = 0;
      var slice = slots.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);
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
      var empties = "";
      for (var i = slice.length; i < PAGE_SIZE; i++) empties += emptyPocket();
      gridEl.innerHTML = slice.map(function (s) { return detailTile(s); }).join("") + empties;
      /* Page-turn feel: a quick flip on every page change. */
      gridEl.classList.remove("binder-flip");
      void gridEl.offsetWidth;
      if (dir) gridEl.classList.add("binder-flip");
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
    root.querySelector("#bdet-add").addEventListener("click", function () {
      /* Pre-check sets already shelved here — "shelve more like these". */
      var present = {};
      state.items.forEach(function (r) { if (r.set_id) present[r.set_id] = true; });
      openAddCardsModal(binderId, state.name || "this binder", Object.keys(present));
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

  /* Pure: expand collection rows into one slot per copy, so a ×3 row
   * fills three sleeves. Copies of a row stay adjacent, in sort order. */
  function expandSlots(items) {
    var slots = [];
    (items || []).forEach(function (row) {
      var q = Math.max(1, Math.floor(row.quantity || 1));
      for (var i = 0; i < q; i++) slots.push({ row: row, copy: i + 1, of: q });
    });
    return slots;
  }

  /* Pocket tile for the flip view: a clear sleeve holding just the card
   * art, like a physical 9-pocket page. One slot per copy; the view is
   * purely visual — taps do nothing, card management lives in the
   * collection views. */
  function detailTile(slot) {
    var item = slot.row;
    var gradeBadge = item.grading_company
      ? '<span class="pocket-grade">' + App.esc(item.grading_company) + " " + App.esc(item.grade || "") + "</span>"
      : "";
    var img = item.image_small || "";
    return '<div class="binder-pocket"><div class="art">' +
      '<img loading="lazy" src="' + App.esc(img) + '" alt="' + App.esc((item.card_name || "") + " card art") + '">' +
      gradeBadge + "</div></div>";
  }

  /* Empty sleeves round a partial page out to 9 pockets, like a real
   * binder page that isn't full yet. */
  function emptyPocket() {
    return '<div class="binder-pocket empty" aria-hidden="true"><div class="art"></div></div>';
  }

  /* Pure: group unshelved collection rows by set, for the Add-cards modal.
   * Rows already in any binder are excluded — shelving never rips cards
   * out of another binder. */
  function groupUnshelvedBySet(rows) {
    var map = {};
    (rows || []).forEach(function (r) {
      if (r.binder_id) return;
      var sid = r.set_id || "unknown";
      var g = map[sid];
      if (!g) g = map[sid] = { set_id: sid, set_name: r.set_name || sid, rows: [], copies: 0 };
      g.rows.push(r);
      g.copies += r.quantity || 0;
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      var x = a.set_name.toLowerCase(), y = b.set_name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  /* Bulk-shelve unshelved cards into a binder, picked by set. */
  function openAddCardsModal(binderId, binderName, preselect) {
    preselect = preselect || [];
    var m = App.ui.openModal(
      "<h2>Add cards</h2>" +
      '<p class="modal-sub">Shelve unshelved cards into "' + App.esc(binderName) + '". Only cards not in a binder are listed.</p>' +
      '<div id="ac-list" class="ac-list"><div class="loading">Loading your collection…</div></div>' +
      '<div class="modal-actions"><span id="ac-count" class="ac-count"></span>' +
      '<button class="btn btn-primary" id="ac-go" disabled>Shelve</button></div>'
    );
    var listEl = m.el.querySelector("#ac-list");
    var goBtn = m.el.querySelector("#ac-go");
    var countEl = m.el.querySelector("#ac-count");
    var groups = [];

    function selectedRows() {
      var out = [];
      listEl.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
        var g = groups.filter(function (x) { return x.set_id === cb.value; })[0];
        if (g) out.push.apply(out, g.rows);
      });
      return out;
    }
    function cardWord(n) { return n === 1 ? "card" : "cards"; }
    function copyWord(n) { return n === 1 ? "copy" : "copies"; }
    function refreshCount() {
      var rows = selectedRows();
      var copies = rows.reduce(function (n, r) { return n + (r.quantity || 0); }, 0);
      countEl.textContent = rows.length ? rows.length + " " + cardWord(rows.length) + " · " + copies + " " + copyWord(copies) : "";
      goBtn.disabled = !rows.length;
      goBtn.textContent = rows.length ? "Shelve " + rows.length + " " + cardWord(rows.length) : "Shelve";
    }

    App.collection.list().then(function (rows) {
      if (!m.el.isConnected) return;
      groups = groupUnshelvedBySet(rows);
      if (!groups.length) {
        listEl.innerHTML = "<p>Every card in your collection is already in a binder.</p>";
        return;
      }
      listEl.innerHTML = groups.map(function (g) {
        var checked = preselect.indexOf(g.set_id) !== -1 ? " checked" : "";
        return '<label class="ac-row"><input type="checkbox" value="' + App.esc(g.set_id) + '"' + checked + ">" +
          '<span class="ac-name">' + App.esc(g.set_name) + ' <span class="ac-setid">' + App.esc(g.set_id) + "</span></span>" +
          '<span class="ac-meta">' + g.rows.length + " " + cardWord(g.rows.length) + " · " + g.copies + " " + copyWord(g.copies) + "</span></label>";
      }).join("");
      listEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.addEventListener("change", refreshCount);
      });
      refreshCount();
    }).catch(function () {
      if (listEl.isConnected) listEl.innerHTML = "<p>Couldn't load your collection.</p>";
    });

    goBtn.addEventListener("click", async function () {
      var rows = selectedRows();
      if (!rows.length) return;
      goBtn.disabled = true;
      try {
        var done = 0, CHUNK = 25;
        for (var i = 0; i < rows.length; i += CHUNK) {
          var chunk = rows.slice(i, i + CHUNK);
          await Promise.all(chunk.map(function (r) { return App.binders.setBinder(r.id, binderId); }));
          done += chunk.length;
          goBtn.textContent = "Shelving " + done + "/" + rows.length + "…";
        }
        m.close();
        App.ui.toast("Shelved " + rows.length + " " + cardWord(rows.length) + ' in "' + binderName + '".', "success");
        App.navigate(window.location.pathname, { replace: true });
      } catch (e) {
        goBtn.disabled = false;
        refreshCount();
        App.handleApiError(e);
      }
    });
  }
  /* Exposed for unit tests. */
  App.views.binderDetail.groupUnshelvedBySet = groupUnshelvedBySet;
  App.views.binderDetail.expandSlots = expandSlots;
})();
