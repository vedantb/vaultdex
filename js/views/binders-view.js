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

  /* Pure: the default pocket order — one entry per copy, in the default
   * binder order — used to seed a binder's slot_order the first time it
   * is arranged. */
  function seedSlotOrder(items) {
    return expandSlots(App.binders.sortBinderDefault(items)).map(function (s) { return s.row.id; });
  }

  /* Pure: merge a stored slot_order with the rows currently shelved.
   * Keeps the owner's arrangement; drops ids that are gone or beyond a
   * row's current quantity (each copy past the row's quantity becomes an
   * empty sleeve); appends new copies at the end in default binder order;
   * keeps interior empty sleeves; trims trailing empties. */
  function reconcileSlotOrder(stored, items) {
    var counts = {}, used = {}, id;
    (items || []).forEach(function (r) {
      counts[r.id] = (counts[r.id] || 0) + Math.max(1, Math.floor(r.quantity || 1));
    });
    var out = [];
    (stored || []).forEach(function (sid) {
      if (sid == null || (counts[sid] || 0) <= (used[sid] || 0)) { out.push(null); return; }
      out.push(sid);
      used[sid] = (used[sid] || 0) + 1;
    });
    expandSlots(App.binders.sortBinderDefault(items)).forEach(function (s) {
      id = s.row.id;
      if ((used[id] || 0) < (counts[id] || 0)) { out.push(id); used[id] = (used[id] || 0) + 1; }
    });
    while (out.length && out[out.length - 1] == null) out.pop();
    return out;
  }

  /* Pure: apply a drag-and-drop to a slot order. Dropping on an occupied
   * pocket swaps the two cards; dropping on an empty pocket moves the
   * card there and leaves its old sleeve empty. */
  function applyDrop(order, from, to) {
    var next = (order || []).slice(), tmp;
    if (from === to) return next;
    if (from >= next.length || next[from] == null) return next;
    while (next.length <= to) next.push(null);
    var moving = next[from];
    if (next[to] == null) { next[to] = moving; next[from] = null; }
    else { tmp = next[to]; next[to] = moving; next[from] = tmp; }
    while (next.length && next[next.length - 1] == null) next.pop();
    return next;
  }

  App.views.binderDetail = async function (root, binderId) {
    if (!isOwner()) { privateState(root); return; }
    root.innerHTML =
      '<div class="page-head"><a class="btn btn-ghost" href="/binders">← Binders</a>' +
      '<h1 id="bdet-name">…</h1></div>' +
      '<div class="binder-bar"><button class="btn btn-ghost" id="bdet-add">Add cards</button>' +
      '<span class="binder-hint">Drag a card to move it — swap with another card or drop it in an empty pocket, even on another page.</span>' +
      '<div class="binder-pages"><button class="btn btn-ghost" id="bdet-prev" aria-label="Previous">←</button>' +
      '<span id="bdet-page"></span>' +
      '<button class="btn btn-ghost" id="bdet-next" aria-label="Next">→</button></div></div>' +
      '<div id="bdet-book" class="binder-desk"><div class="loading">Loading binder…</div></div>';

    var state = { spread: 0, mpage: 0, items: [], order: [], pages: [], name: "", flipping: false };
    var nameEl = root.querySelector("#bdet-name");
    var bookEl = root.querySelector("#bdet-book");
    var pageEl = root.querySelector("#bdet-page");
    var prevBtn = root.querySelector("#bdet-prev");
    var nextBtn = root.querySelector("#bdet-next");
    var mqWide = window.matchMedia("(min-width: 700px)");
    var mqCalm = window.matchMedia("(prefers-reduced-motion: reduce)");
    function wide() { return mqWide.matches; }

    /* Pocket order → rendered pages. While dragging a completely full
     * binder, one extra blank page appears at the end so there is always
     * an empty pocket to drop into. */
    function refreshPages() {
      var rowById = {};
      state.items.forEach(function (r) { rowById[r.id] = r; });
      var order = state.order.slice(), i;
      if (drag && order.length % PAGE_SIZE === 0) {
        for (i = 0; i < PAGE_SIZE; i++) order.push(null);
      }
      state.pages = chunkPages(order.map(function (id) {
        return id == null ? null : (rowById[id] || null);
      }));
    }

    function rerender() { refreshPages(); render(); }

    /* One side of the open binder: the black cover, a 9-pocket card
     * page, or a blank black page rounding out the last spread. Every
     * pocket carries its global slot index for drag-and-drop. */
    function sideHtml(side) {
      if (side === "cover") return coverHtml();
      if (side === null || side === undefined) return '<div class="book-blank"></div>';
      var slots = state.pages[side] || [], html = "", i, base = side * PAGE_SIZE;
      for (i = 0; i < slots.length; i++) html += slots[i] ? detailTile(slots[i], base + i) : emptyPocket(base + i);
      for (i = slots.length; i < PAGE_SIZE; i++) html += emptyPocket(base + i);
      return '<div class="sheet9">' + html + "</div>";
    }

    function coverHtml() {
      var hint = state.pages.length ? "" :
        '<p class="cover-hint">Open any card and pick this binder to shelve copies in it.</p>';
      return '<div class="book-cover"><div class="cover-name">' +
        App.esc(state.name || "Binder") + "</div>" + hint + "</div>";
    }

    function syncChrome() {
      var n = state.pages.length;
      if (wide()) {
        var total = spreadCount(n);
        pageEl.textContent = "Spread " + (state.spread + 1) + " of " + total;
        prevBtn.disabled = state.spread === 0;
        nextBtn.disabled = state.spread >= total - 1;
      } else {
        pageEl.textContent = state.mpage === 0 ? "Cover" : "Page " + state.mpage + " of " + n;
        prevBtn.disabled = state.mpage === 0;
        nextBtn.disabled = state.mpage >= n;
      }
    }

    function renderSpread() {
      var n = state.pages.length, total = spreadCount(n);
      if (state.spread >= total) state.spread = total - 1;
      if (state.spread < 0) state.spread = 0;
      var sides = spreadSides(state.spread, n);
      bookEl.innerHTML =
        '<div class="binder-book">' +
        '<div class="book-page book-left">' + sideHtml(sides.left) + "</div>" +
        '<div class="book-spine"></div>' +
        '<div class="book-page book-right">' + sideHtml(sides.right) + "</div>" +
        "</div>";
      syncChrome();
    }

    function renderMobile() {
      var n = state.pages.length;
      if (state.mpage > n) state.mpage = n;
      if (state.mpage < 0) state.mpage = 0;
      var side = state.mpage === 0 ? "cover" : state.mpage - 1;
      bookEl.innerHTML = '<div class="binder-book mobile"><div class="book-page book-single">' +
        sideHtml(side) + "</div></div>";
      syncChrome();
    }

    function render() {
      if (!bookEl.isConnected) return;
      if (wide()) renderSpread(); else renderMobile();
    }

    /* A physical page-turn: a leaf carrying the outgoing page on its
     * front and the incoming page on its back swings around the spine.
     * The far side is pre-swapped under the leaf (invisible there), so
     * the incoming page is revealed progressively as the leaf swings
     * instead of popping in mid-turn. The leaf's front is cloned from
     * the live page, whose images are already painted, and the back
     * face's images are decoded before the swing starts — no image
     * pop-in flashes either way. */
    function flipLeaf(book, opts) {
      var leaf = document.createElement("div");
      leaf.className = "flip-leaf f-" + opts.side + (opts.dir === 1 ? " f-next" : " f-prev");
      leaf.innerHTML = '<div class="leaf-face leaf-front">' + opts.frontHtml + "</div>" +
        '<div class="leaf-face leaf-back">' + opts.backHtml + "</div>";
      book.appendChild(leaf);
      var done = false;
      function finish() {
        if (done) return; done = true;
        leaf.remove();
        if (opts.done) opts.done();
      }
      /* Warm the incoming face's images while the leaf still sits
       * exactly over the turning page (an invisible seam). A slow
       * image never stalls the flip. */
      var waits = [];
      leaf.querySelectorAll(".leaf-back img").forEach(function (img) {
        if (img.complete && img.naturalWidth) return;
        waits.push(new Promise(function (resolve) {
          var settled = false;
          function fin() { if (!settled) { settled = true; resolve(); } }
          img.addEventListener("load", fin, { once: true });
          img.addEventListener("error", fin, { once: true });
          if (typeof img.decode === "function") {
            try { img.decode().then(fin, fin); } catch (e) { /* events cover it */ }
          }
          setTimeout(fin, 350);
        }));
      });
      Promise.all(waits).then(function () {
        if (!leaf.isConnected) return;
        requestAnimationFrame(function () {
          if (!leaf.isConnected) return;
          void leaf.offsetWidth; /* settle so the transition runs */
          leaf.classList.add("f-go");
          setTimeout(finish, 600);
        });
      });
    }

    function go(delta) {
      if (!bookEl.isConnected || state.flipping) return;
      if (drag) { step(delta); return; } /* instant turn while holding a card */
      var book = bookEl.querySelector(".binder-book");
      if (!book || mqCalm.matches) { step(delta); return; }
      if (wide()) goSpread(book, delta); else goSingle(book, delta);
    }

    /* Instant step for reduced-motion or when the book isn't mounted. */
    function step(delta) {
      if (wide()) {
        var ns = state.spread + delta, total = spreadCount(state.pages.length);
        if (ns < 0 || ns >= total) return;
        state.spread = ns;
      } else {
        var nm = state.mpage + delta;
        if (nm < 0 || nm > state.pages.length) return;
        state.mpage = nm;
      }
      render();
    }

    function goSpread(book, delta) {
      var n = state.pages.length, total = spreadCount(n);
      var ns = state.spread + delta;
      if (ns < 0 || ns >= total) return;
      state.flipping = true;
      var nxt = spreadSides(ns, n);
      /* The far side was pre-swapped under the leaf at turn start; only
       * the side the leaf landed on still needs its final content, so
       * the settled side's nodes are never churned. */
      function after(landEl, landSide) {
        state.flipping = false;
        if (!bookEl.isConnected) return;
        state.spread = ns;
        if (landEl && landEl.isConnected) landEl.innerHTML = sideHtml(landSide);
        syncChrome();
      }
      if (delta === 1) {
        var rightEl = book.querySelector(".book-right");
        var leftEl = book.querySelector(".book-left");
        var frontHtml = rightEl.innerHTML; /* live page: images already painted */
        rightEl.innerHTML = sideHtml(nxt.right); /* hidden behind the leaf until it swings away */
        flipLeaf(book, {
          side: "right", dir: 1,
          frontHtml: frontHtml, backHtml: sideHtml(nxt.left),
          done: function () { after(leftEl, nxt.left); }
        });
      } else {
        var leftEl2 = book.querySelector(".book-left");
        var rightEl2 = book.querySelector(".book-right");
        var frontHtml2 = leftEl2.innerHTML; /* live page: images already painted */
        leftEl2.innerHTML = sideHtml(nxt.left); /* hidden behind the leaf until it swings away */
        flipLeaf(book, {
          side: "left", dir: -1,
          frontHtml: frontHtml2, backHtml: sideHtml(nxt.right),
          done: function () { after(rightEl2, nxt.right); }
        });
      }
    }

    function goSingle(book, delta) {
      var n = state.pages.length, nm = state.mpage + delta;
      if (nm < 0 || nm > n) return;
      state.flipping = true;
      var curSide = state.mpage === 0 ? "cover" : state.mpage - 1;
      var nxtSide = nm === 0 ? "cover" : nm - 1;
      var singleEl = book.querySelector(".book-single");
      flipLeaf(book, {
        side: "single", dir: delta,
        frontHtml: singleEl ? singleEl.innerHTML : sideHtml(curSide), /* live page: images already painted */
        backHtml: sideHtml(nxtSide),
        done: function () {
          state.flipping = false;
          if (!bookEl.isConnected) return;
          state.mpage = nm;
          renderMobile();
        }
      });
    }
    prevBtn.addEventListener("click", function () { go(-1); });
    nextBtn.addEventListener("click", function () { go(1); });

    /* ---------- drag-and-drop arranging ----------
     * Pointer-based so mouse and touch share one code path. Mouse:
     * press and move to pick a card up. Touch: long-press (~350ms) to
     * pick up, so a scroll gesture never starts a drag. While holding a
     * card, hovering near a page edge (or pressing ←/→) turns pages —
     * the drag survives re-renders because it only holds slot indices.
     * Dropping on an occupied pocket swaps; on an empty pocket moves;
     * anywhere else (or Escape) cancels. */
    var drag = null;   // {slotIndex, rowId, ghost, pointerId, target, edgeTimer, edgeWant}
    var cand = null;   // press that may become a drag
    var saveTimer = null;
    var slotOrderReady = true;  // false when the slot_order column is missing
    var saveWarned = false;

    /* Debounced write-back of the pocket order after a drop. */
    function persistOrder() {
      if (!slotOrderReady) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        App.binders.saveSlotOrder(binderId, state.order).catch(function (e) {
          var msg = (e && e.message) || "Couldn't save the arrangement.";
          if (msg.indexOf("migration-binder-slot-order") !== -1) {
            slotOrderReady = false;
            if (!saveWarned) { saveWarned = true; App.ui.toast(msg, "error"); }
            return;
          }
          App.ui.toast(msg, "error");
        });
      }, 400);
    }

    function pocketFromPoint(x, y) {
      var el = document.elementFromPoint(x, y);
      if (!el || !el.closest) return null;
      return el.closest(".binder-pocket");
    }

    function clearTarget() {
      if (!drag) return;
      bookEl.querySelectorAll(".binder-pocket.drop-target").forEach(function (p) {
        p.classList.remove("drop-target", "drop-swap");
      });
      drag.target = -1;
    }

    function setTarget(pocket) {
      if (!drag) return;
      var idx = pocket ? parseInt(pocket.getAttribute("data-slot"), 10) : NaN;
      if (isNaN(idx)) idx = -1;
      if (idx === drag.target) return;
      clearTarget();
      if (idx < 0) return;
      drag.target = idx;
      pocket.classList.add("drop-target");
      if (idx !== drag.slotIndex && state.order[idx] != null) pocket.classList.add("drop-swap");
    }

    function moveGhost(x, y) {
      if (!drag) return;
      var w = drag.ghost.offsetWidth, h = drag.ghost.offsetHeight;
      drag.ghost.style.transform =
        "translate(" + (x - w / 2) + "px," + (y - h / 2) + "px) rotate(3deg) scale(1.06)";
    }

    function edgeWant(x) {
      var book = bookEl.querySelector(".binder-book");
      if (!book) return 0;
      var r = book.getBoundingClientRect();
      if (x < r.left + 56) return -1;
      if (x > r.right - 56) return 1;
      return 0;
    }

    function armEdgeTurn(want) {
      if (!drag) return;
      if (drag.edgeWant === want) return;
      if (drag.edgeTimer) { clearTimeout(drag.edgeTimer); drag.edgeTimer = null; }
      drag.edgeWant = want;
      if (!want) return;
      drag.edgeTimer = setTimeout(function () {
        drag.edgeTimer = null;
        if (!drag || !bookEl.isConnected) return;
        step(want); /* instant turn while holding a card */
        drag.edgeWant = 0;
      }, 550);
    }

    function cancelCand() {
      if (cand && cand.timer) clearTimeout(cand.timer);
      cand = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    }

    function startDrag(x, y) {
      if (!cand || !bookEl.isConnected) { cancelCand(); return; }
      var rowId = state.order[cand.slotIndex];
      var pocket = bookEl.querySelector('.binder-pocket[data-slot="' + cand.slotIndex + '"]');
      if (rowId == null || !pocket) { cancelCand(); return; }
      var art = pocket.querySelector(".art");
      var rect = art.getBoundingClientRect();
      var ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.style.width = rect.width + "px";
      ghost.style.height = rect.height + "px";
      ghost.appendChild(art.cloneNode(true));
      document.body.appendChild(ghost);
      pocket.classList.add("drag-src");
      document.body.classList.add("binder-dragging");
      drag = {
        slotIndex: cand.slotIndex, rowId: rowId, ghost: ghost,
        pointerId: cand.pointerId, target: -1, edgeTimer: null, edgeWant: 0
      };
      if (cand.timer) clearTimeout(cand.timer);
      cand = null; /* keep the window pointer listeners: the drag still needs them */
      moveGhost(x, y);
      if (state.order.length % PAGE_SIZE === 0) rerender(); /* full binder: grow a blank page to drop into */
    }

    function endDrag(x, y) {
      var d = drag;
      drag = null;
      if (!d) return;
      if (d.edgeTimer) clearTimeout(d.edgeTimer);
      document.body.classList.remove("binder-dragging");
      if (d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
      if (!bookEl.isConnected) return;
      var pocket = pocketFromPoint(x, y);
      var idx = pocket ? parseInt(pocket.getAttribute("data-slot"), 10) : NaN;
      if (pocket && !isNaN(idx) && idx !== d.slotIndex) {
        state.order = applyDrop(state.order, d.slotIndex, idx);
        persistOrder();
      }
      rerender();
    }

    function onPointerDown(e) {
      if (drag || cand || state.flipping || !bookEl.isConnected) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      /* Mouse only: suppress the browser's native image drag so our pointerup fires.
         (Touch keeps its default so page scrolling still works pre-long-press.) */
      if (e.pointerType === "mouse" && e.cancelable) e.preventDefault();
      var pocket = e.target && e.target.closest ? e.target.closest(".binder-pocket") : null;
      if (!pocket || pocket.classList.contains("empty")) return;
      var idx = parseInt(pocket.getAttribute("data-slot"), 10);
      if (isNaN(idx)) return;
      cand = { slotIndex: idx, x: e.clientX, y: e.clientY, pointerId: e.pointerId, timer: null };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      if (e.pointerType !== "mouse") {
        cand.timer = setTimeout(function () { if (cand) startDrag(cand.x, cand.y); }, 350);
      }
    }

    function onPointerMove(e) {
      if (!bookEl.isConnected) { if (drag) endDrag(e.clientX, e.clientY); else cancelCand(); return; }
      if (drag) {
        if (e.pointerId !== drag.pointerId) return;
        if (e.pointerType === "mouse" && e.cancelable) e.preventDefault();
        moveGhost(e.clientX, e.clientY);
        setTarget(pocketFromPoint(e.clientX, e.clientY));
        armEdgeTurn(edgeWant(e.clientX));
        return;
      }
      if (!cand || e.pointerId !== cand.pointerId) return;
      var moved = Math.hypot(e.clientX - cand.x, e.clientY - cand.y);
      if (e.pointerType === "mouse") {
        if (moved > 8) startDrag(e.clientX, e.clientY);
      } else if (moved > 12) {
        cancelCand(); /* a scroll, not a press */
      }
    }

    function onPointerUp(e) {
      if (drag && e.pointerId === drag.pointerId) { endDrag(e.clientX, e.clientY); cancelCand(); return; }
      if (cand && e.pointerId === cand.pointerId) cancelCand();
    }

    bookEl.addEventListener("pointerdown", onPointerDown);
    bookEl.addEventListener("dragstart", function (e) { e.preventDefault(); });
    root.querySelector("#bdet-add").addEventListener("click", function () {
      /* Pre-check sets already shelved here — "shelve more like these". */
      var present = {};
      state.items.forEach(function (r) { if (r.set_id) present[r.set_id] = true; });
      openAddCardsModal(binderId, state.name || "this binder", Object.keys(present));
    });
    function onKey(e) {
      if (e.key === "Escape" && drag) { endDrag(-10, -10); return; }
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    }
    document.addEventListener("keydown", onKey);
    mqWide.addEventListener("change", function () {
      if (state.flipping || !bookEl.isConnected) return;
      /* Carry the reader's place across the breakpoint. */
      if (mqWide.matches) state.spread = state.mpage === 0 ? 0 : Math.ceil((state.mpage - 1) / 2);
      else state.mpage = state.spread === 0 ? 0 : 2 * state.spread;
      render();
    });

    try {
      await App.binders.list(); /* warm the cache so direct loads work too */
      var binder = App.binders.byId(binderId);
      if (!binder) {
        root.innerHTML = App.ui.emptyState({ title: "Binder not found", body: "It may have been deleted.", actionHtml: '<a class="btn btn-ghost" href="/binders">Back to binders</a>' });
        return;
      }
      state.name = binder.name;
      nameEl.textContent = binder.name;
      /* The slot_order column only exists after migration-binder-slot-order;
       * without it the arrangement lives in memory for this session. */
      slotOrderReady = binder && ("slot_order" in binder);
      var rows = await App.collection.list();
      state.items = (rows || []).filter(function (r) { return r.binder_id === binderId; });
      var stored = slotOrderReady ? binder.slot_order : null;
      state.order = reconcileSlotOrder(stored, state.items);
      rerender();
      if (slotOrderReady && JSON.stringify(stored || null) !== JSON.stringify(state.order)) {
        /* First run after the migration, or cards shelved/moved outside
         * this view: persist the reconciled order. */
        persistOrder();
      }
    } catch (e) {
      console.warn("[VaultDex] binder detail failed:", e && e.message);
      bookEl.innerHTML = App.ui.emptyState({ title: "Couldn't load this binder", body: "Check your connection and try again." });
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

  /* Pure: chunk slots into 9-pocket pages. */
  function chunkPages(slots) {
    var pages = [];
    (slots || []).forEach(function (s, i) {
      if (i % PAGE_SIZE === 0) pages.push([]);
      pages[pages.length - 1].push(s);
    });
    return pages;
  }

  /* Pure: an open binder shows two pages per spread; spread 0 pairs a
   * black cover (left) with the first card page (right). */
  function spreadCount(pageCount) { return Math.max(1, Math.ceil((pageCount + 1) / 2)); }
  function spreadSides(spread, pageCount) {
    if (spread === 0) return { left: "cover", right: pageCount > 0 ? 0 : null };
    return { left: 2 * spread - 1, right: 2 * spread < pageCount ? 2 * spread : null };
  }

  /* Pocket tile for the flip view: a clear sleeve holding just the card
   * art, like a physical 9-pocket page. One slot per copy; the tiles are
   * draggable to rearrange the binder — card management itself lives in
   * the collection views. */
  function detailTile(item, slotIndex) {
    var gradeBadge = item.grading_company
      ? '<span class="pocket-grade">' + App.esc(item.grading_company) + " " + App.esc(item.grade || "") + "</span>"
      : "";
    var img = item.image_small || "";
    return '<div class="binder-pocket" data-slot="' + slotIndex + '"><div class="art">' +
      '<img loading="lazy" src="' + App.esc(img) + '" alt="' + App.esc((item.card_name || "") + " card art") + '">' +
      gradeBadge + "</div></div>";
  }

  /* Empty sleeves round a partial page out to 9 pockets, like a real
   * binder page that isn't full yet. They are drop targets. */
  function emptyPocket(slotIndex) {
    return '<div class="binder-pocket empty" data-slot="' + slotIndex + '" aria-hidden="true"><div class="art"></div></div>';
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
  App.views.binderDetail.chunkPages = chunkPages;
  App.views.binderDetail.spreadCount = spreadCount;
  App.views.binderDetail.spreadSides = spreadSides;
  App.views.binderDetail.seedSlotOrder = seedSlotOrder;
  App.views.binderDetail.reconcileSlotOrder = reconcileSlotOrder;
  App.views.binderDetail.applyDrop = applyDrop;
})();
