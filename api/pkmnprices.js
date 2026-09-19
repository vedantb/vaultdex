/* VaultDex — PkmnPrices API proxy.
 *
 * The browser never sees the PkmnPrices API key. This serverless function
 * forwards allow-listed /v1/* requests to https://api.pkmnprices.com with the
 * key attached server-side.
 *
 * Abuse protection (the upstream key is paid & credit-capped):
 *   1. Path allow-list — only the three endpoints the app actually uses.
 *   2. Caller check — browser traffic must come from our own site
 *      (Referer/Origin host allow-list); the Python backfill scripts send a
 *      shared secret header instead (they run server-side, no Referer).
 *   3. Per-IP sliding-window rate limit (best-effort: serverless instances
 *      don't share memory, so this blunts naive floods, not distributed ones).
 *
 * Required env vars (Vercel → Project Settings → Environment Variables):
 *   PKMNPRICES_API_KEY   — the PkmnPrices Pro key (server-side only, never shipped)
 *   PROXY_SHARED_SECRET  — random hex string; the backfill scripts send it as
 *                          x-vaultdex-key. Lives in ~/workspace/.secrets/ on the VM.
 */
var UPSTREAM = "https://api.pkmnprices.com";

/* Hosts allowed to call the proxy from a browser. */
var ALLOWED_HOSTS = {
  "vaultdex-three.vercel.app": true,
  "localhost": true,
  "127.0.0.1": true
};

/* /v1/cards, /v1/cards/<numeric id>, /v1/cards/<numeric id>/listings/ebay */
var PATH_RE = /^\/v1\/cards(?:\/(\d+)(?:\/listings\/ebay)?)?$/;

/* 120 requests per rolling 60s window, per client IP. */
var RATE_LIMIT = 120;
var RATE_WINDOW_MS = 60000;
var hits = {};

function clientIp(req) {
  var fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function rateLimited(ip) {
  var now = Date.now();
  var arr = hits[ip] || [];
  arr = arr.filter(function (t) { return now - t < RATE_WINDOW_MS; });
  if (arr.length >= RATE_LIMIT) {
    hits[ip] = arr;
    return true;
  }
  arr.push(now);
  hits[ip] = arr;
  /* Keep the map from growing without bound. */
  if (Object.keys(hits).length > 5000) hits = {};
  return false;
}

function hostAllowed(req) {
  var ref = req.headers.referer || req.headers.origin || "";
  if (!ref) return false;
  var m = String(ref).match(/^https?:\/\/([^/:?#]+)/i);
  return !!(m && ALLOWED_HOSTS[m[1].toLowerCase()]);
}

/* Credit-burn guard: PkmnPrices bills 1 credit per item returned, so an
 * unbounded per_page turns the 120/min rate limit into a budget hose
 * (120 × 100 credits/min from a single IP with a spoofed Referer).
 * Browser callers get the page size the app actually uses (50); script
 * callers (shared-secret header) get headroom for bulk backfills. */
var MAX_PER_PAGE = { script: 200, browser: 50 };

function capPerPage(raw, mode) {
  var cap = MAX_PER_PAGE[mode] || MAX_PER_PAGE.browser;
  var n = parseInt(raw, 10);
  if (!isFinite(n) || n < 1) return cap;
  return Math.min(n, cap);
}

function callerMode(req) {
  var secret = process.env.PROXY_SHARED_SECRET;
  if (secret && req.headers["x-vaultdex-key"] === secret) return "script";
  return hostAllowed(req) ? "browser" : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  var path = req.query.path;
  if (typeof path !== "string" || !PATH_RE.test(path)) {
    res.status(404).json({ error: "Not proxied." });
    return;
  }

  var mode = callerMode(req);
  if (!mode) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }

  if (rateLimited(clientIp(req))) {
    res.status(429).json({ error: "Too many requests." });
    return;
  }

  var key = process.env.PKMNPRICES_API_KEY;
  if (!key) {
    res.status(503).json({
      error: "PkmnPrices is not configured yet.",
      hint: "Add PKMNPRICES_API_KEY to the Vercel project's environment variables."
    });
    return;
  }

  var url = new URL(UPSTREAM + path);
  Object.keys(req.query).forEach(function (k) {
    if (k === "path") return;
    var v = req.query[k];
    var val = function (x) { return k === "per_page" ? String(capPerPage(x, mode)) : x; };
    if (Array.isArray(v)) {
      v.forEach(function (x) { url.searchParams.append(k, val(x)); });
    } else if (v !== undefined) {
      url.searchParams.append(k, val(v));
    }
  });

  var upstream;
  try {
    upstream = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json",
        "x-api-key": key,
        "User-Agent": "VaultDex/1.0 (vercel-proxy)"
      },
      signal: AbortSignal.timeout(9000) // under Vercel's 10s serverless limit: scripts get a clean 502, not a dropped connection
    });
  } catch {
    res.status(502).json({ error: "Could not reach the PkmnPrices API." });
    return;
  }

  var body = await upstream.text();
  res.status(upstream.status);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.send(body);
};

/* Exported for unit tests (vitest). Vercel only uses the default handler. */
module.exports.capPerPage = capPerPage;
module.exports.callerMode = callerMode;
module.exports.MAX_PER_PAGE = MAX_PER_PAGE;
