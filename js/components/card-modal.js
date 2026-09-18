/* VaultDex — card detail modal: artwork, details, variant prices, add-to-collection. */
(function () {
  window.App = window.App || {};

  /* Shared: App.util.VARIANT_LABELS (js/util.js). */
  var VARIANT_LABELS = App.util.VARIANT_LABELS;

  /* Inline heart icon for the wishlist toggle (Feature 2). ui.js owns the
   * icon set and is off-limits, so the heart lives here as an SVG string:
   * resting state is stroke-only; CSS fills it when .active. */
  var HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

  /* Toast text for the add flow. Graded copies name the slab; when grading
   * was requested but only the raw Near Mint price was available, say so. */
  function gradedAddMsg(card, qty, variantLabel, grading, res) {
    var gLabel = grading ? " " + grading.company + " " + grading.grade : "";
    var note = (grading && res && res.priceSource && res.priceSource !== "pkmnprices-graded")
      ? " Graded price unavailable — showing Near Mint raw." : "";
    return "Added " + qty + "× " + card.name + " (" + variantLabel + gLabel + ") to your collection." + note;
  }

  function priceRow(label, p) {
    return (
      "<tr><td>" + App.esc(label) + "</td>" +
      "<td>" + App.ui.money(p.low, p.currency) + "</td>" +
      "<td>" + App.ui.money(p.mid, p.currency) + "</td>" +
      "<td>" + App.ui.money(p.high, p.currency) + "</td>" +
      '<td class="market">' + App.ui.money(p.market, p.currency) + "</td></tr>"
    );
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
    } catch (e) {
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

  function render(card) {
    var tcgVars = App.tcg.variantsOf(card);
    var prints = App.tcg.printVariants(card); // true printings: Normal, Poké Ball, Energy Symbol, Holo, …
    var selectedBox = prints.length ? prints[0] : null;
    var selected = selectedBox ? selectedBox.label : (tcgVars.length ? tcgVars[0].key : "normal");
    var isJa = (card.set && card.set.lang) === "ja";

    var chips = [];
    if (card.rarity) chips.push('<span class="chip accent">' + App.esc(card.rarity) + "</span>");
    if (card.supertype) chips.push('<span class="chip">' + App.esc(card.supertype) + "</span>");
    if (card.hp) chips.push('<span class="chip">HP ' + App.esc(card.hp) + "</span>");
    if (card.types && card.types.length) {
      card.types.forEach(function (t) { chips.push('<span class="chip">' + App.esc(t) + "</span>"); });
    }

    var priceHtml;
    if (tcgVars.length) {
      var rows = tcgVars.map(function (v) { return priceRow(v.label, v.prices || {}); }).join("");
      priceHtml =
        '<table class="price-table"><thead><tr><th>Variant</th><th>Low</th><th>Mid</th><th>High</th><th>Market</th></tr></thead>' +
        "<tbody>" + rows + "</tbody></table>";
    } else if (isJa) {
      // Japanese cards have no TCGdex pricing — fetch the PkmnPrices
      // Near Mint market price for the Japanese printing on demand.
      priceHtml = '<div id="cm-ja-price"><p style="color:var(--muted);font-size:0.9rem">Looking up Japanese market price…</p></div>';
    } else {
      priceHtml = '<p style="color:var(--muted);font-size:0.9rem">No TCGPlayer price data for this card.</p>';
    }

    var pills;
    if (prints.length) {
      pills = prints.map(function (b) {
        return '<button class="variant-pill' + (b.label === selected ? " active" : "") + '" data-label="' + App.esc(b.label) + '">' +
          App.esc(b.label) + "</button>";
      }).join("");
    } else {
      pills = tcgVars.map(function (v) {
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
        '<div class="art"><img src="' + App.esc(card.images && card.images.large) + '" alt="' + App.esc(card.name) + ' card artwork" loading="lazy"></div>' +
        "<div>" +
          /* Graded copies name the slab next to the title; the wishlist heart
           * (owner-only) stays as-is beside it. */
          (App.auth.isOwner()
            ? '<div class="wish-title-row"><h2>' + App.esc(card.name) + gradeBadgeHtml + "</h2>" +
              '<button type="button" class="wish-btn" id="cm-wish" aria-label="Save to wishlist" title="Save to wishlist">' + HEART_SVG + "</button></div>"
            : "<h2>" + App.esc(card.name) + gradeBadgeHtml + "</h2>") +
          '<div class="sub">' + App.esc((card.set && card.set.name) || "") + " · #" + App.esc(card.number || "?") + "</div>" +
          '<div class="detail-chips">' + chips.join("") + "</div>" +
          '<div class="field" style="margin-bottom:6px"><label>Illustrated by</label><div style="font-weight:600">' + App.esc(card.artist || "Unknown artist") + "</div></div>" +
          "<h4 style=\"margin:16px 0 8px\">Market prices</h4>" +
          priceHtml +
          (App.auth.isOwner()
            ? (pills ? '<div class="field" style="margin-bottom:10px"><label>Add variant</label><div class="variant-picker">' + pills + "</div></div>" : "") +
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
              '<div class="add-row">' +
                '<div class="stepper" role="group" aria-label="Quantity">' +
                  '<button id="cm-minus" aria-label="Decrease quantity">' + App.ui.icon("minus") + "</button>" +
                  '<span class="qty" id="cm-qty">1</span>' +
                  '<button id="cm-plus" aria-label="Increase quantity">' + App.ui.icon("plus") + "</button>" +
                "</div>" +
                '<button class="btn btn-primary" id="cm-add">' + App.ui.icon("plus") + " Add to collection</button>" +
              "</div>"
            : '<p style="font-size:0.85rem;color:var(--muted);margin:12px 0 0">Only the owner can add to this collection.</p>') +
          '<p style="font-size:0.78rem;color:var(--muted);margin:12px 0 0">' +
            (isJa
              ? "Japanese market prices via PkmnPrices (Near Mint)."
              : "Prices are TCGPlayer market values (USD).") +
          "</p>" +
        "</div>" +
      "</div>";

    var m = App.ui.openModal(html);
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
    var qty = 1;

    function setQty(n) {
      qty = Math.max(1, Math.min(99, n));
      m.el.querySelector("#cm-qty").textContent = qty;
    }
    m.el.querySelector("#cm-minus").addEventListener("click", function () { setQty(qty - 1); });
    m.el.querySelector("#cm-plus").addEventListener("click", function () { setQty(qty + 1); });
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
      });
    });
    var gradeToggle = m.el.querySelector("#cm-graded-toggle");
    var gradeFields = m.el.querySelector("#cm-graded-fields");
    if (gradeToggle && gradeFields) {
      gradeToggle.addEventListener("change", function () { gradeFields.hidden = !gradeToggle.checked; });
    }
    m.el.querySelector("#cm-add").addEventListener("click", async function () {
      if (!App.collection.needUser()) return;
      var btn = m.el.querySelector("#cm-add");
      btn.disabled = true;
      // Grading (Feature 5): { company, grade } or null. Company is always
      // PSA; the grade comes from the dropdown.
      var grading = null;
      var gt = m.el.querySelector("#cm-graded-toggle");
      if (gt && gt.checked) {
        var gv = m.el.querySelector("#cm-grade-value");
        var gGrade = gv ? gv.value : "";
        if (gGrade) grading = { company: "PSA", grade: gGrade };
      }
      try {
        if (selectedBox) {
          // Lazy exact PkmnPrices match for the chosen printing (a few credits).
          var pm = null;
          try {
            pm = await App.pkmn.findVariantPrice({
              name: card.name,
              setName: card.set && card.set.name,
              number: card.number,
              lang: (card.set && card.set.lang) || "en",
              pkmnLabel: selectedBox.pkmnLabel,
              priceVariant: selectedBox.priceVariant
            });
          } catch (e) {
            console.warn("[VaultDex] PkmnPrices variant match failed:", e && e.message);
          }
          // Pricing resolves quietly in the background: a miss here still
          // saves the card, and the next price refresh fills it in.
          var res = await App.collection.addItem(card, selectedBox.label, qty, {
            pkmnId: pm ? pm.pkmnId : null,
            label: selectedBox.label,
            resolved: pm
          }, grading);
          App.ui.toast(gradedAddMsg(card, qty, selectedBox.label, grading, res), "success");
        } else {
          var res2 = await App.collection.addItem(card, selected, qty, null, grading);
          var label = VARIANT_LABELS[selected] || selected;
          App.ui.toast(gradedAddMsg(card, qty, label, grading, res2), "success");
        }
        m.close();
      } catch (e) {
        App.handleApiError(e);
        btn.disabled = false;
      }
    });
    /* Wishlist heart (owner-only): toggles this card for the currently
     * selected variant pill. Fully separate from the add flow above —
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
  }

  /* Accepts a card object (from search results) or a card id (fetched fresh).
   * fallbackRow: a collection row used to render a basic detail view when the
   * card has no catalog record (e.g. pkmn.gg fallback imports). */
  App.openCardModal = async function (cardOrId, lang, fallbackRow) {
    try {
      var card = typeof cardOrId === "string" ? await App.tcg.getCard(cardOrId, lang) : cardOrId;
      if (!card) throw new Error("Card not found.");
      // Already-graded collection row: carry the slab onto the card so
      // render() can show the grade badge near the title.
      if (fallbackRow && fallbackRow.grading_company && !card.gradingCompany) {
        card.gradingCompany = fallbackRow.grading_company;
        card.gradingGrade = fallbackRow.grade || null;
      }
      render(card);
    } catch (e) {
      if (fallbackRow) {
        try {
          render(cardFromRow(fallbackRow, lang));
          return;
        } catch (e2) { /* fall through to the error toast */ }
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
