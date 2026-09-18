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

  /* ---------- header auth area ---------- */
  function updateNavVisibility() {
    // The catalog is owner-only; visitors get the public collection page.
    var show = App.auth.isOwner();
    document.querySelectorAll('[data-nav="browse"]').forEach(function (a) {
      a.style.display = show ? "" : "none";
    });
    // Visitors see whose collection this is; the owner sees "My Collection".
    var label = show ? "My Collection" : "Vedant's Collection";
    document.querySelectorAll('[data-nav="collection"]').forEach(function (a) {
      a.textContent = label;
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
    route();
  }
  App.navigate = navigate;

  function setActiveNav() {
    var path = window.location.pathname || "/";
    var key = (path === "/" || path === "/index.html") ? "home"
      : (path === "/browse" || path.indexOf("/set/") === 0) ? "browse"
      : path === "/trade" ? "trade"
      : "collection"; /* /wishlist and /movers have no nav links; they read as collection pages */
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
    // Intercept in-app links so navigation stays client-side.
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="/"]') : null;
      if (!a) return;
      if (a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      var href = a.getAttribute("href");
      if (href === "/" || href === "/login" || href === "/collection" || href === "/browse" ||
          href === "/wishlist" || href === "/movers" || href === "/trade" ||
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
