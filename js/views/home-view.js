/* VaultDex — home view: hero, entry cards, value graph, top-of-the-vault rail, pack easter egg. */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

    var GRAPH_RANGES = [
      { id: "1W", label: "1W", days: 7, phrase: "in the last week" },
      { id: "1M", label: "1M", days: 30, phrase: "in the last month" },
      { id: "3M", label: "3M", days: 90, phrase: "in the last 3 months" },
      { id: "6M", label: "6M", days: 180, phrase: "in the last 6 months" },
      { id: "ALL", label: "ALL", days: 0, phrase: "all time" }
    ];
    function rangeById(id) {
      for (var i = 0; i < GRAPH_RANGES.length; i++) if (GRAPH_RANGES[i].id === id) return GRAPH_RANGES[i];
      return GRAPH_RANGES[GRAPH_RANGES.length - 1];
    }
    function fmtDay(day) {
      var d = new Date(String(day) + "T00:00:00Z");
      if (isNaN(d.getTime())) return String(day);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    }
    function fmtTick(v) {
      var a = Math.abs(v);
      if (a >= 1000) return Math.round(v).toLocaleString("en-US");
      if (a >= 100) return String(Math.round(v));
      return String(Math.round(v * 100) / 100);
    }
    function niceTicks(min, max, n) {
      var span = max - min;
      if (!(span > 0)) span = Math.abs(max) || 1;
      var step0 = span / Math.max(1, n);
      var mag = Math.pow(10, Math.floor(Math.log10(step0)));
      var norm = step0 / mag;
      var step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
      var out = [];
      for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
        out.push(Math.round(v * 1e6) / 1e6);
      }
      return out;
    }
    function graphLayout(points) {
      var W = 620, H = 200, padL = 48, padR = 14, padT = 14, padB = 8;
      var vals = points.map(function (p) { return Number(p.total_value) || 0; });
      var n = vals.length;
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      if (hi === lo) { lo -= 1; hi += 1; }
      var span = hi - lo;
      lo -= span * 0.15; hi += span * 0.15;
      var xs = [], ys = [];
      for (var i = 0; i < n; i++) {
        xs.push(n === 1 ? padL : padL + (W - padL - padR) * i / (n - 1));
        ys.push(padT + (H - padT - padB) * (1 - (vals[i] - lo) / (hi - lo)));
      }
      return {
        W: W, H: H, padL: padL, padR: padR, padT: padT, padB: padB,
        xs: xs, ys: ys, lo: lo, hi: hi,
        stepX: n > 1 ? (W - padL - padR) / (n - 1) : 0,
        ticks: niceTicks(lo, hi, 4)
      };
    }
    // Catmull-Rom smoothing for the line path.
    function smoothPath(pts) {
      var f = function (p) { return p.x.toFixed(1) + " " + p.y.toFixed(1); };
      if (pts.length === 1) return "M" + f(pts[0]);
      var d = "M" + f(pts[0]);
      for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[Math.max(0, i - 1)], p1 = pts[i],
            p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        d += "C" +
          (p1.x + (p2.x - p0.x) / 6).toFixed(1) + " " + (p1.y + (p2.y - p0.y) / 6).toFixed(1) + " " +
          (p2.x - (p3.x - p1.x) / 6).toFixed(1) + " " + (p2.y - (p3.y - p1.y) / 6).toFixed(1) + " " +
          f(p2);
      }
      return d;
    }
    function graphSvg(points) {
      var L = graphLayout(points);
      var n = points.length;
      var pts = [];
      for (var i = 0; i < n; i++) pts.push({ x: L.xs[i], y: L.ys[i] });
      var line = smoothPath(pts);
      var base = (L.H - L.padB).toFixed(1);
      var area = line +
        "L" + L.xs[n - 1].toFixed(1) + " " + base +
        "L" + L.xs[0].toFixed(1) + " " + base + "Z";
      var grid = L.ticks.map(function (t) {
        var y = (L.padT + (L.H - L.padT - L.padB) * (1 - (t - L.lo) / (L.hi - L.lo))).toFixed(1);
        return '<line class="spot-grid-line" x1="' + L.padL + '" y1="' + y +
          '" x2="' + (L.W - L.padR) + '" y2="' + y + '"/>' +
          '<text class="spot-grid-label" x="' + (L.padL - 8) + '" y="' + (+y + 4) + '">' +
          App.esc(fmtTick(t)) + "</text>";
      }).join("");
      var ex = L.xs[n - 1].toFixed(1), ey = L.ys[n - 1].toFixed(1);
      return '<svg class="spot-svg" viewBox="0 0 ' + L.W + " " + L.H +
        '" preserveAspectRatio="none" role="img" aria-label="Collection value over time">' +
        '<defs><linearGradient id="spotgrad" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" class="sg-stop-0"/><stop offset="1" class="sg-stop-1"/>' +
        "</linearGradient></defs>" +
        grid +
        '<path class="spot-area" d="' + area + '"/>' +
        '<path class="spot-line" d="' + line + '"/>' +
        '<line class="spot-hover-line" x1="0" y1="' + L.padT + '" x2="0" y2="' + (L.H - L.padB) + '" visibility="hidden"/>' +
        '<circle class="spot-hover-dot" r="4.5" visibility="hidden"/>' +
        '<circle class="spot-end-dot" cx="' + ex + '" cy="' + ey + '" r="4.5"/>' +
        '<rect class="spot-hover-zone" x="' + L.padL + '" y="' + L.padT +
        '" width="' + (L.W - L.padL - L.padR) + '" height="' + (L.H - L.padT - L.padB) + '"/>' +
        "</svg>";
    }
    // "-$12.30 (−1.0%) in the last month" vs the first point of the range.
    function spotChange(pts, rangeId, upto) {
      var last = upto === undefined ? pts.length - 1 : upto;
      var first = Number(pts[0].total_value) || 0;
      var lastV = Number(pts[last].total_value) || 0;
      var d = lastV - first;
      var pct = first ? (d / first) * 100 : 0;
      var phrase = rangeById(rangeId).phrase;
      if (Math.abs(d) < 0.005) return { cls: "flat", text: "No change " + phrase };
      var sign = d > 0 ? "+" : "−";
      return {
        cls: d > 0 ? "up" : "down",
        text: sign + App.ui.money(Math.abs(d)) + " (" + sign + Math.abs(pct).toFixed(2) + "%) " + phrase
      };
    }
    function bindSpotGraph(el, history) {
      // history arrives oldest -> newest (valueHistory sorts by day asc).
      function newestDay() { return String(history[history.length - 1].day); }
      // Points inside a range, anchored to the newest REAL snapshot day —
      // never the device clock, never fabricated: only recorded snapshot
      // rows are shown. Days compare as YYYY-MM-DD strings; a range holds
      // points from (newest - days) up to the newest snapshot, inclusive.
      function rangePoints(r) {
        if (!r.days) return history.slice();
        var d = new Date(newestDay() + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() - r.days);
        var cutoff = d.toISOString().slice(0, 10);
        return history.filter(function (p) { return String(p.day) >= cutoff; });
      }
      function rangeValid(r) { return rangePoints(r).length >= 2; }
      // Longest range (ALL down to 1W) that actually holds >= 2 points.
      function longestValidRangeId() {
        for (var i = GRAPH_RANGES.length - 1; i >= 0; i--) {
          if (rangeValid(GRAPH_RANGES[i])) return GRAPH_RANGES[i].id;
        }
        // Unreachable: bindSpotGraph is only called when history >= 2,
        // and ALL always contains every point.
        return GRAPH_RANGES[GRAPH_RANGES.length - 1].id;
      }
      // Truthful default: the longest range with real data (not hardcoded).
      var rangeId = longestValidRangeId();
      var chartBox = el.querySelector("[data-spot-chart]");
      var tip = el.querySelector("[data-spot-tip]");
      var valEl = el.querySelector(".spot-graph-value");
      var chgEl = el.querySelector("[data-spot-change]");
      var pills = el.querySelectorAll("[data-range]");
      // A pill is clickable only when its range holds >= 2 points, so the
      // chart can never render all-history under a short-range label.
      function paintPills() {
        pills.forEach(function (b) {
          var r = rangeById(b.getAttribute("data-range"));
          var ok = rangeValid(r);
          b.disabled = !ok;
          if (ok) b.removeAttribute("title");
          else b.setAttribute("title", "Not enough history yet");
          b.classList.toggle("on", r.id === rangeId);
        });
      }
      // Belt-and-braces: if the selected range ever becomes invalid, fall
      // back to the longest valid one, so the change line ("... in the
      // last week") always describes the actually-rendered range.
      function ensureValidRange() {
        if (!rangeValid(rangeById(rangeId))) rangeId = longestValidRangeId();
      }
      function points() { return rangePoints(rangeById(rangeId)); }
      function paintChange(pts, upto) {
        var c = spotChange(pts, rangeId, upto);
        chgEl.className = "spot-graph-change " + c.cls;
        chgEl.textContent = c.text;
      }
      /* Draw-on animation: the value line draws itself left-to-right, the
       * area fill and end dot fade in behind it. Skipped entirely under
       * reduced motion (the full graph just renders). */
      function drawSpotLine(box) {
        if (App.ui.reduceMotion) return;
        var line = box.querySelector(".spot-line");
        var area = box.querySelector(".spot-area");
        var dot = box.querySelector(".spot-end-dot");
        if (!line || typeof line.getTotalLength !== "function") return;
        var len = line.getTotalLength();
        if (!len) return;
        line.style.strokeDasharray = String(len);
        line.style.strokeDashoffset = String(len);
        if (area) area.style.opacity = "0";
        if (dot) dot.style.opacity = "0";
        void line.getBoundingClientRect();
        line.style.transition = "stroke-dashoffset 0.9s cubic-bezier(0.22, 0.8, 0.3, 1)";
        if (area) area.style.transition = "opacity 0.6s ease 0.45s";
        if (dot) dot.style.transition = "opacity 0.4s ease 0.75s";
        line.style.strokeDashoffset = "0";
        if (area) area.style.opacity = "1";
        if (dot) dot.style.opacity = "1";
      }
      function render() {
        // Re-validate on every render: the change line and the .on pill
        // always describe the actually-rendered range.
        ensureValidRange();
        paintPills();
        var pts = points();
        var L = graphLayout(pts);
        var n = pts.length;
        chartBox.innerHTML = graphSvg(pts);
        drawSpotLine(chartBox);
        paintChange(pts);
        var svg = chartBox.querySelector("svg");
        var hline = svg.querySelector(".spot-hover-line");
        var hdot = svg.querySelector(".spot-hover-dot");
        function show(i) {
          var v = Number(pts[i].total_value) || 0;
          hline.setAttribute("x1", L.xs[i].toFixed(1));
          hline.setAttribute("x2", L.xs[i].toFixed(1));
          hline.setAttribute("visibility", "visible");
          hdot.setAttribute("cx", L.xs[i].toFixed(1));
          hdot.setAttribute("cy", L.ys[i].toFixed(1));
          hdot.setAttribute("visibility", "visible");
          tip.style.left = Math.max(9, Math.min(91, (L.xs[i] / L.W) * 100)) + "%";
          tip.style.top = (L.ys[i] / L.H * 100) + "%";
          tip.innerHTML = '<span class="spot-tip-date">' + App.esc(fmtDay(pts[i].day)) + "</span>" +
            '<span class="spot-tip-val">' + App.ui.money(v) + "</span>";
          tip.hidden = false;
          if (valEl) valEl.textContent = App.ui.money(v);
          paintChange(pts, i);
        }
        function hide() {
          hline.setAttribute("visibility", "hidden");
          hdot.setAttribute("visibility", "hidden");
          tip.hidden = true;
          if (valEl) valEl.textContent = App.ui.money(Number(pts[n - 1].total_value) || 0);
          paintChange(pts);
        }
        function idxAt(clientX) {
          var r = svg.getBoundingClientRect();
          var px = (clientX - r.left) * (L.W / r.width);
          return Math.max(0, Math.min(n - 1, Math.round((px - L.padL) / (L.stepX || 1))));
        }
        svg.addEventListener("mousemove", function (e) { show(idxAt(e.clientX)); });
        svg.addEventListener("mouseleave", hide);
        svg.addEventListener("touchstart", function (e) {
          if (e.touches.length) show(idxAt(e.touches[0].clientX));
        }, { passive: true });
        svg.addEventListener("touchend", hide);
      }
      // Disabled pills don't fire clicks, so an invalid range can never be
      // selected; render() re-validates anyway for belt-and-braces.
      pills.forEach(function (b) {
        b.addEventListener("click", function () {
          rangeId = b.getAttribute("data-range");
          render();
        });
      });
      render();
    }

    /* ---------------- home ---------------- */
    /* Shared: App.util.langOf (js/util.js). */
    var langOf = App.util.langOf;
    function rowValue(it) {
      return (it.market_price !== null && it.market_price !== undefined)
        ? Number(it.market_price) * it.quantity : null;
    }
    // Most valuable card image from a list — skips images already used on
    // this screen so every tile looks different.
    // Shared: App.util.topImage (js/util.js); home ranks by total row value.
    function topImage(list, used) {
      return App.util.topImage(list, used, function (it) { return rowValue(it) || 0; });
    }

    /* Pack-opening easter egg: rip a booster, pull a random vault card. */
    function openPack(items) {
      var pool = items.filter(function (it) { return it.image_small || it.image_large; });
      if (!pool.length) return;
      var stage = document.createElement("div");
      stage.className = "pack-stage";
      var closed = false;
      function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey);
        stage.remove();
      }
      function onKey(e) {
        /* Escape closes the topmost layer only: with a card detail open over
         * the fan, it closes the dialog and the fan stays put. */
        if (e.key === "Escape" && !document.querySelector(".modal-overlay")) close();
      }
      document.addEventListener("keydown", onKey);
      stage.addEventListener("mousedown", function (e) { if (e.target === stage) close(); });

      function showPack() {
        stage.innerHTML =
          '<div class="pack-result">' +
            '<div class="pack-big" data-pack role="button" tabindex="0" aria-label="Rip open the pack"><span class="pack-logo">VAULT</span></div>' +
            "<h3>Fresh pack</h3>" +
            '<div class="pr-sub">Tap the pack to rip it open</div>' +
            '<div class="pr-actions"><button type="button" class="btn btn-ghost" data-pack-close>Not now</button></div>' +
          "</div>";
        var pack = stage.querySelector("[data-pack]");
        stage.querySelector("[data-pack-close]").addEventListener("click", close);
        function rip() {
          if (App.ui.reduceMotion) { revealPulls(pickPulls(pool, 3, rowValue), false); return; }
          pack.classList.add("shake");
          setTimeout(function () {
            if (closed) return;
            revealPulls(pickPulls(pool, 3, rowValue), true);
          }, 560);
        }
        pack.addEventListener("click", rip);
        pack.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); rip(); }
        });
      }
      /* Tear the pack in two, flash, then fan three pulls with staggered
       * 3D flip-ins — the most valuable pull lands center stage. Tapping a
       * fanned card FLIP-morphs it into the card dialog. */
      function revealPulls(picks, animate) {
        if (!picks.length) { close(); return; }
        var headliner = picks[1] || picks[0];
        var total = picks.reduce(function (n, it) { var v = rowValue(it); return n + (v || 0); }, 0);
        stage.innerHTML =
          '<div class="pack-result">' +
            '<div class="pack-scene' + (animate ? "" : " pack-instant") + '">' +
              (animate
                ? '<div class="pack-halves" aria-hidden="true"><div class="pack-half ph-top"></div><div class="pack-half ph-bottom"></div></div>' +
                  '<div class="pack-flash" aria-hidden="true"></div>'
                : "") +
              '<div class="pack-fan">' +
                picks.map(function (it, i) {
                  return '<button type="button" class="fan-card" data-fan="' + i + '" style="--i:' + i + '" aria-label="View ' + App.esc(it.card_name || "card") + '">' +
                    '<span class="fan-inner"><img draggable="false" src="' + App.esc(it.image_large || it.image_small) + '" alt="' + App.esc(it.card_name || "Pulled card") + '"></span>' +
                  "</button>";
                }).join("") +
              "</div>" +
            "</div>" +
            "<h3>" + App.esc(headliner.card_name || "???") + "</h3>" +
            '<div class="pr-sub">' + picks.length + (picks.length === 1 ? " card" : " cards") +
              (total ? " · " + App.ui.money(total) + " total" : "") + "</div>" +
            '<div class="pr-actions">' +
              '<button type="button" class="btn btn-primary" data-pack-again>Open another</button>' +
              '<button type="button" class="btn btn-ghost" data-pack-done>Done</button>' +
            "</div>" +
          "</div>";
        var fan = stage.querySelector(".pack-fan");
        if (animate) {
          /* Halves tear on insertion (CSS animation); the fan deals a beat later. */
          requestAnimationFrame(function () {
            requestAnimationFrame(function () { if (!closed && fan.isConnected) fan.classList.add("dealt"); });
          });
          /* Tear debris has served its purpose after ~0.8s — remove it so it
           * can never intercept taps on the fanned cards. */
          setTimeout(function () {
            var halves = stage.querySelector(".pack-halves");
            var flash = stage.querySelector(".pack-flash");
            if (halves) halves.remove();
            if (flash) flash.remove();
          }, 850);
        } else {
          fan.classList.add("dealt");
        }
        stage.querySelector("[data-pack-again]").addEventListener("click", showPack);
        stage.querySelector("[data-pack-done]").addEventListener("click", close);
        fan.querySelectorAll(".fan-card").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var it = picks[parseInt(btn.getAttribute("data-fan"), 10)];
            if (!it) return;
            /* Keep the stage mounted: the dialog sinks it behind itself and
             * closing the dialog returns to the fan with the other pulls. */
            App.openCardModal(it.card_id, langOf(it), it, btn.querySelector("img") || btn);
          });
        });
      }
      showPack();
      document.body.appendChild(stage);
    }

    /* Pick n unique random pulls; the most valuable lands in the middle of
     * the fan (order [2nd, 1st, 3rd]) so the "hit" sits center stage.
     * Exposed on App.packPick for unit tests. */
    function pickPulls(pool, n, valueOf) {
      var bag = pool.slice();
      var picks = [];
      while (bag.length && picks.length < n) {
        picks.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
      }
      picks.sort(function (a, b) { return (valueOf(b) || 0) - (valueOf(a) || 0); });
      if (picks.length === 3) picks = [picks[1], picks[0], picks[2]];
      return picks;
    }
    App.packPick = pickPulls;

    App.views.home = async function (root) {
      if (!App.isConfigured()) {
        root.innerHTML = App.ui.emptyState({
          title: "Supabase isn't configured",
          body: "Add your Supabase URL and anon key to js/config.js (see SETUP.md), then reload.",
          actionHtml: '<a class="btn btn-ghost" href="/browse">Browse cards</a>'
        });
        return;
      }
      var readOnly = !App.auth.isOwner();
      // Seed today's history point (owner only), then read the series.
      if (!readOnly) { try { await App.collection.recordValueSnapshot(); } catch { /* ignored */ } }
      var items = [];
      try {
        items = readOnly ? await App.collection.listPublic() : await App.collection.list();
      } catch (e) {
        root.innerHTML = App.ui.emptyState({ title: "Couldn't load the vault", body: (e && e.message) || "Something went wrong." });
        return;
      }
      if (!items.length) {
        root.innerHTML = App.ui.emptyState({
          title: "The vault is empty",
          body: readOnly
            ? "This collection doesn't have any cards yet."
            : "Head to Browse to find cards — search by name, or open a set and bulk-add the ones you own.",
          actionHtml: readOnly ? "" : '<a class="btn btn-primary" href="/browse">Browse cards</a>'
        });
        return;
      }
      var history;
      try { history = await App.collection.valueHistory(); } catch { history = []; }
      var totals = App.collection.totals(items);
      var totalValue = items.reduce(function (n, it) {
        var v = rowValue(it);
        return n + (v === null ? 0 : v);
      }, 0);
      var tradeRows;
      try { tradeRows = (App.trade && await App.trade.listForTrade()) || []; } catch { tradeRows = []; }
      var tradeCount = tradeRows.reduce(function (n, r) {
        return n + ((App.trade && App.trade.effectiveQty(r)) || 0);
      }, 0);
      var hasGraph = history.length >= 2;
      var used = {};
      var collArt = topImage(items, used);
      var tradeArt = topImage(tradeRows, used) || collArt;
      var railTopCards = items.slice().sort(function (a, b) {
        return (rowValue(b) || 0) - (rowValue(a) || 0);
      }).slice(0, 10);
      var railCards = railTopCards.map(function (it, i) {
        var v = rowValue(it);
        return '<button type="button" class="rail-card" data-rail-card="' + i + '">' +
          (it.image_small ? '<img loading="lazy" src="' + App.esc(it.image_small) + '" alt="' + App.esc(it.card_name || "") + '">' : "") +
          '<span class="rc-body"><span class="rc-name" title="' + App.esc(it.card_name || "") + '">' + App.esc(it.card_name || "?") + "</span>" +
          '<span class="rc-value">' + (v !== null ? App.ui.money(v) : "—") + "</span></span>" +
        "</button>";
      }).join("");

      var html =
        '<section class="home-hero reveal">' +
          '<div class="home-hero-text">' +
            '<span class="home-kicker">' + App.esc(readOnly ? "Vedant's Pokémon TCG collection" : "My Pokémon TCG collection") + "</span>" +
            '<h1 class="home-title">The <em>Vault</em></h1>' +
            '<p class="home-sub">Every pull, every grail — one vault. Take a look around, or crack a pack just for fun.</p>' +
            '<div class="home-stats">' +
              '<div class="home-stat"><span class="home-stat-value" data-countup-money="' + totalValue.toFixed(2) + '">' + App.ui.money(totalValue) + "</span>" +
              '<span class="home-stat-label">Vault value</span></div>' +
              '<div class="home-stat"><span class="home-stat-value" data-countup="' + totals.count + '">' + totals.count.toLocaleString() + "</span>" +
              '<span class="home-stat-label">Total cards</span></div>' +
            "</div>" +
          "</div>" +
          '<div class="home-hero-art"><img src="/images/home-hero.webp" alt="An open vault door glowing with light, holographic trading cards swirling out"></div>' +
        "</section>" +

        /* Mobile-only scan entry: the scanner needs a phone camera, so
         * desktop users never see this. Placed between the hero and the
         * entry cards so it reads as the primary action on phones. */
        ((App.scan && App.scan.scanCapable())
          ? '<a class="home-scan-cta reveal" href="/scan">' +
              '<span class="home-scan-ico" aria-hidden="true">' + App.ui.icon("camera") + "</span>" +
              '<span class="home-scan-body">' +
                '<span class="home-scan-title">Scan a card</span>' +
                '<span class="home-scan-meta">Point your camera at a card to add it to the vault</span>' +
              "</span>" +
              '<span class="home-entry-arrow" aria-hidden="true">' + App.ui.icon("chev-r") + "</span>" +
            "</a>"
          : "") +

        '<section class="home-entries">' +
          '<a class="home-entry reveal" href="/collection">' +
            '<span class="home-entry-art">' + (collArt ? '<img loading="lazy" src="' + App.esc(collArt) + '" alt="">' : "") + "</span>" +
            '<span class="home-entry-body">' +
              '<span class="home-kicker">Browse</span>' +
              '<span class="home-entry-title">' + App.esc(readOnly ? "Vedant's Collection" : "My Collection") + "</span>" +
              '<span class="home-entry-meta">' + totals.count.toLocaleString() + " cards · " + App.ui.money(totalValue) + "</span>" +
            "</span>" +
            '<span class="home-entry-arrow" aria-hidden="true">' + App.ui.icon("chev-r") + "</span>" +
          "</a>" +
          '<a class="home-entry reveal" href="/trade">' +
            '<span class="home-entry-art">' + (tradeArt ? '<img loading="lazy" src="' + App.esc(tradeArt) + '" alt="">' : "") + "</span>" +
            '<span class="home-entry-body">' +
              '<span class="home-kicker">Trade</span>' +
              '<span class="home-entry-title">Trade Binder</span>' +
              '<span class="home-entry-meta">' + (tradeCount === 1 ? "1 card up for trade" : tradeCount + " cards up for trade") + "</span>" +
            "</span>" +
            '<span class="home-entry-arrow" aria-hidden="true">' + App.ui.icon("chev-r") + "</span>" +
          "</a>" +
        "</section>" +

        (hasGraph
          ? '<section class="home-graph reveal" data-spot-graph>' +
            '<div class="home-section-head"><h2 class="home-h2">Vault value over time</h2>' +
            '<span class="spot-graph-change flat" data-spot-change></span></div>' +
            '<div class="spot-chart-wrap">' +
              '<div class="spot-chart" data-spot-chart></div>' +
              '<div class="spot-tip" data-spot-tip hidden></div>' +
            "</div>" +
            '<div class="spot-ranges"><span class="spot-range-track">' +
              GRAPH_RANGES.map(function (r) {
                return '<button type="button" data-range="' + r.id + '">' + r.label + "</button>";
              }).join("") +
            "</span></div>" +
            "</section>"
          : "") +

        '<div class="rail-section reveal">' +
          '<div class="rail-head"><span class="rail-title">Top of the vault</span>' +
          '<span class="rail-nav">' +
            '<button type="button" class="btn-icon" data-rail-nav="prev" aria-label="Scroll left">' + App.ui.icon("chev-l") + "</button>" +
            '<button type="button" class="btn-icon" data-rail-nav="next" aria-label="Scroll right">' + App.ui.icon("chev-r") + "</button>" +
          "</span></div>" +
          '<div class="rail" data-rail>' + railCards + "</div>" +
        "</div>" +

        '<section class="home-pack reveal">' +
          '<div class="home-pack-art"><img loading="lazy" src="/images/home-pack.webp" alt="A holographic booster pack bursting open with light and cards flying out"></div>' +
          '<div class="home-pack-text">' +
            '<span class="home-kicker">Just for fun</span>' +
            '<h2 class="home-h2">Feeling lucky?</h2>' +
            '<p class="home-sub">Rip open a fresh pack and pull a random card from the vault. No cards were harmed.</p>' +
            '<button type="button" class="btn btn-primary btn-lg" data-pack-open>Crack a pack</button>' +
          "</div>" +
        "</section>";

      root.innerHTML = html;

      App.ui.bindCounters(root);
      var sg = root.querySelector("[data-spot-graph]");
      if (sg && hasGraph) bindSpotGraph(sg, history);
      var rail = root.querySelector("[data-rail]");
      if (rail) {
        root.querySelectorAll("[data-rail-nav]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            rail.scrollBy({ left: (btn.getAttribute("data-rail-nav") === "next" ? 340 : -340), behavior: "smooth" });
          });
        });
        rail.querySelectorAll("[data-rail-card]").forEach(function (rc) {
          rc.addEventListener("click", function () {
            var it = railTopCards[parseInt(rc.getAttribute("data-rail-card"), 10)];
            if (it) App.openCardModal(it.card_id, langOf(it), it, rc.querySelector("img") || rc);
          });
        });
      }
      var packBtn = root.querySelector("[data-pack-open]");
      if (packBtn) packBtn.addEventListener("click", function () { openPack(items); });
      App.ui.reveal(root);
      window.scrollTo(0, 0);
    };

})();
