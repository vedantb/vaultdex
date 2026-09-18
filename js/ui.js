/* VaultDex — shared UI helpers: icons, toasts, modals, skeletons, formatting. */
(function () {
  window.App = window.App || {};

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var P = function (inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";
  };

  var icons = {
    search: P('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
    sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon: P('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    gear: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1z"/>'),
    plus: P('<path d="M12 5v14M5 12h14"/>'),
    minus: P('<path d="M5 12h14"/>'),
    x: P('<path d="M18 6L6 18M6 6l12 12"/>'),
    check: P('<path d="M20 6L9 17l-5-5"/>'),
    trash: P('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
    refresh: P('<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>'),
    target: P('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>'),
    "chev-l": P('<path d="M15 18l-6-6 6-6"/>'),
    logout: P('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
    cards: P('<rect x="3" y="6" width="13" height="16" rx="2"/><path d="M8 3h11a2 2 0 0 1 2 2v13"/>'),
    tag: P('<path d="M20.6 13.4L11 3.8A2 2 0 0 0 9.6 3H4a1 1 0 0 0-1 1v5.6c0 .5.2 1 .6 1.4l9.6 9.6a2 2 0 0 0 2.8 0l4.6-4.6a2 2 0 0 0 0-2.6z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
    chevL: P('<path d="M15 18l-6-6 6-6"/>'),
    chevR: P('<path d="M9 18l6-6-6-6"/>'),
    sliders: P('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
    google: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.3H12v4.3h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.1.1 3.5 2.7.2.1c2.2-2 3.8-5 3.8-8.7z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.8-5l-.1.1-3.6 2.8v.1C3.5 21.3 7.5 24 12 24z"/><path fill="#FBBC05" d="M5.2 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-.1-.2-3.6-2.8-.1.1C.5 8.5 0 10.1 0 12s.5 3.5 1.4 5.1l3.8-2.7z"/><path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.5 0 3.5 2.7 1.4 6.6l3.8 2.9c1-2.8 3.7-4.8 6.8-4.8z"/></svg>'
  };

  function icon(name) { return icons[name] || ""; }

  /* ---------- toasts ---------- */
  function toast(msg, type) {
    type = type || "info";
    var root = document.getElementById("toast-root");
    var el = document.createElement("div");
    el.className = "toast " + type;
    el.innerHTML = "<span>" + esc(msg) + "</span>";
    root.appendChild(el);
    setTimeout(function () {
      el.classList.add("out");
      setTimeout(function () { el.remove(); }, 350);
    }, 3600);
  }

  /* ---------- modal ---------- */
  function openModal(html, opts) {
    opts = opts || {};
    var root = document.getElementById("modal-root");
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal' + (opts.narrow ? " narrow" : "") + '" role="dialog" aria-modal="true">' +
      '<button class="btn-icon modal-close" aria-label="Close">' + icon("x") + "</button>" +
      '<div class="modal-body">' + html + "</div></div>";

    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(); });
    overlay.querySelector(".modal-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    root.appendChild(overlay);
    return { close: close, el: overlay };
  }

  /* ---------- sign-in prompt (used whenever a write needs auth) ---------- */
  function signInPrompt() {
    var m = openModal(
      '<div class="signin-box">' +
        '<div class="big-icon">' + icon("cards") + "</div>" +
        "<h3>Sign in to save cards</h3>" +
        "<p>Your collection is tied to your account, so sign in with Google to add cards, track quantities, and keep everything synced.</p>" +
        '<button class="btn btn-google" id="prompt-google-btn">' + icon("google") + " Continue with Google</button>" +
      "</div>",
      { narrow: true }
    );
    m.el.querySelector("#prompt-google-btn").addEventListener("click", function () {
      m.close();
      App.auth.signIn();
    });
  }

  /* ---------- settings ---------- */
  function openSettings() {
    var m = openModal(
      "<h2>Settings</h2>" +
      '<div class="field" style="margin-bottom:14px">' +
        "<label>Card catalog</label>" +
        '<p style="font-size:0.86rem;color:var(--muted);margin:6px 0 0">Card data, artwork, and TCGPlayer reference prices come from ' +
        '<a href="https://tcgdex.dev" target="_blank" rel="noopener">TCGdex</a>. No API key needed — it just works.</p>' +
      "</div>" +
      '<div class="field" style="margin-bottom:14px">' +
        "<label>Collection pricing</label>" +
        '<p style="font-size:0.86rem;color:var(--muted);margin:6px 0 0">Your collection is priced per exact printing (Near Mint) via PkmnPrices.</p>' +
      "</div>" +
      '<div style="display:flex;gap:10px;justify-content:flex-end">' +
        '<button class="btn btn-primary" id="set-close">Done</button>' +
      "</div>",
      { narrow: true }
    );
    m.el.querySelector("#set-close").addEventListener("click", m.close);
  }

  /* ---------- loading / empty states ---------- */
  function skeletonGrid(root, n) {
    n = n || 12;
    var html = '<div class="card-grid">';
    for (var i = 0; i < n; i++) {
      html += '<div class="skeleton"><div class="art"></div><div class="bar"></div><div class="bar short"></div></div>';
    }
    root.innerHTML = html + "</div>";
  }

  function emptyState(opts) {
    return (
      '<div class="empty-state">' +
        '<div class="big-icon">' + icon(opts.icon || "cards") + "</div>" +
        "<h3>" + esc(opts.title || "Nothing here yet") + "</h3>" +
        "<p>" + esc(opts.body || "") + "</p>" +
        (opts.actionHtml || "") +
      "</div>"
    );
  }

  /* ---------- formatting ---------- */
  function money(n, currency) {
    if (n === null || n === undefined || isNaN(Number(n))) return "—";
    var sym = currency === "EUR" ? "€" : "$";
    return sym + Number(n).toFixed(2);
  }

  function timeAgo(ts) {
    if (!ts) return "never";
    var s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 300);
    };
  }

  /* ---------- motion helpers (motion.css) ---------- */
  var reduceMotion = typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Staggered tile entrances: call on a freshly rendered grid. Tiles get
   * .tile-enter with --i capped so long grids don't cascade forever. */
  function staggerTiles(root, selector) {
    var tiles = root.querySelectorAll(selector || ".card-tile, .set-tile");
    tiles.forEach(function (t, i) {
      t.classList.remove("tile-enter");
      t.style.setProperty("--i", i % 12);
      /* reflow so re-renders replay the entrance */
      void t.offsetWidth;
      t.classList.add("tile-enter");
    });
  }

  /* Scroll-triggered reveals: elements with .reveal get .in once visible. */
  var revealObserver = null;
  function reveal(scope) {
    scope = scope || document;
    if (reduceMotion) {
      scope.querySelectorAll(".reveal").forEach(function (e) { e.classList.add("in"); });
      return;
    }
    if (!("IntersectionObserver" in window)) {
      scope.querySelectorAll(".reveal").forEach(function (e) { e.classList.add("in"); });
      return;
    }
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add("in"); revealObserver.unobserve(en.target); }
        });
      }, { threshold: 0.12 });
    }
    scope.querySelectorAll(".reveal:not(.in)").forEach(function (e) { revealObserver.observe(e); });
  }

  /* Animated count-up: el with data-countup="1234" (int) or
   * data-countup-money="8981.21". Call after rendering stats. */
  function countUp(elm, target, format) {
    if (reduceMotion) { elm.textContent = format(target); return; }
    var dur = 1100, t0 = null;
    function frame(t) {
      if (!t0) t0 = t;
      var p = Math.min(1, (t - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      elm.textContent = format(target * e);
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  function bindCounters(scope) {
    scope = scope || document;
    scope.querySelectorAll("[data-countup]").forEach(function (elm) {
      countUp(elm, parseFloat(elm.getAttribute("data-countup")) || 0, function (v) {
        return Math.round(v).toLocaleString("en-US");
      });
    });
    scope.querySelectorAll("[data-countup-money]").forEach(function (elm) {
      countUp(elm, parseFloat(elm.getAttribute("data-countup-money")) || 0, function (v) {
        return money(v, elm.getAttribute("data-countup-ccy") || "USD");
      });
    });
  }

  App.ui = {
    esc: esc,
    icon: icon,
    toast: toast,
    openModal: openModal,
    signInPrompt: signInPrompt,
    openSettings: openSettings,
    skeletonGrid: skeletonGrid,
    emptyState: emptyState,
    money: money,
    timeAgo: timeAgo,
    debounce: debounce,
    staggerTiles: staggerTiles,
    reveal: reveal,
    bindCounters: bindCounters,
    reduceMotion: reduceMotion
  };
  App.esc = esc; // convenience alias
})();
