/* VaultDex — card scanner core: OCR plumbing + pure text-to-catalog matching.
 *
 * The recognition pipeline is:
 *   capture -> Tesseract OCR (eng+jpn, lazy-loaded on first scan) ->
 *   extractCardInfo (card name + number from OCR text/line boxes) ->
 *   rankCandidates (local EN + JA search index, incl. nameJa) ->
 *   user picks a candidate -> confirm sheet.
 * The scanner NEVER auto-adds: every add goes through the confirm sheet.
 *
 * Pure functions (extractCardInfo, rankCandidates, searchIndexQuery) are
 * exported for unit tests and take plain data — no DOM, no network.
 */
(function () {
  window.App = window.App || {};

  /* ---------- capability: is this a phone-class device? ---------- */
  /* The scanner is mobile-only by design: coarse pointer (touch) plus a
   * phone-class viewport. Desktop viewports get no scan entry point and
   * the /scan route renders a "use your phone" note instead. */
  function scanCapable() {
    try {
      var coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
      var touch = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
      var small = window.innerWidth < 820;
      return (coarse || touch) && small;
    } catch {
      return false;
    }
  }

  /* ---------- OCR text -> { name, nameJa, number } ---------- */

  /* Card numbers print as "123/456" (or "TG01/TG30", "SV01" promos, …).
   * Try the fraction form first — a bare "123" elsewhere on the card
   * (HP, damage numbers) is a much weaker signal. */
  function findNumber(lines) {
    var frac = /([A-Za-z]{0,3}\d{1,3})\s*\/\s*[A-Za-z]{0,3}\d{1,3}/;
    var bare = /^([A-Za-z]{0,2}\d{1,3})$/;
    var i, m, line;
    /* Bottom third of the card first: that's where the number lives. */
    var ordered = lines.slice().sort(function (a, b) { return b.y - a.y; });
    for (i = 0; i < ordered.length; i++) {
      line = ordered[i];
      m = line.text.match(frac);
      if (m) return m[1];
    }
    for (i = 0; i < ordered.length; i++) {
      line = ordered[i];
      var toks = line.text.split(/\s+/);
      for (var t = 0; t < toks.length; t++) {
        m = toks[t].match(bare);
        /* Skip HP values ("HP120") and years. */
        if (m && !/^(19|20)\d{2}$/.test(m[1])) return m[1];
      }
    }
    return "";
  }

  var NAME_JUNK = /^(basic|stage|hp|trainer|energy|pok[eé]mon|pokemon)$/i;

  /* The card name is the biggest text at the top of the card. With line
   * boxes we take the longest alphabetic line in the top half; without
   * boxes we fall back to the longest plausible line of the raw text. */
  function findName(lines) {
    var cands = lines.filter(function (l) { return l.y < 0.55; });
    if (!cands.length) cands = lines;
    var best = "", bestLen = 0;
    cands.forEach(function (l) {
      var t = l.text.replace(/[|_—–-]{2,}/g, " ").trim();
      /* Strip junk tokens ("BASIC", "HP 120", "STAGE 1") but keep the rest:
       * "Pikachu ex" must survive intact. */
      var kept = t.split(/\s+/).filter(function (w) {
        return !NAME_JUNK.test(w.replace(/[^A-Za-zéÉ]/g, ""));
      }).join(" ").trim();
      if (!kept) return;
      if (!/[A-Za-z\u3040-\u30ff\u4e00-\u9faf]/.test(kept)) return;
      if (kept.length > bestLen) { bestLen = kept.length; best = kept; }
    });
    return best;
  }

  function hasJapanese(s) {
    return /[\u3040-\u30ff\u4e00-\u9faf]/.test(String(s || ""));
  }

  /* ocr: { text, lines: [{ text, bbox: {x0,y0,x1,y1} }] } — lines optional.
   * Returns { name, nameJa, number }: name is the Latin-script name (may be
   * empty on Japanese cards), nameJa the Japanese-script name. */
  function extractCardInfo(ocr) {
    var text = String((ocr && ocr.text) || "");
    var rawLines = ((ocr && ocr.lines) || []).map(function (l) {
      var b = (l && l.bbox) || {};
      var t = String((l && l.text) || "").trim();
      /* y = vertical center as a 0..1 fraction (bbox may be in pixels). */
      var y = 0.5;
      if (typeof b.y0 === "number" && typeof b.y1 === "number" && b.y1 > b.y0) {
        y = (b.y0 + b.y1) / 2;
      }
      return { text: t, y: y };
    }).filter(function (l) { return l.text; });
    var lines = rawLines;
    if (!lines.length && text) {
      /* No line boxes (or OCR gave plain text): treat each text line as a
       * line with unknown position. */
      lines = text.split(/\n+/).map(function (t) {
        return { text: t.trim(), y: 0.5 };
      }).filter(function (l) { return l.text; });
    }
    var number = findNumber(lines);
    var name = findName(lines);
    return {
      name: hasJapanese(name) ? "" : name,
      nameJa: hasJapanese(name) ? name : "",
      number: App.util.normNumber(number)
    };
  }

  /* ---------- candidate ranking over the local search index ---------- */

  function tokens(s) {
    return String(s || "").toLowerCase().split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]+/)
      .filter(function (t) { return t.length >= 2; });
  }

  /* Score one index entry against extracted info. Number-exact is the
   * strongest signal (+100); name token overlap and nameJa inclusion
   * follow. Zero means "no evidence" — such entries never rank. */
  function scoreEntry(e, info) {
    var s = 0;
    var num = App.util.normNumber(info.number || "");
    if (num && App.util.normNumber(e.localId) === num) s += 100;
    var en = String(e.name || "").toLowerCase().trim();
    var qn = String(info.name || "").toLowerCase().trim();
    if (en && qn) {
      if (en === qn) {
        s += 60;
      } else {
        var hits = 0;
        tokens(qn).forEach(function (t) { if (en.indexOf(t) !== -1) hits++; });
        s += hits * 15;
        if (en.indexOf(qn) !== -1 || qn.indexOf(en) !== -1) s += 20;
      }
    }
    var ja = String(e.nameJa || "").trim();
    var qj = String(info.nameJa || "").trim();
    if (ja && qj && ja.length > 1 && qj.length > 1) {
      if (ja.indexOf(qj) !== -1 || qj.indexOf(ja) !== -1) s += 50;
    }
    return s;
  }

  function rankCandidates(entries, info, limit) {
    limit = limit || 8;
    var scored = [];
    (entries || []).forEach(function (e) {
      var s = scoreEntry(e, info || {});
      if (s > 0) scored.push({ entry: e, score: s });
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.entry.name || "").localeCompare(String(b.entry.name || ""));
    });
    return scored.slice(0, limit).map(function (x) { return x.entry; });
  }

  /* Manual-fallback search: turn a typed query into info (digits become a
   * number guess) and rank the same way. */
  function searchIndexQuery(entries, query, limit) {
    var q = String(query || "").trim();
    var num = "";
    var m = q.match(/(\d{1,3})\s*\/\s*\d{1,3}/) || q.match(/\b(\d{1,3})\b/);
    if (m) num = m[1];
    var info = {
      name: hasJapanese(q) ? "" : q.replace(/[0-9/]/g, " ").trim(),
      nameJa: hasJapanese(q) ? q : "",
      number: App.util.normNumber(num)
    };
    return rankCandidates(entries, info, limit);
  }

  /* ---------- OCR engine (lazy) ---------- */

  var TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
  var tessPromise = null;

  /* Loads Tesseract.js from CDN on first use and caches the promise.
   * Rejects (rather than hanging) when the CDN is unreachable — the
   * view falls back to manual search. */
  function loadOcr() {
    if (tessPromise) return tessPromise;
    tessPromise = new Promise(function (resolve, reject) {
      var settled = false;
      function done(fn, v) {
        if (settled) return;
        settled = true;
        fn(v);
      }
      try {
        if (window.Tesseract) return done(resolve, window.Tesseract);
        var s = document.createElement("script");
        s.src = TESS_URL;
        s.async = true;
        s.onload = function () {
          if (window.Tesseract) done(resolve, window.Tesseract);
          else done(reject, new Error("OCR engine failed to initialize."));
        };
        s.onerror = function () { done(reject, new Error("Could not load the OCR engine (network).")); };
        document.head.appendChild(s);
        /* eng+jpn trained data is several MB; give it a minute, then
         * give up cleanly instead of hanging the scanner. */
        setTimeout(function () { done(reject, new Error("OCR engine timed out loading.")); }, 90000);
      } catch (e) {
        done(reject, e);
      }
    });
    /* A failed load must not poison later attempts. */
    tessPromise.catch(function () { tessPromise = null; });
    return tessPromise;
  }

  /* Run OCR over an image (data URL). onProgress(0..1) is best-effort.
   * Returns { text, lines } with Tesseract line boxes. */
  async function recognize(image, onProgress) {
    var T = await loadOcr();
    var res = await T.recognize(image, "eng+jpn", {
      logger: function (m) {
        if (onProgress && m && m.status === "recognizing text" && typeof m.progress === "number") {
          try { onProgress(m.progress); } catch { /* progress is advisory */ }
        }
      }
    });
    var data = (res && res.data) || {};
    return {
      text: data.text || "",
      lines: (data.lines || []).map(function (l) {
        return { text: l.text, bbox: l.bbox };
      })
    };
  }

  App.scan = {
    scanCapable: scanCapable,
    extractCardInfo: extractCardInfo,
    scoreEntry: scoreEntry,
    rankCandidates: rankCandidates,
    searchIndexQuery: searchIndexQuery,
    loadOcr: loadOcr,
    recognize: recognize
  };
})();
