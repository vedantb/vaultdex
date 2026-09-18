/* VaultDex — Supabase client singleton.
 * Creates window.App.sb, or leaves it null when js/config.js still has
 * placeholder values (the app then runs in browse-only demo mode).
 */
(function () {
  window.App = window.App || {};

  var cfg = window.APP_CONFIG || {};
  var looksReal = function (v) {
    return typeof v === "string" && v.length > 10 && v.indexOf("YOUR_") !== 0;
  };
  var configured = looksReal(cfg.SUPABASE_URL) && looksReal(cfg.SUPABASE_ANON_KEY);

  var client = null;
  if (configured) {
    if (window.supabase && typeof window.supabase.createClient === "function") {
      client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    } else {
      console.error("[VaultDex] Supabase JS failed to load from CDN.");
    }
  }

  App.sb = client;
  App.isConfigured = function () { return !!client; };
})();
