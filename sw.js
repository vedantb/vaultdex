/* VaultDex service worker.
 *
 * Versioned app-shell caching: the static shell (HTML, CSS, JS, icons,
 * manifest) is cached under a versioned key and purged on upgrade.
 * Strategy:
 *   - navigations: network-first, fall back to cached index.html so
 *     installed app still opens on flaky connections;
 *   - shell assets (js/css/manifest/images/icons): cache-first, network
 *     revalidate in background;
 *   - everything else (catalog JSON under /data, images, APIs): network
 *     only — never cached by this worker.
 *
 * Bump SHELL_VERSION on every release that touches shell files.
 */
var SHELL_VERSION = "vaultdex-shell-v1";
var SHELL_FILES = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/css/styles.css",
  "/css/sidebar.css",
  "/css/graded.css",
  "/css/set-progress.css",
  "/css/wishlist.css",
  "/css/movers.css",
  "/css/trade.css",
  "/css/trophies.css",
  "/css/pokedex.css",
  "/css/games.css",
  "/css/motion.css",
  "/css/home.css",
  "/css/scan.css",
  "/js/vendor/supabase.js",
  "/js/config.js",
  "/js/supabase-client.js",
  "/js/util.js",
  "/js/tcg-api.js",
  "/js/pkmn.js",
  "/js/ui.js",
  "/js/auth.js",
  "/js/collection.js",
  "/js/set-progress.js",
  "/js/owned-qty.js",
  "/js/wishlist.js",
  "/js/trade.js",
  "/js/species.js",
  "/js/achievements.js",
  "/js/games.js",
  "/js/fun-facts.js",
  "/js/scan.js",
  "/js/components/card-modal.js",
  "/js/views/browse.js",
  "/js/views/set-view.js",
  "/js/views/collection-view.js",
  "/js/views/home-view.js",
  "/js/views/wishlist-view.js",
  "/js/views/movers-view.js",
  "/js/views/trade-view.js",
  "/js/views/trophies-view.js",
  "/js/views/pokedex-view.js",
  "/js/views/games-view.js",
  "/js/views/scan-view.js",
  "/js/app.js",
  "/images/icon-192.png",
  "/images/icon-512.png",
  "/images/apple-touch-icon.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_VERSION)
      .then(function (cache) { return cache.addAll(SHELL_FILES); })
      .then(function () { return self.skipWaiting(); })
      .catch(function (err) {
        /* Install fails closed: a broken cache set must not strand the
         * app on a partial shell. */
        console.error("[VaultDex SW] install failed:", err);
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k !== SHELL_VERSION && k.indexOf("vaultdex-shell-") === 0) {
            return caches.delete(k);
          }
          return Promise.resolve();
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function isShellAsset(url) {
  var p = url.pathname;
  return p === "/" ||
    p === "/index.html" ||
    p === "/manifest.webmanifest" ||
    p.indexOf("/css/") === 0 ||
    p.indexOf("/js/") === 0 ||
    p.indexOf("/images/") === 0;
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; /* CDN/third-party: leave alone */
  if (!isShellAsset(url)) return; /* catalog data, images, APIs: network only */

  if (req.mode === "navigate" || req.destination === "document") {
    /* Navigations: network first, cached shell as the fallback. */
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match("/index.html", { cacheName: SHELL_VERSION });
      })
    );
    return;
  }

  /* Shell assets: cache-first with background revalidation. */
  event.respondWith(
    caches.open(SHELL_VERSION).then(function (cache) {
      return cache.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      });
    })
  );
});
