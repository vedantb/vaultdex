/* VaultDex — shared pure helpers and constants used across modules.
 * Loaded before tcg-api.js/pkmn.js/ui.js so every module can use it.
 * No DOM, no network of its own: just language detection, fetch plumbing,
 * number normalization, and the label/budget constants views share. */
(function () {
  window.App = window.App || {};

  var JA_PREFIX = "ja-";

  /* Language of a set id ("ja-M4" -> "ja"), a collection row ({set_id}),
   * or a catalog card ({set: {id}}). Collection rows store set ids
   * appId-style, so this prefix test is the single source of truth. */
  function langOf(x) {
    if (typeof x === "string") {
      return x.indexOf(JA_PREFIX) === 0 ? "ja" : "en";
    }
    if (x && typeof x.set_id === "string") {
      return x.set_id.indexOf(JA_PREFIX) === 0 ? "ja" : "en";
    }
    if (x && x.set && typeof x.set.id === "string") {
      return x.set.id.indexOf(JA_PREFIX) === 0 ? "ja" : "en";
    }
    return "en";
  }

  function isJa(x) { return langOf(x) === "ja"; }

  /* fetch() with a hard timeout: a stalled request must reject instead of
   * hanging the page forever. A hung snapshot fetch once left set pages
   * blank (no header, no grid, no error) because every later render step
   * awaited it; a hung proxy request wedged the set page's pkmn_id
   * backfill for minutes. Callers already catch failures and fall back or
   * show an error state — they just never got the chance while the promise
   * hung. Default 20s; callers may pass their own budget. */
  function fetchWithTimeout(url, opts, timeoutMs) {
    var ctrl = null;
    var timer = null;
    var ms = timeoutMs || 20000;
    try {
      if (typeof AbortController !== "undefined") {
        ctrl = new AbortController();
        timer = setTimeout(function () { ctrl.abort(); }, ms);
      }
    } catch (e) { /* very old browser: fetch without a timeout */ }
    var o = {};
    if (opts) {
      for (var k in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
      }
    }
    if (ctrl) o.signal = ctrl.signal;
    return fetch(url, o).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  /* "001" -> "1", so padded TCGdex numbers match unpadded ones everywhere
   * (PkmnPrices matching, owned-row keys, display). */
  function normNumber(n) {
    return String(n == null ? "" : n).trim().toLowerCase().replace(/^0+(?=\d)/, "");
  }

  /* Print-variant labels shown across tiles, modals, and collection rows. */
  var VARIANT_LABELS = {
    normal: "Normal",
    holofoil: "Holofoil",
    reverseHolofoil: "Reverse Holo"
  };

  /* Budget filter bands (per-copy market price), shared by the collection
   * and trade views. */
  var BUDGETS = [
    { label: "Under $10", min: "", max: "10" },
    { label: "$10–$50", min: "10", max: "50" },
    { label: "$50–$100", min: "50", max: "100" },
    { label: "$100+", min: "100", max: "" }
  ];

  /* Most valuable card image from a list of rows — the face of a hub card.
   * Skips images already used on the screen (via `used`) so tiles look
   * different; valueOf maps a row to its numeric worth for the ranking. */
  function topImage(list, used, valueOf) {
    used = used || {};
    var best = "", bestV = -1;
    list.forEach(function (it) {
      if (!it.image_small || used[it.image_small]) return;
      var v = valueOf ? valueOf(it) : 0;
      if (v > bestV) { bestV = v; best = it.image_small; }
    });
    if (best) used[best] = true;
    return best;
  }

  App.util = {
    langOf: langOf,
    isJa: isJa,
    fetchWithTimeout: fetchWithTimeout,
    normNumber: normNumber,
    VARIANT_LABELS: VARIANT_LABELS,
    BUDGETS: BUDGETS,
    topImage: topImage
  };
})();
