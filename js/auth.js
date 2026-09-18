/* VaultDex — authentication via Supabase Auth (Google OAuth). */
(function () {
  window.App = window.App || {};

  var listeners = [];

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(App.auth.user); } catch (e) { console.error(e); }
    });
  }

  async function upsertProfile(user) {
    if (!App.sb || !user) return;
    var meta = user.user_metadata || {};
    try {
      var res = await App.sb.from("profiles").upsert(
        {
          id: user.id,
          display_name: meta.full_name || meta.name || user.email,
          avatar_url: meta.avatar_url || meta.picture || null
        },
        { onConflict: "id" }
      );
      if (res.error) console.warn("[VaultDex] profile upsert failed:", res.error.message);
    } catch (e) {
      console.warn("[VaultDex] profile upsert failed:", e.message);
    }
  }

  /* Pulls an OAuth session out of the URL fragment when the Supabase client's
   * own URL detection can't parse it (see init), then returns the user. */
  async function recoverSessionFromHash() {
    var hash = window.location.hash || "";
    var at = hash.match(/access_token=([^&#]+)/);
    var rt = hash.match(/refresh_token=([^&#]+)/);
    if (!at || !rt) return null;
    try {
      var res = await App.sb.auth.setSession({
        access_token: decodeURIComponent(at[1]),
        refresh_token: decodeURIComponent(rt[1])
      });
      if (res.error) {
        console.warn("[VaultDex] OAuth session recovery failed:", res.error.message);
        return null;
      }
      var session = res.data && res.data.session;
      return (session && session.user) || null;
    } catch (e) {
      console.warn("[VaultDex] OAuth session recovery failed:", e && e.message);
      return null;
    }
  }

  /* Removes OAuth token params from the URL fragment after sign-in,
   * returning to the page the sign-in started from. App.auth.signIn bakes
   * that path into redirectTo, so a mid-task sign-in (e.g. a set-page
   * checkbox while the session lapsed) lands back where the user was
   * adding cards instead of being dumped on /collection. */
  function scrubAuthParamsFromHash() {
    var hash = window.location.hash || "";
    if (hash.indexOf("access_token=") === -1) return;
    var path = window.location.pathname || "/collection";
    if (path === "/login") path = "/collection";
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", path);
    } else {
      window.location.hash = "";
    }
  }

  var auth = {
    user: null,

    onChange: function (fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (f) { return f !== fn; });
      };
    },

    /* Owner-only gate: VaultDex is a single-owner showcase, so a signed-in
     * session that isn't the owner's is signed straight back out — a random
     * Google account completing OAuth at /login never becomes a valid user.
     * Marks the rejection so /login can show a note instead of looping. */
    enforceOwner: async function () {
      if (auth.user && !auth.isOwner()) {
        var email = auth.user.email || "that Google account";
        try { await App.sb.auth.signOut(); } catch { /* already out */ }
        auth.user = null;
        try { sessionStorage.setItem("vaultdex_rejected", "1"); } catch { /* ignored */ }
        notify();
        App.ui.toast("Only the vault owner's Google account can sign in — " + email + " was signed out.", "error");
        return false;
      }
      return true;
    },

    init: async function () {
      if (!App.isConfigured()) return;
      try {
        var sess = await App.sb.auth.getSession();
        var user = (sess.data && sess.data.session && sess.data.session.user) || null;
        if (!user) {
          // The OAuth redirect target ends in "#/collection" (kept stable so
          // the Supabase redirect allowlist never changes), so Supabase
          // appends its tokens after that fragment, which the client's
          // built-in URL detection cannot parse. Recover the session manually.
          user = await recoverSessionFromHash();
        }
        if (user) scrubAuthParamsFromHash();
        auth.user = user;
        await auth.enforceOwner();
        if (auth.user) await upsertProfile(auth.user);
        notify();
        App.sb.auth.onAuthStateChange(async function (_event, session) {
          var u = (session && session.user) || null;
          auth.user = u;
          await auth.enforceOwner();
          if (auth.user) upsertProfile(auth.user);
          notify();
        });
      } catch (e) {
        console.error("[VaultDex] auth init failed:", e);
      }
    },

    signIn: function () {
      if (!App.isConfigured()) {
        App.ui.toast("Supabase isn't configured yet — see SETUP.md.", "error");
        return;
      }
      var basePath = window.location.pathname === "/login" ? "/" : window.location.pathname;
      var redirectTo = window.location.origin + basePath + "#/collection";
      App.sb.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: redirectTo }
      });
    },

    signOut: async function () {
      if (!App.sb) return;
      await App.sb.auth.signOut();
      App.ui.toast("Signed out.", "info");
      if (App.navigate) App.navigate("/collection");
      else window.location.pathname = "/collection";
    },

    /* True only when the signed-in user is the collection's owner —
     * the only account that may browse the catalog or edit anything.
     * Signed-out visitors and non-owner accounts get the public
     * read-only collection view. */
    isOwner: function () {
      var owner = (window.APP_CONFIG && window.APP_CONFIG.OWNER_USER_ID) || "";
      return !!(auth.user && owner && auth.user.id === owner);
    },

    /* Returns the user, or shows the sign-in prompt and returns null. */
    requireUser: function () {
      if (auth.user) return auth.user;
      App.ui.signInPrompt();
      return null;
    }
  };

  App.auth = auth;
})();
