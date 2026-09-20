/* VaultDex — app bootstrap: theme, header/auth wiring, path router. */
(function () {
  window.App = window.App || {};

  /* ---------- global API error handling ---------- */
  App.handleApiError = function (err) {
    if (!err) return;
    console.error("[VaultDex]", err);
    if (err.status === 429) {
      App.ui.toast(err.message || "Rate limit reached — please wait a bit and try again.", "error");
    } else if (err.code === "PGRST301" || (err.message && err.message.indexOf("JWT") !== -1)) {
      App.ui.toast("Your session expired — please sign in again.", "error");
    } else {
      App.ui.toast((err.message || "Something went wrong."), "error");
    }
  };

  /* ---------- tiny event bus: views stay in sync when the collection
   * changes through any path (tile checkboxes, card modal, bulk add).
   * App.on returns an unsubscribe function; views must unsubscribe when
   * they re-render so stale closures don't pile up. */
  var busListeners = {};
  App.on = function (evt, fn) {
    (busListeners[evt] = busListeners[evt] || []).push(fn);
    return function () { App.off(evt, fn); };
  };
  App.off = function (evt, fn) {
    var arr = busListeners[evt] || [];
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
  App.emit = function (evt, data) {
    (busListeners[evt] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { console.warn("[VaultDex] event listener failed:", evt, e && e.message); }
    });
  };

  /* ---------- theme ---------- */
  var THEME_KEY = "vd_theme";
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem(THEME_KEY, t);
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.innerHTML = App.ui.icon(t === "dark" ? "sun" : "moon");
      btn.setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
    }
  }
  function initTheme() {
    var saved = localStorage.getItem(THEME_KEY);
    var t = saved || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    applyTheme(t);
    document.getElementById("theme-toggle").addEventListener("click", function () {
      applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
    });
  }

  /* ---------- announcement bar (logged-out visitors only) ---------- */
  var ANNOUNCE_KEY = "vd_announce_v1";
  function renderAnnounceBar() {
    var bar = document.getElementById("announce-bar");
    if (!bar) return;
    var dismissed = false;
    try { dismissed = localStorage.getItem(ANNOUNCE_KEY) === "1"; } catch { /* private mode */ }
    bar.hidden = !!App.auth.user || dismissed;
  }
  function initAnnounceBar() {
    var btn = document.getElementById("announce-bar-close");
    if (!btn) return;
    btn.addEventListener("click", function () {
      document.getElementById("announce-bar").hidden = true;
      try { localStorage.setItem(ANNOUNCE_KEY, "1"); } catch { /* private mode */ }
    });
  }

  /* ---------- sidebar navigation ---------- */
  /* Grouped sidebar (desktop) / slide-in drawer (mobile). Rendered from one
   * config so both stay identical. data-nav keys drive setActiveNav and
   * updateNavVisibility below. */
  var NAV_SECTIONS = [
    { heading: "Explore", items: [
      { key: "home", href: "/", label: "Home", icon: "home" },
      { key: "collection", href: "/collection", label: "Collection", icon: "cards" },
      { key: "pokedex", href: "/pokedex", label: "Pokédex", icon: "pokedex" },
      { key: "trade", href: "/trade", label: "Trade Binder", icon: "trade" },
      { key: "games", href: "/games", label: "Games", icon: "game" },
      { key: "binder", href: "/binder", label: "Binder Studio", icon: "grid" }
    ]},
    { heading: "My Vault", items: [
      { key: "browse", href: "/browse", label: "Browse", icon: "search" },
      { key: "wishlist", href: "/wishlist", label: "Wishlist", icon: "heart" },
      { key: "trophies", href: "/trophies", label: "Trophies", icon: "trophy" },
      { key: "movers", href: "/movers", label: "Price Movers", icon: "chart" }
    ]}
  ];
  function renderSidebar() {
    var nav = document.getElementById("sidebar-nav");
    if (!nav) return;
    nav.innerHTML = NAV_SECTIONS.map(function (sec) {
      return '<div class="nav-section"><h2 class="nav-heading">' + App.esc(sec.heading) + "</h2>" +
        sec.items.map(function (it) {
          return '<a class="nav-item" href="' + it.href + '" data-nav="' + it.key + '" title="' + App.esc(it.label) + '">' +
            '<span class="nav-ico" aria-hidden="true">' + App.ui.icon(it.icon) + "</span>" +
            '<span class="nav-label">' + App.esc(it.label) + "</span></a>";
        }).join("") + "</div>";
    }).join("");
  }

  /* ---------- sidebar collapse (desktop) + drawer (mobile) ---------- */
  var COLLAPSE_KEY = "vd_sidebar_collapsed";
  function applyCollapsed(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", !!collapsed);
    var btn = document.getElementById("sidebar-collapse");
    if (btn) {
      btn.innerHTML = '<span class="nav-ico" aria-hidden="true">' + App.ui.icon(collapsed ? "chev-r" : "chev-l") + "</span>";
      btn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    }
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* private mode */ }
  }
  function openDrawer() {
    document.body.classList.add("drawer-open");
    var b = document.getElementById("hamburger");
    if (b) b.setAttribute("aria-expanded", "true");
  }
  function closeDrawer() {
    document.body.classList.remove("drawer-open");
    var b = document.getElementById("hamburger");
    if (b) b.setAttribute("aria-expanded", "false");
  }
  function initSidebarChrome() {
    renderSidebar();
    var stored = false;
    try { stored = localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { /* private mode */ }
    applyCollapsed(stored);
    var collapseBtn = document.getElementById("sidebar-collapse");
    if (collapseBtn) collapseBtn.addEventListener("click", function () {
      applyCollapsed(!document.body.classList.contains("sidebar-collapsed"));
    });
    var burger = document.getElementById("hamburger");
    if (burger) {
      burger.innerHTML = App.ui.icon("menu");
      burger.addEventListener("click", function () {
        if (document.body.classList.contains("drawer-open")) closeDrawer(); else openDrawer();
      });
    }
    var scrim = document.getElementById("sidebar-scrim");
    if (scrim) scrim.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
  }

  /* ---------- header auth area ---------- */
  function updateNavVisibility() {
    // The catalog is owner-only; visitors get the public collection page.
    var show = App.auth.isOwner();
    ["browse", "trophies", "wishlist", "binder"].forEach(function (k) {
      document.querySelectorAll('[data-nav="' + k + '"]').forEach(function (a) {
        a.style.display = show ? "" : "none";
      });
    });
    // Visitors see whose collection this is; the owner sees "My Collection".
    var label = show ? "My Collection" : "Vedant's Collection";
    document.querySelectorAll('[data-nav="collection"] .nav-label').forEach(function (el) {
      el.textContent = label;
    });
  }
  function renderAuthArea() {
    updateNavVisibility();
    var area = document.getElementById("auth-area");
    if (!App.isConfigured()) {
      area.innerHTML = '<button class="btn btn-ghost btn-sm" id="hdr-signin" disabled title="Add your Supabase credentials in js/config.js first">Sign in</button>';
      return;
    }
    var user = App.auth.user;
    if (user) {
      var meta = user.user_metadata || {};
      var name = App.esc(meta.full_name || meta.name || user.email || "Collector");
      var avatar = App.esc(meta.avatar_url || meta.picture || "");
      area.innerHTML =
        '<div class="user-chip">' +
          (avatar ? '<img src="' + avatar + '" alt="">' : "") +
          "<span>" + name + "</span>" +
          '<button class="btn-icon" id="hdr-signout" aria-label="Sign out" title="Sign out" style="width:30px;height:30px">' + App.ui.icon("logout") + "</button>" +
        "</div>";
      area.querySelector("#hdr-signout").addEventListener("click", function () { App.auth.signOut(); });
    } else {
      // No visible sign-in for visitors — the owner signs in via /login.
      area.innerHTML = "";
    }
    // The settings cog is owner-only; it does nothing for visitors.
    var cog = document.getElementById("settings-btn");
    if (cog) cog.style.display = user ? "" : "none";
  }

  /* ---------- path router ---------- */
  var appEl = document.getElementById("app");
  var renderToken = 0;

  function navigate(path) {
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    closeDrawer();
    route();
  }
  App.navigate = navigate;

  function setActiveNav() {
    var path = window.location.pathname || "/";
    var key = (path === "/" || path === "/index.html") ? "home"
      : (path === "/browse" || path.indexOf("/set/") === 0) ? "browse"
      : path === "/trade" ? "trade"
      : path === "/pokedex" ? "pokedex"
      : path === "/trophies" ? "trophies"
      : path === "/wishlist" ? "wishlist"
      : path === "/movers" ? "movers"
      : (path === "/games" || path.indexOf("/games/") === 0) ? "games"
      : path === "/binder" ? "binder"
      : "collection";
    document.querySelectorAll("[data-nav]").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-nav") === key);
    });
  }

  async function route() {
    var token = ++renderToken;
    var path = window.location.pathname || "/";
    setActiveNav();
    window.scrollTo(0, 0);

    var setMatch = path.match(/^\/set\/([\w.-]+)$/);
    // Legacy set-id aliases (old catalog used me2pt5 for Ascended Heroes).
    var SET_ALIASES = { me2pt5: "me02.5" };
    // Each navigation renders into its own staging node. The node's
    // synchronous first paint (skeletons, headers) is moved into #app
    // immediately so navigation feels instant; the view's slow async tail
    // keeps rendering into the node in place. If a newer navigation
    // supersedes this one, its node was already wiped from #app, so the
    // stale async tail paints into a detached node instead of clobbering
    // the current page. (This was the "Browse flips back to the collection
    // view by itself" bug.)
    var stage = document.createElement("div");
    stage.style.cssText = "position:absolute;left:-99999px;top:0;width:100%;height:0;overflow:hidden;visibility:hidden;pointer-events:none;";
    document.body.appendChild(stage);
    var viewPromise;
    try {
      if (setMatch) {
        var sid = SET_ALIASES[setMatch[1]] || setMatch[1];
        viewPromise = App.views.setView(stage, sid);
      } else if (path === "/" || path === "/index.html") {
        viewPromise = App.views.home(stage);
      } else if (path === "/collection") {
        viewPromise = App.views.collection(stage);
      } else if (path === "/browse") {
        viewPromise = App.views.browse(stage);
      } else if (path === "/wishlist") {
        viewPromise = App.views.wishlist(stage);
      } else if (path === "/movers") {
        viewPromise = App.views.movers(stage);
      } else if (path === "/trade") {
        viewPromise = App.views.trade(stage);
      } else if (path === "/pokedex") {
        viewPromise = App.views.pokedex(stage);
      } else if (path === "/trophies") {
        viewPromise = App.views.trophies(stage);
      } else if (path === "/games") {
        viewPromise = App.views.games(stage);
      } else if (path === "/games/higher-lower") {
        viewPromise = App.views.gameHigherLower(stage);
      } else if (path === "/games/quiz") {
        viewPromise = App.views.gameQuiz(stage);
      } else if (path === "/games/card-of-the-day") {
        viewPromise = App.views.gameCardOfDay(stage);
      } else if (path === "/binder") {
        // Owner-only: visitors are quietly sent home; no sign-in controls.
        if (!App.auth.isOwner()) {
          window.history.replaceState(null, "", "/");
          viewPromise = App.views.home(stage);
        } else {
          viewPromise = App.views.binder(stage);
        }
      } else {
        window.history.replaceState(null, "", "/");
        viewPromise = App.views.home(stage);
      }
    } catch (e) {
      if (stage.parentNode) stage.parentNode.removeChild(stage);
      if (token !== renderToken) return; // superseded by a newer navigation
      App.handleApiError(e);
      return;
    }
    // Reveal the synchronous first paint right away; the async tail
    // continues rendering into the node now that it lives in #app.
    stage.style.cssText = "";
    appEl.innerHTML = "";
    appEl.appendChild(stage);
    try {
      await viewPromise;
    } catch (e) {
      if (token !== renderToken) return; // superseded by a newer navigation
      App.handleApiError(e);
    }
  }

  /* ---------- boot ---------- */
  function describeConfigProblem() {
    var cfg = window.APP_CONFIG || {};
    var urlOk = typeof cfg.SUPABASE_URL === "string" && cfg.SUPABASE_URL.length > 10 && cfg.SUPABASE_URL.indexOf("YOUR_") !== 0;
    var keyOk = typeof cfg.SUPABASE_ANON_KEY === "string" && cfg.SUPABASE_ANON_KEY.length > 10 && cfg.SUPABASE_ANON_KEY.indexOf("YOUR_") !== 0;
    var libOk = !!(window.supabase && typeof window.supabase.createClient === "function");
    return "check: config file " + (window.APP_CONFIG ? "found" : "MISSING") +
      " · url " + (urlOk ? "ok" : "MISSING") +
      " · key " + (keyOk ? "ok" : "MISSING") +
      " · library " + (libOk ? "loaded" : "FAILED");
  }

  async function boot() {
    initTheme();
    initAnnounceBar();
    initSidebarChrome();
    document.getElementById("settings-btn").innerHTML = App.ui.icon("gear");
    document.getElementById("settings-btn").addEventListener("click", function () { App.ui.openSettings(); });

    if (!App.isConfigured()) {
      var banner = document.getElementById("setup-banner");
      banner.hidden = false;
      var diag = document.getElementById("setup-banner-diag");
      if (diag) { diag.textContent = describeConfigProblem(); diag.hidden = false; }
      document.getElementById("setup-banner-close").addEventListener("click", function () {
        banner.hidden = true;
      });
    }

    renderAuthArea();
    App.auth.onChange(renderAuthArea);
    renderAnnounceBar();
    App.auth.onChange(renderAnnounceBar);
    await App.auth.init();

    // Discreet owner sign-in at /login — not linked anywhere in the UI.
    // A rejected non-owner (see auth.enforceOwner) gets a note, not an
    // OAuth loop.
    if (window.location.pathname === "/login") {
      if (App.auth.user) {
        window.history.replaceState(null, "", "/");
      } else if (sessionStorage.getItem("vaultdex_rejected")) {
        sessionStorage.removeItem("vaultdex_rejected");
        window.history.replaceState(null, "", "/");
        App.ui.toast("This vault is private — only the owner's Google account can sign in.", "error");
      } else {
        App.auth.signIn();
        return;
      }
    }

    // One-time: rewrite pre-TCGdex catalog ids on the user's rows so owned
    // state matches again. Awaited before routing to avoid a stale 0/N flash.
    if (App.auth.user && App.collection && App.collection.migrateLegacyCatalogIds) {
      try { await App.collection.migrateLegacyCatalogIds(); } catch { /* retries next boot */ }
    }

    window.addEventListener("popstate", route);
    // Achievements (owner only): diff unlocks against localStorage and toast
    // genuinely new ones (first run populates silently); celebrate sets that
    // newly hit 100% whenever the collection changes. Fire-and-forget —
    // never blocks routing, and every path is guarded internally.
    if (App.auth.isOwner() && App.achievements) {
      App.achievements.checkNewUnlocks().catch(function () { /* ignored */ });
      App.on("collection:changed", function () {
        try { App.achievements.checkSetCompletions(); } catch { /* ignored */ }
      });
    }
    // Intercept in-app links so navigation stays client-side.
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="/"]') : null;
      if (!a) return;
      if (a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      var href = a.getAttribute("href");
      if (href === "/" || href === "/login" || href === "/collection" || href === "/browse" ||
          href === "/wishlist" || href === "/movers" || href === "/trade" ||
          href === "/pokedex" || href === "/trophies" ||
          href === "/games" || href.indexOf("/games/") === 0 ||
          href === "/binder" ||
          href.indexOf("/set/") === 0) {
        e.preventDefault();
        navigate(href);
      }
    });
    route();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
