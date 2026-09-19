/* VaultDex — games: shared pure helpers for Higher or Lower, Card Quiz,
 * and Card of the Day. All helpers are deterministic and side-effect free
 * except the localStorage best-score helpers (quiet on failure). Zero
 * PkmnPrices credits: everything reads stored row fields only. */
(function () {
  window.App = window.App || {};
  App.games = App.games || {};
  var G = App.games;

  /* FNV-1a hash of a string -> uint32. */
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* mulberry32 seeded PRNG -> function returning [0, 1). */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Stored market price of a row, or null when missing/unusable. */
  function priceOf(row) {
    var p = Number(row && row.market_price);
    return (isFinite(p) && p > 0) ? p : null;
  }

  function withImage(rows) {
    return (rows || []).filter(function (r) { return r && r.image_small; });
  }

  function withPrice(rows) {
    return (rows || []).filter(function (r) { return priceOf(r) !== null; });
  }

  /* Deterministic index into a pool of `count` for a YYYY-MM-DD date string.
   * Same date -> same index, always. */
  function dailyIndex(count, dateStr) {
    if (!count || count < 1) return -1;
    return hashStr("vaultdex-cotd:" + dateStr) % count;
  }

  /* Deterministic Card of the Day: one imaged card per calendar date. */
  function pickForDate(rows, dateStr) {
    var pool = withImage(rows);
    if (!pool.length) return null;
    return pool[dailyIndex(pool.length, dateStr)];
  }

  /* Fisher-Yates shuffle (pure: returns a new array). rand -> [0, 1). */
  function shuffle(arr, rand) {
    var out = arr.slice();
    rand = rand || Math.random;
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  /* Higher or Lower pair: two distinct rows, both priced, with a >=10% price
   * gap (ties and near-ties are impossible by construction). Returns
   * [rowA, rowB] or null when no qualifying pair exists. */
  function pickHigherLowerPair(rows, rand) {
    var pool = withPrice(rows).filter(function (r) { return r.image_small; });
    if (pool.length < 2) return null;
    rand = rand || Math.random;
    function gapOk(a, b) {
      var pa = priceOf(a), pb = priceOf(b);
      var lo = Math.min(pa, pb), hi = Math.max(pa, pb);
      return lo > 0 && (hi - lo) / lo >= 0.10;
    }
    for (var t = 0; t < 80; t++) {
      var i = Math.floor(rand() * pool.length);
      var j = Math.floor(rand() * pool.length);
      if (i !== j && gapOk(pool[i], pool[j])) return [pool[i], pool[j]];
    }
    /* Fallback: the cheapest and priciest rows have the maximum possible
     * gap. If even they don't qualify, no pair can. */
    var sorted = pool.slice().sort(function (a, b) { return priceOf(a) - priceOf(b); });
    var lo = sorted[0], hi = sorted[sorted.length - 1];
    return gapOk(lo, hi) ? [lo, hi] : null;
  }

  /* Quiz options for a round: the correct card plus 3 distractors with
   * distinct names, preferring cards from the same set (plausible wrong
   * answers), shuffled. Returns [{ row, correct }] or null when the
   * collection is too small. */
  function buildQuizOptions(correct, rows, rand) {
    if (!correct || !correct.card_name) return null;
    rand = rand || Math.random;
    var seen = {};
    seen[String(correct.card_name).toLowerCase()] = true;
    var distract = [];
    function take(pool) {
      var cands = shuffle(pool.filter(function (r) {
        return r && r !== correct && r.card_name && r.image_small &&
          !seen[String(r.card_name).toLowerCase()];
      }), rand);
      for (var i = 0; i < cands.length && distract.length < 3; i++) {
        seen[String(cands[i].card_name).toLowerCase()] = true;
        distract.push(cands[i]);
      }
    }
    if (correct.set_name) {
      take((rows || []).filter(function (r) { return r && r.set_name === correct.set_name; }));
    }
    if (distract.length < 3) take(rows || []);
    if (distract.length < 3) return null;
    var options = [{ row: correct, correct: true }].concat(distract.map(function (r) {
      return { row: r, correct: false };
    }));
    return shuffle(options, rand);
  }

  /* Random quiz round: pick a random imaged card as the answer. */
  function pickQuizAnswer(rows, rand) {
    var pool = withImage(rows).filter(function (r) { return r.card_name; });
    if (!pool.length) return null;
    rand = rand || Math.random;
    return pool[Math.floor(rand() * pool.length)];
  }

  /* 1-based value rank of a row among priced rows (1 = most valuable). */
  function valueRank(row, rows) {
    var p = priceOf(row);
    if (p === null) return null;
    var rank = 1;
    for (var i = 0; i < (rows || []).length; i++) {
      var q = priceOf(rows[i]);
      if (rows[i] !== row && q !== null && q > p) rank++;
    }
    return rank;
  }

  /* YYYY-MM-DD in the visitor's local timezone. Accepts an optional Date
   * (for tests). */
  function todayStr(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /* Best-score persistence; quiet when storage is unavailable. */
  function getBest(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null || raw === "") return fallback;
      var n = Number(raw);
      return isFinite(n) && n >= 0 ? n : fallback;
    } catch { return fallback; }
  }
  function setBest(key, val) {
    try { localStorage.setItem(key, String(val)); } catch { /* private mode */ }
  }

  G.hashStr = hashStr;
  G.mulberry32 = mulberry32;
  G.priceOf = priceOf;
  G.withImage = withImage;
  G.withPrice = withPrice;
  G.dailyIndex = dailyIndex;
  G.pickForDate = pickForDate;
  G.shuffle = shuffle;
  G.pickHigherLowerPair = pickHigherLowerPair;
  G.buildQuizOptions = buildQuizOptions;
  G.pickQuizAnswer = pickQuizAnswer;
  G.valueRank = valueRank;
  G.todayStr = todayStr;
  G.getBest = getBest;
  G.setBest = setBest;
  G.HL_BEST_KEY = "vaultdex:hl:best";
  G.QUIZ_BEST_KEY = "vaultdex:quiz:best";
  G.QUIZ_ROUNDS = 10;
})();
