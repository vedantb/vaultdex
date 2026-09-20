/* VaultDex — card detail modal: artwork, details, variant prices, add-to-collection. */
(function () {
  window.App = window.App || {};

  /* Shared: App.util.VARIANT_LABELS (js/util.js). */
  var VARIANT_LABELS = App.util.VARIANT_LABELS;

  /* Inline heart icon for the wishlist toggle (Feature 2). ui.js owns the
   * icon set and is off-limits, so the heart lives here as an SVG string:
   * resting state is stroke-only; CSS fills it when .active. */
  var HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

  function priceRow(label, p) {
    return (
      "<tr><td>" + App.esc(label) + "</td>" +
      "<td>" + App.ui.money(p.low, p.currency) + "</td>" +
      "<td>" + App.ui.money(p.mid, p.currency) + "</td>" +
      "<td>" + App.ui.money(p.high, p.currency) + "</td>" +
      '<td class="market">' + App.ui.money(p.market, p.currency) + "</td></tr>"
    );
  }

  /* Skeleton shimmer span: reserves layout while a value loads. */
  function skel(cls) {
    return '<span class="skel ' + cls + '" aria-hidden="true"></span>';
  }

  /* Pure price-box builder, loading-aware (exposed on App.cardModal for
   * unit tests). While the background price upgrade is pending, the table
   * keeps its full row structure with shimmer cells instead of "—" or a
   * "no data" message — so the modal never grows when the live numbers
   * land. o: { tcgVars, prints, isJa, priceLoading }. */
  function priceBoxHtml(o) {
    var tcgVars = o.tcgVars || [];
    var prints = o.prints || [];
    var isJa = !!o.isJa;
    var loading = !!o.priceLoading;
    var head = "<th>Variant</th><th>Low</th><th>Mid</th><th>High</th><th>Market</th>";
    function wrap(rows) {
      return '<table class="price-table"><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody></table>";
    }
    function skelPriceCells() {
      return "<td>" + skel("price-skel") + "</td><td>" + skel("price-skel") + "</td><td>" + skel("price-skel") + "</td>" +
        '<td class="market">' + skel("price-skel") + "</td>";
    }
    if (loading) {
      if (tcgVars.length) {
        /* Variant labels are known from the snapshot — only numbers shimmer. */
        return wrap(tcgVars.map(function (v) {
          return "<tr><td>" + App.esc(v.label) + "</td>" + skelPriceCells() + "</tr>";
        }).join(""));
      }
      if (isJa) {
        return '<div id="cm-ja-price">' +
          '<table class="price-table"><thead><tr><th>Condition</th><th>Market</th><th>Source</th></tr></thead><tbody>' +
          "<tr><td>Near Mint</td>" + '<td class="market">' + skel("price-skel") + "</td><td>" + skel("label-skel") + "</td></tr>" +
          "</tbody></table></div>";
      }
      /* Upgrade pending but the snapshot had no price rows at all: reserve
       * space with a best-guess row count (true printings when known). */
      var n = prints.length || 3;
      var rows = [];
      for (var i = 0; i < n; i++) {
        rows.push("<tr><td>" + skel("label-skel") + "</td>" + skelPriceCells() + "</tr>");
      }
      return wrap(rows.join(""));
    }
    if (tcgVars.length) {
      return wrap(tcgVars.map(function (v) { return priceRow(v.label, v.prices || {}); }).join(""));
    } else if (isJa) {
      // Japanese cards have no TCGdex pricing — fetch the PkmnPrices
      // Near Mint market price for the Japanese printing on demand.
      return '<div id="cm-ja-price"><p style="color:var(--muted);font-size:0.9rem">Looking up Japanese market price…</p></div>';
    }
    return '<p style="color:var(--muted);font-size:0.9rem">No TCGPlayer price data for this card.</p>';
  }

  /* Japanese price formatting is App.ui.money (js/ui.js) — same "—" for
   * missing prices, € for EUR rows. */
  /* On-demand Japanese market price for the modal. Fetches the PkmnPrices
   * Near Mint price for the exact Japanese printing of the selected
   * variant — a few credits per lookup, never in bulk. */
  async function refreshJaPrice(m, card, isJa, getBox) {
    if (!isJa) return;
    var box = m.el.querySelector("#cm-ja-price");
    if (!box) return;
    var selectedBox = getBox ? getBox() : null;
    box.innerHTML = '<p style="color:var(--muted);font-size:0.9rem">Looking up Japanese market price…</p>';
    try {
      var pm = await App.pkmn.findVariantPrice({
        name: card.name,
        setName: card.set && card.set.name,
        number: card.number,
        lang: "ja",
        pkmnLabel: selectedBox ? selectedBox.pkmnLabel : null,
        priceVariant: selectedBox ? selectedBox.priceVariant : null
      });
      if (pm && typeof pm.price === "number") {
        var src = pm.source === "cardmarket" ? "Cardmarket" : "TCGPlayer";
        box.innerHTML =
          '<table class="price-table"><thead><tr><th>Condition</th><th>Market</th><th>Source</th></tr></thead>' +
          "<tbody><tr><td>Near Mint" + (pm.variant ? " · " + App.esc(pm.variant) : "") + "</td>" +
          '<td class="market">' + App.ui.money(pm.price, pm.currency) + "</td>" +
          "<td>" + App.esc(src) + "</td></tr></tbody></table>";
      } else {
        box.innerHTML = '<p style="color:var(--muted);font-size:0.9rem">No Japanese price data for this printing yet.</p>';
      }
    } catch {
      box.innerHTML = '<p style="color:var(--muted);font-size:0.9rem">Couldn\u2019t reach live pricing.</p>';
    }
  }

  /* Rarities that earn the holographic foil layer on the modal art.
   * Plain "Rare" stays flat; everything fancier gets the rainbow. */
  function isHoloRarity(rarity) {
    var r = String(rarity || "").toLowerCase().trim();
    if (!r || r === "rare") return false;
    return /holo|double rare|ultra rare|illustration|hyper|secret|amazing|radiant|shiny|prism|ace spec/.test(r);
  }

  /* Row identity for the live stepper: (normalized variant label, pkmn_id,
   * grading company, grade) — mirrors addItem's duplicate check in
   * js/collection.js so the stepper always binds the exact row addItem
   * would bump. Pure; exposed on App.cardModal for unit tests. */
  function normVLabel(v) {
    if (App.tcg && App.tcg.normVLabel) return App.tcg.normVLabel(v);
    return String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function findBoundRow(rows, variantLabel, pkmnId, grading) {
    var wantV = normVLabel(variantLabel);
    var gC = (grading && grading.company) || null;
    var gG = (grading && grading.grade) || null;
    var cands = (rows || []).filter(function (r) {
      return normVLabel(r.variant) === wantV &&
        (r.grading_company || null) === gC && (r.grade || null) === gG;
    });
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    var wantP = pkmnId || null;
    return cands.filter(function (r) { return (r.pkmn_id || null) === wantP; })[0] || cands[0];
  }
  App.cardModal = { findBoundRow: findBoundRow, flipTransform: flipTransform, priceBoxHtml: priceBoxHtml };

  /* Pure FLIP math: given source and destination rects, the transform that
   * places a top-left-origin element from the destination rect onto the
   * source rect. Exposed on App.cardModal for unit tests. */
  function flipTransform(src, dst) {
    return {
      dx: src.left - dst.left,
      dy: src.top - dst.top,
      sx: dst.width ? src.width / dst.width : 1,
      sy: dst.height ? src.height / dst.height : 1
    };
  }

  /* Tile-to-modal FLIP (2026-09-20): a shared-element morph done right.
   * "Load the card first, then reveal around it": the dialog renders fully
   * but stays invisible while the full-res artwork preloads. A ghost clone
   * of the tile art pins over the source at frame one so the tap feels
   * instant; once the art is decoded the backdrop fades in around the card
   * and the ghost flies to the art slot (Web Animations API), swapping with
   * the real artwork on landing. One continuous motion — never pop-then-fly,
   * and never a late image pop-in. `source` is the tile art element. Skipped
   * for reduced-motion users and when the source is gone. */
  async function flipFromTile(m, source) {
    var overlay = m.el;
    if (!source || App.ui.reduceMotion) return;
    var srcRect = null, imgSrc = null;
    if (typeof source.getBoundingClientRect === "function") {
      if (!source.isConnected) return;
      srcRect = source.getBoundingClientRect();
      var sImg = source.tagName === "IMG" ? source : source.querySelector("img");
      if (sImg) imgSrc = sImg.currentSrc || sImg.src;
    }
    if (!srcRect || !srcRect.width || !srcRect.height || !imgSrc) return;
    var artBox = overlay.querySelector(".card-detail .art");
    var img = artBox && artBox.querySelector("img");
    if (!artBox || !img) return;

    /* Phase 1 — prep, invisible: the dialog lays out (so the landing rect
     * is measurable) while the full-res art preloads. The ghost pins over
     * the tile immediately so the tap reads as instant. */
    overlay.classList.add("flip-prep");
    artBox.style.visibility = "hidden";
    var ghost = document.createElement("img");
    ghost.src = imgSrc;
    ghost.alt = "";
    ghost.setAttribute("aria-hidden", "true");
    ghost.className = "flip-ghost";
    ghost.style.left = srcRect.left + "px";
    ghost.style.top = srcRect.top + "px";
    ghost.style.width = srcRect.width + "px";
    ghost.style.height = srcRect.height + "px";
    document.body.appendChild(ghost);

    var done = false;
    function cleanup() {
      if (done) return;
      done = true;
      clearTimeout(failsafe);
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
      if (overlay.isConnected) {
        /* The dialog has been on screen since the reveal — keep its pop
         * entrance suppressed so it can never replay as a glitchy
         * second pop. */
        overlay.classList.remove("flip-prep");
        overlay.classList.remove("flip-live");
        overlay.classList.add("flip-done");
      }
      if (artBox.isConnected) artBox.style.visibility = "";
    }
    /* Hard failsafe: the dialog must never get stuck invisible. */
    var failsafe = setTimeout(cleanup, 2500);

    function preloadArt(el, ms) {
      return new Promise(function (resolve) {
        if (el.complete && el.naturalWidth > 0) { resolve(true); return; }
        var to = setTimeout(function () { resolve(el.complete && el.naturalWidth > 0); }, ms);
        el.addEventListener("load", function () { clearTimeout(to); resolve(true); }, { once: true });
        el.addEventListener("error", function () { clearTimeout(to); resolve(false); }, { once: true });
      });
    }

    try {
      await preloadArt(img, 900);
      try { if (img.decode) await img.decode(); } catch (e) { /* keep going */ }
    } catch (e) { /* keep going — the ghost still flies */ }
    if (done || !overlay.isConnected) { cleanup(); return; }

    var dst = artBox.getBoundingClientRect();
    if (!dst.width || !dst.height) { cleanup(); return; }
    /* Forward transform: places the src-positioned ghost onto dst. */
    var t = flipTransform(dst, srcRect);
    /* A tile already at the destination size/spot needs no morph. */
    var atDest = Math.abs(t.dx) < 2 && Math.abs(t.dy) < 2 &&
      Math.abs(t.sx - 1) < 0.02 && Math.abs(t.sy - 1) < 0.02;

    /* Phase 2 — reveal + flight: the backdrop fades in around the card
     * while the ghost morphs to the art slot. */
    overlay.classList.remove("flip-prep");
    overlay.classList.add("flip-live");
    if (!atDest && typeof ghost.animate === "function") {
      ghost.style.transformOrigin = "top left";
      try {
        var anim = ghost.animate([
          { transform: "translate(0px, 0px) scale(1, 1)" },
          { transform: "translate(" + t.dx + "px," + t.dy + "px) scale(" + t.sx + "," + t.sy + ")" }
        ], { duration: 480, easing: "cubic-bezier(0.22, 0.9, 0.26, 1)", fill: "forwards" });
        await anim.finished;
      } catch (e) { /* WAAPI aborted — fall through to cleanup */ }
    }
    cleanup();
  }

  function render(card, sourceEl, opts) {
    /* priceLoading: the modal opened on snapshot data and a live price
     * upgrade is on its way — price regions render skeleton shimmers so
     * the layout can't shift when the numbers land. */
    var priceLoading = !!(opts && opts.priceLoading);
    var tcgVars = App.tcg.variantsOf(card);
    var prints = App.tcg.printVariants(card); // true printings: Normal, Poké Ball, Energy Symbol, Holo, …
    var selectedBox = prints.length ? prints[0] : null;
    var selected = selectedBox ? selectedBox.label : (tcgVars.length ? tcgVars[0].key : "normal");
    var isJa = (card.set && card.set.lang) === "ja";

    /* Builders below read the live pricing state so the background upgrade
     * can re-render the price-driven regions in place. */
    function chipsHtml(c) {
      var chips = [];
      if (c.rarity) chips.push('<span class="chip accent">' + App.esc(c.rarity) + "</span>");
      if (c.supertype) chips.push('<span class="chip">' + App.esc(c.supertype) + "</span>");
      if (c.hp) chips.push('<span class="chip">HP ' + App.esc(c.hp) + "</span>");
      if (c.types && c.types.length) {
        c.types.forEach(function (t) { chips.push('<span class="chip">' + App.esc(t) + "</span>"); });
      }
      return chips.join("");
    }

    function buildPriceHtml() {
      return App.cardModal.priceBoxHtml({ tcgVars: tcgVars, prints: prints, isJa: isJa, priceLoading: priceLoading });
    }

    function pillsHtml() {
      if (priceLoading && !prints.length) {
        /* Live prices still incoming: keep pill widths stable with a
         * shimmer where each not-yet-known price will land. */
        return tcgVars.map(function (v) {
          var bit = (v.prices && typeof v.prices.market === "number")
            ? " · " + App.ui.money(v.prices.market)
            : " " + skel("pill-skel");
          return '<button class="variant-pill' + (v.key === selected ? " active" : "") + '" data-variant="' + v.key + '">' +
            App.esc(v.label) + bit + "</button>";
        }).join("");
      }
      if (prints.length) {
        return prints.map(function (b) {
          return '<button class="variant-pill' + (b.label === selected ? " active" : "") + '" data-label="' + App.esc(b.label) + '">' +
            App.esc(b.label) + "</button>";
        }).join("");
      }
      return tcgVars.map(function (v) {
        return '<button class="variant-pill' + (v.key === selected ? " active" : "") + '" data-variant="' + v.key + '">' +
          App.esc(v.label) +
          (typeof v.prices.market === "number" ? " · " + App.ui.money(v.prices.market) : "") +
          "</button>";
      }).join("");
    }

    /* Graded collection rows: carry the slab onto the card so render()
     * shows the gold grade badge next to the title. */
    var gradeBadgeHtml = card.gradingCompany
      ? ' <span class="grade-badge">' + App.esc(card.gradingCompany) + " " + App.esc(card.grade || "") + "</span>"
      : "";

    var html =
      '<div class="card-detail">' +
        '<div class="art"><img src="' + App.esc(card.images && (card.images.large || card.images.small)) + '" alt="' + App.esc(card.name) + ' card artwork" loading="eager" fetchpriority="high"></div>' +
        "<div>" +
          /* Graded copies name the slab next to the title; the wishlist heart
           * (owner-only) stays as-is beside it. */
          (App.auth.isOwner()
            ? '<div class="wish-title-row"><h2>' + App.esc(card.name) + gradeBadgeHtml + "</h2>" +
              '<button type="button" class="wish-btn" id="cm-wish" aria-label="Save to wishlist" title="Save to wishlist">' + HEART_SVG + "</button></div>"
            : "<h2>" + App.esc(card.name) + gradeBadgeHtml + "</h2>") +
          '<div class="sub">' + App.esc((card.set && card.set.name) || "") + " · #" + App.esc(card.number || "?") + "</div>" +
          '<div class="detail-chips" id="cm-chips">' + chipsHtml(card) + "</div>" +
          '<div class="field" style="margin-bottom:6px"><label>Illustrated by</label><div id="cm-artist" style="font-weight:600">' + App.esc(card.artist || "Unknown artist") + "</div></div>" +
          "<h4 style=\"margin:16px 0 8px\">Market prices</h4>" +
          '<div id="cm-pricebox"' + (priceLoading ? ' aria-busy="true"' : "") + ">" + buildPriceHtml() + "</div>" +
          /* Owned copies: filled in by refreshOwnedLine() once the shared
           * quantity index loads. Public data — shown to visitors too. */
          '<div class="owned-line" id="cm-owned" aria-live="polite"></div>' +
          (App.auth.isOwner()
            ? '<div class="field" id="cm-variant-field" style="margin-bottom:10px"' + (pillsHtml() ? "" : " hidden") + '><label>Variant</label><div class="variant-picker" id="cm-pills">' + pillsHtml() + "</div></div>" +
              /* Grading (Feature 5): owner-only toggle; checked means this copy
               * is a PSA slab — pick the grade from the dropdown. At add time
               * the price comes from exact PSA+grade eBay sold comps when
               * they exist, else Near Mint raw (labeled). */
              '<div class="field" style="margin-bottom:10px"><label>Grading</label>' +
                '<label class="grade-check"><input type="checkbox" id="cm-graded-toggle"> This copy is graded (PSA)</label>' +
                '<div id="cm-graded-fields" hidden>' +
                  '<select id="cm-grade-value" aria-label="PSA grade">' +
                    '<option value="10" selected>Grade 10</option>' +
                    '<option value="9">Grade 9</option>' +
                    '<option value="8">Grade 8</option>' +
                    '<option value="7">Grade 7</option>' +
                    '<option value="6">Grade 6</option>' +
                    '<option value="5">Grade 5</option>' +
                    '<option value="4">Grade 4</option>' +
                    '<option value="3">Grade 3</option>' +
                    '<option value="2">Grade 2</option>' +
                    '<option value="1">Grade 1</option>' +
                  "</select>" +
                "</div>" +
              "</div>" +
              /* Live owned-quantity stepper: bound to the owned row for the
               * currently selected variant (or graded slab). [+] grows the
               * row, [-] shrinks it; [-] at 1 removes the row with Undo.
               * The context label always names what the stepper edits. */
              '<div class="field" style="margin-bottom:10px"><label id="cm-own-label">Owned</label>' +
                '<div class="stepper" role="group" aria-label="Owned quantity">' +
                  '<button id="cm-minus" aria-label="Remove one copy">' + App.ui.icon("minus") + "</button>" +
                  '<span class="qty" id="cm-qty">0</span>' +
                  '<button id="cm-plus" aria-label="Add one copy">' + App.ui.icon("plus") + "</button>" +
                "</div>" +
              "</div>"
            : '<p style="font-size:0.85rem;color:var(--muted);margin:12px 0 0">Only the owner can add to this collection.</p>') +
          '<p style="font-size:0.78rem;color:var(--muted);margin:12px 0 0">' +
            (isJa
              ? "Japanese market prices via PkmnPrices (Near Mint)."
              : "Prices are TCGPlayer market values (USD).") +
          "</p>" +
        "</div>" +
      "</div>";

    var unsubOwned = null;
    var m = App.ui.openModal(html, {
      onClose: function () {
        if (unsubOwned) { try { unsubOwned(); } catch { /* ignored */ } unsubOwned = null; }
        /* Pack-pull context: the fan stage was sunk below this dialog; float
         * it back so closing the detail returns to the other pulls. */
        var ps = document.querySelector(".pack-stage.pack-behind");
        if (ps) ps.classList.remove("pack-behind");
      }
    });
    /* Pack-pull context: the tapped card came from a pack reveal fan. Keep
     * the stage mounted behind the dialog (instead of unmounting it) so the
     * other two pulls are still there when the detail closes. */
    var packStage = sourceEl && sourceEl.closest ? sourceEl.closest(".pack-stage") : null;
    if (packStage) packStage.classList.add("pack-behind");
    /* Tile-to-modal FLIP: morph the tapped tile's art into the dialog. */
    flipFromTile(m, sourceEl);

    /* "In your collection" line: total owned copies plus a per-variant
     * breakdown. Refreshes live after adds and on collection:changed
     * (e.g. a set-page checkbox toggled behind the modal). */
    function ownedLineHtml(entry) {
      if (!entry || !entry.qty) {
        return '<span class="owned-none">Not in your collection yet</span>';
      }
      return "In your collection: <strong>×" + entry.qty + "</strong>" +
        (entry.variants.length
          ? ' <span class="owned-breakdown">' + App.esc(App.ownedQty.breakdownText(entry.variants)) + "</span>"
          : "");
    }
    async function refreshOwnedLine() {
      var box = m.el.querySelector("#cm-owned");
      if (!box) return;
      if (!App.ownedQty) { box.innerHTML = ""; return; }
      try {
        var entry = await App.ownedQty.getCard(card.id);
        if (!box.isConnected) return;
        box.innerHTML = ownedLineHtml(entry);
      } catch {
        if (box.isConnected) box.innerHTML = "";
      }
    }
    refreshOwnedLine();
    if (typeof App.on === "function") {
      /* Also rebinds the live stepper (function declarations are hoisted,
       * so refreshOwnedRows/paintStepper exist by the time this fires) —
       * e.g. a set-page checkbox toggled behind the modal. */
      unsubOwned = App.on("collection:changed", function () {
        refreshOwnedLine();
        refreshOwnedRows().then(function () {
          if (m.el.isConnected) paintStepper();
        }, function () { /* keep last known state */ });
      });
    }
    /* Pointer-reactive 3D tilt + glare on the card art (+ holo foil for rare
     * cards). Desktop hover only — the art stays flat on touch and when the
     * user prefers reduced motion. */
    (function tiltArt() {
      var fine = typeof window.matchMedia === "function" &&
        window.matchMedia("(hover: hover) and (pointer: fine)").matches;
      if (!fine || App.ui.reduceMotion) return;
      var art = m.el.querySelector(".card-detail .art");
      if (!art) return;
      art.classList.add("tilt-wrap", "tilt");
      var glare = document.createElement("span");
      glare.className = "glare";
      art.insertBefore(glare, art.firstChild);
      if (isHoloRarity(card.rarity)) art.classList.add("holo");
      art.addEventListener("pointermove", function (e) {
        var b = art.getBoundingClientRect();
        var mx = ((e.clientX - b.left) / b.width) * 100;
        var my = ((e.clientY - b.top) / b.height) * 100;
        art.style.setProperty("--mx", Math.max(0, Math.min(100, mx)).toFixed(1));
        art.style.setProperty("--my", Math.max(0, Math.min(100, my)).toFixed(1));
      });
      art.addEventListener("pointerleave", function () {
        art.style.setProperty("--mx", 50);
        art.style.setProperty("--my", 50);
      });
    })();
    // Non-owner viewers: read-only card details, no add controls.
    if (!m.el.querySelector("#cm-minus")) { refreshJaPrice(m, card, isJa, function () { return selectedBox; }); return; }
    refreshJaPrice(m, card, isJa, function () { return selectedBox; });

    /* Live owned-quantity stepper. ownedRows holds this card's full
     * collection rows so +/- can write through setQuantity/remove and the
     * Undo toast can restore a removed row verbatim. Writes serialize
     * through a promise chain so rapid taps can't corrupt quantities. */
    var ownedRows = [];
    var writing = false;
    var writeChain = Promise.resolve();

    function currentGrading() {
      // Grading (Feature 5): { company, grade } or null. Company is always
      // PSA; the grade comes from the dropdown.
      var gt = m.el.querySelector("#cm-graded-toggle");
      if (gt && gt.checked) {
        var gv = m.el.querySelector("#cm-grade-value");
        var gGrade = gv ? gv.value : "";
        if (gGrade) return { company: "PSA", grade: gGrade };
      }
      return null;
    }
    function currentVariantLabel() {
      if (selectedBox) return selectedBox.label;
      return VARIANT_LABELS[selected] || selected;
    }
    function boundRow(pkmnId) {
      return findBoundRow(ownedRows, currentVariantLabel(), pkmnId || null, currentGrading());
    }
    async function refreshOwnedRows() {
      var u = App.auth && App.auth.user;
      if (!u) { ownedRows = []; return ownedRows; }
      var res = await App.sb.from("collection_items").select("*")
        .eq("user_id", u.id)
        .eq("card_id", card.id);
      if (res.error) throw res.error;
      ownedRows = res.data || [];
      return ownedRows;
    }
    function stepperLabel(row) {
      var grading = currentGrading();
      var ctx = grading ? grading.company + " " + grading.grade : currentVariantLabel();
      if (row && row.quantity > 0) return ctx + " · ×" + row.quantity + " owned";
      return ctx + " · not owned yet";
    }
    function paintStepper() {
      var qtyEl = m.el.querySelector("#cm-qty");
      var labelEl = m.el.querySelector("#cm-own-label");
      var minus = m.el.querySelector("#cm-minus");
      var plus = m.el.querySelector("#cm-plus");
      if (!qtyEl) return;
      var row = boundRow(null);
      var q = row ? row.quantity : 0;
      qtyEl.textContent = q;
      if (labelEl) labelEl.textContent = stepperLabel(row);
      if (minus) minus.disabled = writing || q <= 0;
      if (plus) plus.disabled = writing;
    }
    /* Lazy exact PkmnPrices match for the chosen printing (a few credits) —
     * only when creating a brand-new row; bumps never re-resolve pricing.
     * A miss still saves the card and the next price refresh fills it in. */
    async function resolvePkmn() {
      if (!selectedBox) return null;
      try {
        var pm = await App.pkmn.findVariantPrice({
          name: card.name,
          setName: card.set && card.set.name,
          number: card.number,
          lang: (card.set && card.set.lang) || "en",
          pkmnLabel: selectedBox.pkmnLabel,
          priceVariant: selectedBox.priceVariant
        });
        if (pm && pm.pkmnId) return pm;
      } catch (e) {
        console.warn("[VaultDex] PkmnPrices variant match failed:", e && e.message);
      }
      return null;
    }
    function showUndo(vlabel, grading, snapshot) {
      var gLabel = grading ? " " + grading.company + " " + grading.grade : "";
      App.ui.toast("Removed " + card.name + " (" + vlabel + gLabel + ") from your collection.", "info", {
        label: "Undo",
        ms: 6000,
        onClick: function () {
          enqueue(async function () {
            await App.collection.restoreRow(snapshot);
            await afterWrite();
          });
        }
      });
    }
    async function afterWrite() {
      /* setQuantity/remove/addItem all emit collection:changed, which
       * invalidates the shared owned-qty index and repaints tile badges;
       * refresh our local rows + both live readouts here. */
      await refreshOwnedRows();
      if (App.ownedQty) App.ownedQty.invalidate();
      await refreshOwnedLine();
    }
    async function doAdjust(delta) {
      if (!App.collection.needUser()) return;
      var grading = currentGrading();
      var vlabel = currentVariantLabel();
      await refreshOwnedRows();
      var row = boundRow(null);
      if (delta > 0) {
        if (row) {
          await App.collection.setQuantity(row.id, row.quantity + 1);
        } else {
          var pm = await resolvePkmn();
          /* Re-check with the resolved pkmn_id: a row for this exact
           * printing may already exist under a different label spelling. */
          await refreshOwnedRows();
          row = boundRow(pm ? pm.pkmnId : null);
          if (row) {
            await App.collection.setQuantity(row.id, row.quantity + 1);
          } else {
            await App.collection.addItem(card, vlabel, 1, pm ? {
              pkmnId: pm.pkmnId,
              label: vlabel,
              resolved: pm
            } : null, grading);
          }
        }
      } else {
        if (!row) return;
        if (row.quantity > 1) {
          await App.collection.setQuantity(row.id, row.quantity - 1);
        } else {
          var snapshot = Object.assign({}, row);
          await App.collection.remove(row.id);
          showUndo(vlabel, grading, snapshot);
        }
      }
      await afterWrite();
    }
    function enqueue(fn) {
      writeChain = writeChain.then(function () {
        writing = true;
        paintStepper();
        return fn();
      }).catch(function (err) {
        App.handleApiError(err);
      }).then(function () {
        writing = false;
        if (m.el.isConnected) paintStepper();
      });
      return writeChain;
    }
    m.el.querySelector("#cm-minus").addEventListener("click", function () { enqueue(function () { return doAdjust(-1); }); });
    m.el.querySelector("#cm-plus").addEventListener("click", function () { enqueue(function () { return doAdjust(1); }); });
    function rebindStepper() {
      /* Variant pills and the grading controls choose which row the
       * stepper edits — repaint the binding instantly. */
      if (m.el.isConnected) paintStepper();
    }
    function bindPills() {
      m.el.querySelectorAll(".variant-pill").forEach(function (btn) {
        btn.addEventListener("click", function () {
          m.el.querySelectorAll(".variant-pill").forEach(function (b) { b.classList.remove("active"); });
          btn.classList.add("active");
          if (prints.length) {
            var lbl = btn.getAttribute("data-label");
            selected = lbl;
            selectedBox = prints.filter(function (b) { return b.label === lbl; })[0] || null;
          } else {
            selectedBox = null;
            selected = btn.getAttribute("data-variant");
          }
          refreshJaPrice(m, card, isJa, function () { return selectedBox; });
          rebindStepper();
        });
      });
    }
    bindPills();
    var gradeToggle = m.el.querySelector("#cm-graded-toggle");
    var gradeFields = m.el.querySelector("#cm-graded-fields");
    var gradeValue = m.el.querySelector("#cm-grade-value");
    if (gradeToggle && gradeFields) {
      gradeToggle.addEventListener("change", function () {
        gradeFields.hidden = !gradeToggle.checked;
        rebindStepper();
      });
    }
    if (gradeValue) {
      gradeValue.addEventListener("change", rebindStepper);
    }
    /* Keep the stepper in sync when the collection changes behind the
     * modal — handled by the collection:changed subscription above. */
    refreshOwnedRows().then(function () {
      if (m.el.isConnected) paintStepper();
    }, function (e) {
      console.warn("[VaultDex] owned rows failed:", e && e.message);
    });
    /* Wishlist heart (owner-only): toggles this card for the currently
     * selected variant pill. Fully separate from the stepper flow above —
     * neither can break the other. */
    (function () {
      var wishBtn = m.el.querySelector("#cm-wish");
      if (!wishBtn) return;
      function setWished(on) {
        wishBtn.classList.toggle("active", !!on);
        var lbl = on ? "Remove from wishlist" : "Save to wishlist";
        wishBtn.setAttribute("aria-label", lbl);
        wishBtn.setAttribute("title", lbl);
      }
      if (!App.wishlist) {
        wishBtn.addEventListener("click", function () {
          App.ui.toast("Wishlist isn't available right now.", "info");
        });
        return;
      }
      App.wishlist.isWished(card.id).then(setWished, function () { /* leave resting state */ });
      wishBtn.addEventListener("click", async function () {
        if (!App.collection.needUser()) return;
        wishBtn.disabled = true;
        try {
          // `selected` always reflects the currently active variant pill.
          var wished = await App.wishlist.toggle(card, selected);
          setWished(wished);
          App.ui.toast(wished ? "Saved to wishlist." : "Removed from wishlist.", "success");
        } catch (e) {
          App.handleApiError(e);
        }
        wishBtn.disabled = false;
      });
    })();

    /* Background price upgrade: the modal opened instantly on snapshot
     * data; when the live card arrives, patch the price-driven regions in
     * place. Art, title and layout never move — only numbers and labels
     * fill in. */
    function upgrade(live) {
      if (!live || !m.el.isConnected) return;
      /* The live numbers are here — drop the loading state before
       * re-rendering so skeletons swap for values in place. */
      priceLoading = false;
      var keepLabel = selectedBox ? selectedBox.label : (VARIANT_LABELS[selected] || selected);
      tcgVars = App.tcg.variantsOf(live);
      prints = App.tcg.printVariants(live);
      if (prints.length) {
        selectedBox = prints.filter(function (b) { return b.label === keepLabel; })[0] || prints[0];
        selected = selectedBox.label;
      } else {
        selectedBox = null;
        var match = tcgVars.filter(function (v) { return (VARIANT_LABELS[v.key] || v.key) === keepLabel; })[0];
        selected = match ? match.key : (tcgVars.length ? tcgVars[0].key : "normal");
      }
      isJa = (live.set && live.set.lang) === "ja";
      card = live; /* stepper, wishlist and add flows now see the live card */
      var box = m.el.querySelector("#cm-pricebox");
      if (box) {
        box.removeAttribute("aria-busy");
        box.innerHTML = buildPriceHtml();
        if (isJa) refreshJaPrice(m, live, true, function () { return selectedBox; });
      }
      var chipsEl = m.el.querySelector("#cm-chips");
      if (chipsEl) chipsEl.innerHTML = chipsHtml(live);
      var artistEl = m.el.querySelector("#cm-artist");
      if (artistEl) artistEl.textContent = live.artist || "Unknown artist";
      var vf = m.el.querySelector("#cm-variant-field");
      if (vf) {
        var ph = pillsHtml();
        vf.hidden = !ph;
        var pw = m.el.querySelector("#cm-pills");
        if (pw) {
          pw.innerHTML = ph;
          bindPills();
        }
      }
      if (m.el.isConnected) paintStepper();
    }

    return { el: m.el, close: m.close, upgrade: upgrade };
  }

  /* Snapshot-grade cards carry market-only pricing; live cards carry full
   * low/mid/high. The modal opens instantly on whatever it has and
   * background-upgrades when only the slim prices are present. Japanese
   * cards never upgrade: TCGdex carries no JA pricing and the baked catalog
   * prices are already the best source. */
  function needsPriceUpgrade(card) {
    if (!card || (card.set && card.set.lang) === "ja") return false;
    try {
      return !App.tcg.variantsOf(card).some(function (v) {
        return v.prices && (typeof v.prices.low === "number" || typeof v.prices.high === "number");
      });
    } catch {
      return true;
    }
  }

  /* Accepts a card object (tile/search results) or a card id. Objects and
   * snapshot hits render instantly — tap -> pixels with no round-trip —
   * while the live card upgrades the price regions in the background.
   * fallbackRow: a collection row used to render a basic detail view when
   * the card has no catalog record (e.g. pkmn.gg fallback imports).
   * sourceEl: the tile art element the modal FLIP-morphs from; omit for a
   * plain entrance. */
  App.openCardModal = async function (cardOrId, lang, fallbackRow, sourceEl) {
    try {
      var card = null, upgradePromise = null;
      if (typeof cardOrId === "string") {
        card = await App.tcg.getCardLocal(cardOrId, lang);
        if (card) {
          upgradePromise = App.tcg.getCard(cardOrId, lang).then(function (c) { return c; }, function () { return null; });
        } else {
          card = await App.tcg.getCard(cardOrId, lang);
        }
      } else {
        card = cardOrId;
        if (needsPriceUpgrade(card)) {
          upgradePromise = App.tcg.getCard(card.id, lang).then(function (c) { return c; }, function () { return null; });
        }
      }
      if (!card) throw new Error("Card not found.");
      // Already-graded collection row: carry the slab onto the card so
      // render() can show the grade badge near the title.
      if (fallbackRow && fallbackRow.grading_company && !card.gradingCompany) {
        card.gradingCompany = fallbackRow.grading_company;
        card.gradingGrade = fallbackRow.grade || null;
      }
      var handle = render(card, sourceEl, { priceLoading: !!upgradePromise });
      if (upgradePromise) {
        upgradePromise.then(function (live) {
          /* Patch only when the instant card actually had slim pricing —
           * a live-grade object needs no touch. */
          if (live && needsPriceUpgrade(card)) handle.upgrade(live);
        });
      }
    } catch (e) {
      if (fallbackRow) {
        try {
          render(cardFromRow(fallbackRow, lang), sourceEl);
          return;
        } catch { /* fall through to the error toast */ }
      }
      App.handleApiError(e);
    }
  };

  /* Minimal card object synthesized from a stored collection row, so cards
   * missing from the catalog still open a detail view with artwork. */
  function cardFromRow(row, lang) {
    var isJa = lang === "ja" || App.util.isJa(row);
    return {
      id: row.card_id,
      name: row.card_name || row.card_id,
      number: row.number || null,
      images: { small: row.image_small || null, large: row.image_large || row.image_small || null },
      set: { id: row.set_id || null, name: row.set_name || "", lang: isJa ? "ja" : "en" },
      rarity: row.rarity || null,
      artist: row.artist || null,
      gradingCompany: row.grading_company || null,
      gradingGrade: row.grade || null,
      supertype: null,
      hp: null,
      types: []
    };
  }
})();
