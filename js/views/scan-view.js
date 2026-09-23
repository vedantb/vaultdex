/* VaultDex — /scan view: phone-camera card scanner (mobile only).
 *
 * Flow: camera (tap-to-capture) -> photo review -> OCR (Tesseract, lazy) ->
 * candidate list -> confirm bottom sheet -> App.collection.addItem.
 * The scanner NEVER auto-adds; manual search (name/number) is always one
 * tap away when OCR misses. Desktop viewports render a "use your phone"
 * note instead — there is no scan affordance on desktop.
 */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

  var activeStream = null;

  function stopStream() {
    if (activeStream) {
      try {
        activeStream.getTracks().forEach(function (t) { t.stop(); });
      } catch { /* already stopped */ }
      activeStream = null;
    }
  }

  /* Downscale a video frame to a data URL for OCR. Caps the long edge so
   * Tesseract stays fast on phones. */
  function frameDataUrl(video) {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) throw new Error("Camera frame isn't ready yet — try again.");
    var maxEdge = 1400;
    var scale = Math.min(1, maxEdge / Math.max(vw, vh));
    var c = document.createElement("canvas");
    c.width = Math.round(vw * scale);
    c.height = Math.round(vh * scale);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  }

  /* ---------- confirm bottom sheet ---------- */

  /* Price line for the sheet: baked catalog price + honest source label.
   * JA cards price from PkmnPrices Near Mint; EN from TCGPlayer market.
   * English prices are never shown for Japanese cards. Pricing failures
   * stay quiet — the line just reads "—". */
  async function priceLine(card, lang) {
    var market = null, currency = null, pricedAt = null;
    try { market = App.tcg.marketOf(card); } catch { /* quiet */ }
    try { currency = card.priceCurrency || null; } catch { /* quiet */ }
    try {
      var found = await App.tcg.rawCard(card.id, lang);
      var snap = found && found.raw;
      if (snap && snap.pricing && snap.pricing.pricedAt) pricedAt = snap.pricing.pricedAt;
    } catch { /* quiet */ }
    var price = (typeof market === "number") ? App.ui.money(market, currency) : "—";
    var source = lang === "ja" ? "PkmnPrices · Near Mint" : "TCGPlayer market";
    var when = pricedAt ? " · updated " + App.ui.timeAgo(pricedAt) : " · catalog price";
    return { price: price, meta: source + when };
  }

  async function ownedQty(cardId) {
    try {
      var u = App.auth && App.auth.user;
      if (!u) return 0;
      var res = await App.sb.from("collection_items")
        .select("quantity")
        .eq("user_id", u.id)
        .eq("card_id", cardId);
      if (res.error) return 0;
      return (res.data || []).reduce(function (n, r) { return n + (r.quantity || 0); }, 0);
    } catch {
      return 0;
    }
  }

  /* Lazy exact PkmnPrices match for the chosen printing (a few credits) —
   * only when creating a brand-new row; a miss still saves the card and
   * the next price refresh fills it in. Mirrors the card modal. */
  async function resolvePkmn(card, print) {
    if (!print) return null;
    try {
      var pm = await App.pkmn.findVariantPrice({
        name: card.name,
        setName: card.set && card.set.name,
        number: card.number,
        lang: (card.set && card.set.lang) || "en",
        pkmnLabel: print.pkmnLabel,
        priceVariant: print.priceVariant
      });
      if (pm && pm.pkmnId) return pm;
    } catch (e) {
      console.warn("[VaultDex] scan: PkmnPrices variant match failed:", e && e.message);
    }
    return null;
  }

  function openConfirmSheet(card, lang) {
    return new Promise(function (resolveDone) {
      var overlay = document.createElement("div");
      overlay.className = "scan-sheet-overlay";

      var prints = App.tcg.printVariants(card);
      if (!prints.length) prints = [{ key: "normal", label: "Normal", vlabel: "normal", pkmnLabel: null, priceVariant: "normal" }];
      /* Default to the highest-market finish, like the card modal. */
      var best = (App.tcg.variantsOf(card)[0] || {}).key || null;
      var selected = prints[0];
      prints.some(function (p) {
        if (best && p.priceVariant === best) { selected = p; return true; }
        return false;
      });
      var qty = 1;

      function pillsHtml() {
        return prints.map(function (p) {
          return '<button type="button" class="variant-pill' + (p === selected ? " active" : "") + '"' +
            ' data-print="' + App.esc(p.key) + '">' + App.esc(p.label) + "</button>";
        }).join("");
      }

      overlay.innerHTML =
        '<div class="scan-sheet" role="dialog" aria-modal="true" aria-label="Confirm scanned card">' +
          '<div class="sheet-grab" aria-hidden="true"></div>' +
          '<button type="button" class="btn-icon sheet-close" aria-label="Close">' + App.ui.icon("x") + "</button>" +
          '<div class="sheet-card">' +
            (card.images && card.images.small
              ? '<img class="sheet-art" src="' + App.esc(card.images.small) + '" alt="' + App.esc(card.name || "") + '">'
              : "") +
            '<div class="sheet-head">' +
              "<h2>" + App.esc(card.name || "?") + "</h2>" +
              '<div class="sheet-set">' + App.esc((card.set && card.set.name) || "") +
                (card.number ? " · #" + App.esc(card.number) : "") + "</div>" +
              '<div class="sheet-price" data-price><span class="sp-val">…</span></div>' +
              '<div class="sheet-price-meta" data-price-meta></div>' +
              '<div class="sheet-owned" data-owned></div>' +
            "</div>" +
          "</div>" +
          '<div class="field"><label>Variant</label><div class="variant-picker" data-pills>' + pillsHtml() + "</div></div>" +
          '<div class="field"><label>Quantity</label>' +
            '<div class="stepper" role="group" aria-label="Quantity">' +
              '<button type="button" data-dec aria-label="One fewer">' + App.ui.icon("minus") + "</button>" +
              '<span class="qty" data-qty>1</span>' +
              '<button type="button" data-inc aria-label="One more">' + App.ui.icon("plus") + "</button>" +
            "</div></div>" +
          '<div class="field"><label class="grade-check"><input type="checkbox" data-graded> This copy is graded (PSA)</label>' +
            '<div data-graded-fields hidden>' +
              '<select data-grade aria-label="PSA grade">' +
                [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(function (g) {
                  return '<option value="' + g + '"' + (g === 10 ? " selected" : "") + ">Grade " + g + "</option>";
                }).join("") +
              "</select>" +
            "</div></div>" +
          /* Condition is intentionally fixed: raw pricing is always Near
           * Mint and collection_items has no condition column yet (see
           * supabase/migration-scan-condition.sql). */
          '<div class="field"><label>Condition</label><div class="scan-condition">Near Mint</div></div>' +
          '<button type="button" class="btn btn-primary btn-lg sheet-add" data-add>Add to collection</button>' +
        "</div>";

      var closed = false;
      function close(added) {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        resolveDone(!!added);
      }
      function onKey(e) { if (e.key === "Escape") close(false); }
      overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(false); });
      overlay.querySelector(".sheet-close").addEventListener("click", function () { close(false); });
      document.addEventListener("keydown", onKey);

      var pillsEl = overlay.querySelector("[data-pills]");
      pillsEl.addEventListener("click", function (e) {
        var b = e.target.closest("[data-print]");
        if (!b) return;
        var p = null;
        prints.some(function (x) { if (x.key === b.getAttribute("data-print")) { p = x; return true; } return false; });
        if (!p) return;
        selected = p;
        pillsEl.innerHTML = pillsHtml();
      });

      var qtyEl = overlay.querySelector("[data-qty]");
      overlay.querySelector("[data-dec]").addEventListener("click", function () {
        qty = Math.max(1, qty - 1);
        qtyEl.textContent = qty;
      });
      overlay.querySelector("[data-inc]").addEventListener("click", function () {
        qty = Math.min(99, qty + 1);
        qtyEl.textContent = qty;
      });

      var gradedBox = overlay.querySelector("[data-graded]");
      var gradedFields = overlay.querySelector("[data-graded-fields]");
      gradedBox.addEventListener("change", function () {
        gradedFields.hidden = !gradedBox.checked;
      });

      var addBtn = overlay.querySelector("[data-add]");
      addBtn.addEventListener("click", async function () {
        if (addBtn.disabled) return;
        addBtn.disabled = true;
        addBtn.textContent = "Adding…";
        try {
          var grading = null;
          if (gradedBox.checked) {
            var gv = overlay.querySelector("[data-grade]").value;
            if (gv) grading = { company: "PSA", grade: gv };
          }
          var pkmn = await resolvePkmn(card, selected);
          var res = await App.collection.addItem(card, selected.label, qty, pkmn, grading);
          if (res) {
            App.ui.toast("Added " + card.name + (qty > 1 ? " ×" + qty : "") + " to your collection.");
            close(true);
          } else {
            addBtn.disabled = false;
            addBtn.textContent = "Add to collection";
          }
        } catch (e) {
          App.handleApiError(e);
          addBtn.disabled = false;
          addBtn.textContent = "Add to collection";
        }
      });

      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add("open"); });

      /* Fill price + ownership asynchronously — the sheet paints first. */
      priceLine(card, lang).then(function (pl) {
        if (!overlay.isConnected) return;
        overlay.querySelector("[data-price]").innerHTML = '<span class="sp-val">' + App.esc(pl.price) + "</span>";
        overlay.querySelector("[data-price-meta]").textContent = pl.meta;
      });
      ownedQty(card.id).then(function (n) {
        if (!overlay.isConnected) return;
        overlay.querySelector("[data-owned]").innerHTML = n > 0
          ? '<span class="owned-some">You own ' + n + "</span>"
          : '<span class="owned-none">Not in your collection yet</span>';
      });
    });
  }

  /* ---------- candidate list (OCR results or manual search) ---------- */

  /* Resolve index picks to full cards for display. Index entries lack
   * images for JA cards, so this fetches details (bounded, one batch per
   * scan). Also backfills the set name when the detail path didn't carry
   * one, so tiles and the confirm sheet always show the set. */
  async function resolveCandidates(picks) {
    if (!picks || !picks.length) return [];
    var cards = (await App.tcg.getDetailsMixed(picks, 8)).filter(Boolean);
    await Promise.all(cards.map(async function (c) {
      if (c.set && c.set.name) return;
      try {
        var lang = (c.set && c.set.lang) || "en";
        var prefix = String(c.id || "").slice(0, Math.max(0, String(c.id || "").lastIndexOf("-")));
        if (!prefix) return;
        var set = await App.tcg.getSet((lang === "ja" ? "ja-" : "") + prefix);
        if (set && set.name) c.set = { id: prefix, name: set.name, lang: lang };
      } catch { /* tiles and the sheet render without the set name */ }
    }));
    return cards;
  }

  async function candidatesFor(info, idx) {
    idx = idx || await App.tcg.getIndex();
    var setRank = null;
    try { setRank = await App.tcg.getSetRank(); } catch { /* tiebreak skipped */ }
    var picks = App.scan.rankCandidates(idx, info, 12, setRank);
    return resolveCandidates(picks);
  }

  function renderCandidates(box, cards, readNote, onPick) {
    if (!cards.length) {
      box.innerHTML =
        '<div class="scan-cand-empty">' +
          "<h3>Couldn't read that card</h3>" +
          "<p>Try better light, hold steady, and avoid holo glare — or search by name below.</p>" +
        "</div>" +
        manualSearchHtml();
      bindManualSearch(box, onPick);
      return;
    }
    box.innerHTML =
      (readNote ? '<p class="scan-read">' + readNote + "</p>" : "") +
      '<div class="scan-cands">' +
        cards.map(function (c) {
          return App.ui.tileHtml(c, {
            dataId: c.id,
            dataLang: (c.set && c.set.lang) || "en",
            setHtml: App.esc((c.set && c.set.name) || ""),
            ariaLabel: "Select " + (c.name || "card")
          });
        }).join("") +
      "</div>" +
      '<button type="button" class="btn btn-ghost scan-rescue">Not seeing it? Search by name</button>';
    box.querySelectorAll(".card-tile").forEach(function (tile) {
      tile.addEventListener("click", function () {
        var id = tile.getAttribute("data-id");
        var lang = tile.getAttribute("data-lang") || "en";
        var card = cards.filter(function (c) { return c.id === id; })[0];
        if (card) onPick(card, lang);
      });
    });
    box.querySelector(".scan-rescue").addEventListener("click", function () {
      box.innerHTML = manualSearchHtml();
      bindManualSearch(box, onPick);
      var inp = box.querySelector("[data-manual-q]");
      if (inp) inp.focus();
    });
  }

  function manualSearchHtml() {
    return '<div class="scan-manual">' +
      '<div class="scan-search-row">' +
        '<input type="search" data-manual-q placeholder="Card name or number…" aria-label="Search cards by name or number" enterkeyhint="search">' +
        '<button type="button" class="btn btn-primary" data-manual-go>Search</button>' +
      "</div>" +
      '<div class="scan-cands" data-manual-results></div>' +
    "</div>";
  }

  function bindManualSearch(box, onPick) {
    var input = box.querySelector("[data-manual-q]");
    var go = box.querySelector("[data-manual-go]");
    var results = box.querySelector("[data-manual-results]");
    if (!input || !go) return;
    async function run() {
      var q = input.value.trim();
      if (!q) return;
      results.innerHTML = '<div class="scan-loading"><span class="spinner"></span></div>';
      try {
        var idx = await App.tcg.getIndex();
        var setRank = null;
        try { setRank = await App.tcg.getSetRank(); } catch { /* tiebreak skipped */ }
        var picks = App.scan.searchIndexQuery(idx, q, 12, setRank);
        var cards = await resolveCandidates(picks);
        renderCandidates(results, cards, "", onPick);
      } catch {
        results.innerHTML = '<p class="scan-error">Search failed — check your connection and try again.</p>';
      }
    }
    go.addEventListener("click", run);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); run(); }
    });
  }

  /* ---------- the view ---------- */

  App.views.scan = async function (root) {
    /* Desktop: no camera, no scan affordance — just the explainer. */
    if (!App.scan.scanCapable()) {
      root.innerHTML = App.ui.emptyState({
        icon: "search",
        title: "Scanning lives on your phone",
        body: "The card scanner needs a phone camera. Open VaultDex on your iPhone and tap Scan to add cards straight to your collection."
      });
      return;
    }
    if (!App.auth.isOwner()) {
      root.innerHTML =
        '<div class="empty-state">' +
          '<div class="big-icon">' + App.ui.icon("cards") + "</div>" +
          "<h3>Sign in to scan cards</h3>" +
          "<p>Scanning adds cards straight to your collection, so it needs the owner's sign-in.</p>" +
          '<button type="button" class="btn btn-primary" data-scan-signin>Sign in with Google</button>' +
        "</div>";
      var sib = root.querySelector("[data-scan-signin]");
      if (sib) sib.addEventListener("click", function () { App.ui.signInPrompt(); });
      return;
    }

    root.innerHTML =
      '<div class="scan-wrap">' +
        '<div class="scan-head"><h1 class="scan-title">Scan a card</h1></div>' +
        '<div class="scan-stage" data-stage></div>' +
      "</div>";
    var stage = root.querySelector("[data-stage]");

    /* Stop the camera when the user navigates away mid-scan. */
    var mo = new MutationObserver(function () {
      if (!root.isConnected) { stopStream(); mo.disconnect(); }
    });
    mo.observe(document.getElementById("app"), { childList: true, subtree: true });

    function showCamera() {
      stopStream();
      stage.innerHTML =
        '<div class="scan-finder">' +
          '<video data-video autoplay playsinline muted></video>' +
          '<div class="scan-frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>' +
        "</div>" +
        '<p class="scan-hint">Point at a card, then tap the shutter.</p>' +
        '<div class="scan-actions">' +
          '<button type="button" class="scan-shutter" data-shutter aria-label="Capture card"></button>' +
        "</div>" +
        '<button type="button" class="btn btn-ghost" data-manual-link>Can\'t scan? Search by name instead</button>';
      /* The file input lives on the root (outside the stage) so it
       * survives stage rewrites — it's the upload fallback when the
       * camera API is missing or denied. */
      var fileInput = root.querySelector("[data-file]");
      if (!fileInput) {
        fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.setAttribute("capture", "environment");
        fileInput.setAttribute("data-file", "");
        fileInput.hidden = true;
        root.appendChild(fileInput);
      }
      function uploadPhoto() {
        fileInput.value = "";
        fileInput.click();
      }
      fileInput.onchange = function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        var rd = new FileReader();
        rd.onload = function () { showReview(String(rd.result || "")); };
        rd.readAsDataURL(f);
        fileInput.value = "";
      };

      function deniedState() {
        stage.innerHTML =
          '<div class="empty-state">' +
            '<div class="big-icon">' + App.ui.icon("search") + "</div>" +
            "<h3>Camera access was denied</h3>" +
            "<p>VaultDex needs camera permission to scan. You can allow it in Settings → Safari → Camera — or upload a photo instead.</p>" +
            '<button type="button" class="btn btn-primary" data-upload>Upload a photo</button> ' +
            '<button type="button" class="btn btn-ghost" data-retry>Try again</button>' +
          "</div>";
        stage.querySelector("[data-upload]").addEventListener("click", uploadPhoto);
        stage.querySelector("[data-retry]").addEventListener("click", showCamera);
      }

      function missingCameraState() {
        /* Older iOS standalone PWAs have no getUserMedia — the file
         * picker with capture="environment" opens the camera instead. */
        uploadPhoto();
        stage.innerHTML =
          '<div class="empty-state">' +
            "<h3>Camera isn't available here</h3>" +
            "<p>Upload a photo of the card instead.</p>" +
            '<button type="button" class="btn btn-primary" data-upload>Upload a photo</button> ' +
            '<button type="button" class="btn btn-ghost" data-retry>Retry camera</button>' +
          "</div>";
        stage.querySelector("[data-upload]").addEventListener("click", uploadPhoto);
        stage.querySelector("[data-retry]").addEventListener("click", showCamera);
      }

      var md = navigator.mediaDevices;
      if (!md || typeof md.getUserMedia !== "function") {
        missingCameraState();
        return;
      }
      md.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
        .then(function (stream) {
          if (!stage.isConnected) {
            stream.getTracks().forEach(function (t) { t.stop(); });
            return;
          }
          activeStream = stream;
          var video = stage.querySelector("[data-video]");
          if (video) video.srcObject = stream;
        })
        .catch(function (err) {
          if (!stage.isConnected) return;
          var name = (err && err.name) || "";
          if (name === "NotAllowedError" || name === "SecurityError") {
            deniedState();
          } else {
            /* NotFoundError / OverconstrainedError: no usable camera —
             * go straight to the file picker. */
            missingCameraState();
          }
        });

      stage.querySelector("[data-shutter]").addEventListener("click", function () {
        var video = stage.querySelector("[data-video]");
        if (!video) return;
        try {
          showReview(frameDataUrl(video));
        } catch (e) {
          App.ui.toast(e.message || "Couldn't capture a frame.", "error");
        }
      });
      stage.querySelector("[data-manual-link]").addEventListener("click", showManual);
    }

    function showReview(dataUrl) {
      stopStream();
      if (!dataUrl) { showCamera(); return; }
      stage.innerHTML =
        '<div class="scan-review">' +
          '<img src="' + dataUrl.replace(/"/g, "&quot;") + '" alt="Captured card photo">' +
        "</div>" +
        '<div class="scan-actions">' +
          '<button type="button" class="btn btn-ghost" data-retake>Retake</button>' +
          '<button type="button" class="btn btn-primary" data-read>Read card</button>' +
        "</div>";
      stage.querySelector("[data-retake]").addEventListener("click", showCamera);
      stage.querySelector("[data-read]").addEventListener("click", function () { showReading(dataUrl); });
    }

    function showReading(dataUrl) {
      stage.innerHTML =
        '<div class="scan-review">' +
          '<img src="' + dataUrl.replace(/"/g, "&quot;") + '" alt="Captured card photo">' +
          '<div class="scan-ocr">' +
            '<div class="ocr-bar"><i data-ocr-fill></i></div>' +
            '<p data-ocr-label>Reading card…</p>' +
          "</div>" +
        "</div>" +
        '<div class="scan-actions"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button></div>';
      var fill = stage.querySelector("[data-ocr-fill]");
      var label = stage.querySelector("[data-ocr-label]");
      var cancelled = false;
      stage.querySelector("[data-cancel]").addEventListener("click", function () {
        cancelled = true;
        showCamera();
      });
      (async function () {
        try {
          var ocr = await App.scan.recognize(dataUrl, function (p) {
            if (fill) fill.style.width = Math.round(p * 100) + "%";
          });
          if (cancelled || !stage.isConnected) return;
          var idx = await App.tcg.getIndex();
          var info = App.scan.extractCardInfo(ocr, App.scan.buildIllustratorTokens(idx));
          if (label) label.textContent = "Matching…";
          var cards = await candidatesFor(info, idx);
          if (cancelled || !stage.isConnected) return;
          var note = "";
          if (info.name || info.nameJa || info.number) {
            note = "We read: “" + App.esc([info.name || info.nameJa, info.number ? "#" + info.number : ""].filter(Boolean).join(" ")) +
              "” — tap the right card.";
          }
          stage.innerHTML = '<div class="scan-results" data-results></div>' +
            '<div class="scan-actions"><button type="button" class="btn btn-ghost" data-again>Scan another</button></div>';
          renderCandidates(stage.querySelector("[data-results]"), cards, note, onPick);
          stage.querySelector("[data-again]").addEventListener("click", showCamera);
        } catch (e) {
          if (cancelled || !stage.isConnected) return;
          console.warn("[VaultDex] scan: OCR failed:", e && e.message);
          /* OCR failed (CDN unreachable, engine error): fall back to
           * manual search instead of dead-ending. */
          stage.innerHTML = '<div class="scan-results" data-results></div>' +
            '<div class="scan-actions"><button type="button" class="btn btn-ghost" data-again>Scan another</button></div>';
          renderCandidates(stage.querySelector("[data-results]"), [], "", onPick);
          stage.querySelector("[data-again]").addEventListener("click", showCamera);
        }
      })();
    }

    function showManual() {
      stopStream();
      stage.innerHTML = '<div class="scan-results" data-results></div>' +
        '<div class="scan-actions"><button type="button" class="btn btn-ghost" data-back>Back to camera</button></div>';
      var box = stage.querySelector("[data-results]");
      box.innerHTML = manualSearchHtml();
      bindManualSearch(box, onPick);
      stage.querySelector("[data-back]").addEventListener("click", showCamera);
    }

    async function onPick(card, lang) {
      await openConfirmSheet(card, lang);
      /* After the sheet closes (added or dismissed), return to the
       * camera so the next card is one tap away. */
      if (stage.isConnected) showCamera();
    }

    showCamera();
    window.scrollTo(0, 0);
  };
})();
