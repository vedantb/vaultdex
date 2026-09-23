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

  /* Card numbers print as "123/203" (or "TG01/TG30", promo "SV01", …).
   * The fraction form is distinctive enough to accept anywhere on the
   * card (base-era cards print it inside the copyright line); a bare
   * "123" elsewhere (HP, damage, "10 times more") is a much weaker
   * signal and needs positional/context checks. */
  function findNumber(lines) {
    var frac = /(^|[^\d])([A-Za-z]{0,3}\d{1,3})\s*\/\s*[A-Za-z]{0,3}\d{1,3}(?![\d])/;
    var bare = /^([A-Za-z]{0,2}\d{1,3})$/;
    var i, m;
    /* Bottom of the card first: that's where the number lives. */
    var ordered = lines.slice().sort(function (a, b) { return b.y - a.y; });
    for (i = 0; i < ordered.length; i++) {
      m = ordered[i].text.match(frac);
      if (m) return m[2];
    }
    for (i = 0; i < ordered.length; i++) {
      var line = ordered[i];
      /* The printed number sits at the bottom, on its own line. Reject
       * bare numbers from the top half (HP lives there), from multi-word
       * lines ("10 times more" in flavor text, "i 1" OCR junk), and from
       * Pokédex lines ("NO.054", "LV. 12 #25"). */
      if (line.y < 0.5) continue;
      if (/\b(no\.|lv\.|#)/i.test(line.text)) continue;
      var toks = line.text.split(/\s+/).filter(Boolean);
      if (toks.length !== 1) continue;
      var m2 = toks[0].replace(/^[©®*●•]+|[©®*●•.,;:!?]+$/g, "").match(bare);
      /* Skip years and HP values ("HP120"). */
      if (m2 && !/^(19|20)\d{2}$/.test(m2[1]) && !/^hp$/i.test(m2[1])) return m2[1];
    }
    return "";
  }

  var NAME_JUNK = /^(basic|stage|hp|trainer|energy|pok[eé]mon|pokemon)$/i;
  var ILLUS_RE = /\billus\.?/i;

  /* Strip OCR junk from a name-bar line: evolution clauses ("Evolves
   * from X" sits right below the name bar and names the WRONG species),
   * stage/HP labels, HP values and other digit tokens ("w60", "4)"),
   * stray symbols. "Pikachu w60 4)" becomes "Pikachu";
   * "gems Psyduck 70 &" becomes "gems Psyduck". */
  function cleanNameLine(t) {
    return String(t).replace(/\bevolves?\s+from\b.*$/i, "").split(/\s+/).filter(function (w) {
      var alpha = w.replace(/[^A-Za-zéÉ]/g, "");
      if (NAME_JUNK.test(alpha)) return false;
      if (/[0-9]/.test(w) && w.length <= 4) return false;
      if (!/[A-Za-z\u3040-\u30ff\u4e00-\u9faf]/.test(w)) return false;
      return true;
    }).join(" ")
      .replace(/[|_—–\-"'«»“”‘’()[\]{}]+/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  function hasLetterRun(s) {
    return /[A-Za-z]{3,}/.test(s) || /[\u3040-\u30ff\u4e00-\u9faf]/.test(s);
  }

  /* The card name is the name bar: the first readable text at the very
   * top of the card. (The old "longest line in the top half" rule picked
   * the illustrator/flavor/evolution line, usually the longest line on
   * the card, because the y values were never normalized.) */
  function findName(lines) {
    var cands = lines.filter(function (l) {
      return l.y < 0.30 && !ILLUS_RE.test(l.text);
    });
    if (!cands.length) cands = lines;
    cands.sort(function (a, b) { return a.y - b.y; });
    for (var i = 0; i < cands.length; i++) {
      var kept = cleanNameLine(cands[i].text);
      if (kept && hasLetterRun(kept)) return kept;
    }
    return "";
  }

  /* The illustrator credit ("Illus. chibi") is a strong disambiguator
   * when the card number is unreadable. Match the credit marker loosely
   * — Tesseract often mangles it ("Mllus.", "llus."). Only the first
   * token after the marker is kept ("Takeshi" for "Takeshi Nakamura"),
   * which is distinctive enough for scoring. */
  var ILLUS_MARKER = /(?:illus|llus)\.?\s+([A-Za-z][A-Za-z.'-]*)/i;
  function findIllustrator(lines) {
    for (var i = lines.length - 1; i >= 0; i--) {
      var l = lines[i];
      if (l.y < 0.55) continue;
      var m = l.text.match(ILLUS_MARKER);
      if (m && /[A-Za-z]{2,}/.test(m[1])) return m[1];
    }
    return "";
  }

  /* Build a lookup of known illustrator name tokens (lowercase) from the
   * search index. Lets extraction rescue the illustrator credit when
   * Tesseract mangles the "Illus." marker itself ("Hos. chibi").
   * Tokens shorter than 4 chars are ignored — they'd match ordinary
   * words in flavor text. Illustrator VALUES are sanitized first: the
   * catalog has polluted credits (HTML notes, "GAME FREAK inc.",
   * "Basic Grass Energy" on energy cards) whose tokens would otherwise
   * match the copyright/flavor lines of every card. */
  var ILLUS_VALUE_DROP = /(inc\.?|ltd\.?|game\s*freak|creatures|nintendo|pok[eé]mon|art[-\s]?team|company|studio|basic\s+\w+\s+energy)/i;
  var ILLUS_TOKEN_DROP = { game: 1, freak: 1, energy: 1, this: 1, that: 1, with: 1, from: 1,
    your: 1, card: 1, cards: 1, pokemon: 1, illus: 1, illustrator: 1 };
  function cleanIllustratorValue(v) {
    return String(v || "").replace(/<[^>]*>/g, " ").replace(/\([^)]*\)/g, " ")
      .split("|")[0].trim();
  }
  function buildIllustratorTokens(entries) {
    var set = {};
    (entries || []).forEach(function (e) {
      var v = cleanIllustratorValue(e.illustrator);
      if (!v || ILLUS_VALUE_DROP.test(v)) return;
      v.toLowerCase().split(/[^a-z]+/).forEach(function (t) {
        if (t.length >= 4 && !ILLUS_TOKEN_DROP[t]) set[t] = true;
      });
    });
    return set;
  }

  /* Fallback credit search: a known illustrator token in the bottom-half
   * lines, for when the "Illus." marker itself was misread. */
  function findIllustratorToken(lines, illusTokens) {
    if (!illusTokens) return "";
    for (var i = lines.length - 1; i >= 0; i--) {
      if (lines[i].y < 0.55) continue;
      var toks = lines[i].text.toLowerCase().split(/[^a-z]+/);
      for (var t = 0; t < toks.length; t++) {
        if (toks[t].length >= 4 && illusTokens[toks[t]]) return toks[t];
      }
    }
    return "";
  }

  function hasJapanese(s) {
    return /[\u3040-\u30ff\u4e00-\u9faf]/.test(String(s || ""));
  }

  /* ocr: { text, lines: [{ text, bbox: {x0,y0,x1,y1} }] } — lines optional.
   * Returns { name, nameJa, number }: name is the Latin-script name (may be
   * empty on Japanese cards), nameJa the Japanese-script name. */
  function extractCardInfo(ocr, illusTokens) {
    var text = String((ocr && ocr.text) || "");
    var rawLines = ((ocr && ocr.lines) || []).map(function (l) {
      return { text: String((l && l.text) || "").trim(), bbox: (l && l.bbox) || {} };
    }).filter(function (l) { return l.text; });
    /* Tesseract line boxes are in pixels: normalize each line's vertical
     * center by the lowest box bottom so y is a true 0..1 fraction.
     * (The old code compared the raw pixel value against 0.55, so the
     * top-half name filter never fired.) */
    var maxY1 = 0;
    rawLines.forEach(function (l) {
      var y1 = l.bbox.y1;
      if (typeof y1 === "number" && y1 > maxY1) maxY1 = y1;
    });
    var lines = rawLines.map(function (l) {
      var b = l.bbox, y = 0.5;
      if (typeof b.y0 === "number" && typeof b.y1 === "number" && b.y1 > b.y0 && maxY1 > 0) {
        y = ((b.y0 + b.y1) / 2) / maxY1;
      }
      return { text: l.text, y: y };
    });
    if (!lines.length && text) {
      /* No line boxes (or OCR gave plain text): treat each text line as a
       * line with unknown position. */
      lines = text.split(/\n+/).map(function (t) {
        return { text: t.trim(), y: 0.5 };
      }).filter(function (l) { return l.text; });
    }
    var number = findNumber(lines);
    var rawName = findName(lines);
    var illustrator = findIllustrator(lines) || findIllustratorToken(lines, illusTokens);
    /* A name-bar read can mix scripts: kana hallucinations on an English
     * card ("soc Psyduck 上 生"), or Latin fragments on a Japanese one.
     * Keep both parts — the Latin part for EN matching, the Japanese
     * part for JA matching — instead of routing the whole line one way
     * and losing the good half. Tesseract-inserted spaces inside
     * Japanese are artifacts; strip them ("ピカ チュ ウ" → "ピカチュウ"). */
    var name = rawName, nameJa = "";
    if (hasJapanese(rawName)) {
      /* Keep runs that contain Japanese for JA matching — Latin stays
       * attached only when adjoined to Japanese ("リザードンex"), not
       * when space-separated ("soc Psyduck 上 生" → "上生"). The
       * Latin-only part separately feeds EN matching so a kana
       * hallucination can't sink an English read. */
      var runs = rawName.match(/[\u3040-\u30ff\u4e00-\u9fafA-Za-z0-9]+/g) || [];
      nameJa = runs.filter(function (r) {
        return /[\u3040-\u30ff\u4e00-\u9faf]/.test(r);
      }).join("");
      if (nameJa.length < 2) nameJa = ""; /* single-kana noise ("は") is not a name */
      name = cleanNameLine(rawName.replace(/[\u3040-\u30ff\u4e00-\u9faf]+/g, " "));
      if (!hasLetterRun(name)) name = "";
    }
    return {
      name: name,
      nameJa: nameJa,
      number: App.util.normNumber(number),
      illustrator: illustrator
    };
  }

  /* ---------- candidate ranking over the local search index ---------- */

  function tokens(s) {
    return String(s || "").toLowerCase().split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]+/)
      .filter(function (t) { return t.length >= 2; });
  }

  /* Score one index entry against extracted info.
   *
   * An exact name read is the strongest signal: a misread number (very
   * common — HP values, "10 times more" in flavor text) must not bury the
   * correctly-named card. The number still disambiguates between
   * printings once the name matches. Zero means "no evidence" — such
   * entries never rank. */
  function lev(a, b) {
    var m = a.length, n = b.length, i, j, tmp;
    if (!m) return n;
    if (!n) return m;
    var prev = [], cur = [];
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n];
  }

  /* OCR-mangled name token ("Psyduok") vs a catalog name token
   * ("psyduck"): allow a small edit distance so one misread letter
   * doesn't zero the hit. */
  function fuzzyTokenHit(nameTokens, t) {
    if (t.length < 4) return false;
    for (var i = 0; i < nameTokens.length; i++) {
      var w = nameTokens[i];
      if (w.length < 4 || Math.abs(w.length - t.length) > 2) continue;
      if (lev(w, t) <= 2) return true;
    }
    return false;
  }

  /* Score broken into evidence parts so rankCandidates can apply
   * evidence-aware rules (a bare card number alone is never enough —
   * it matches every set's printing of that number). scoreEntry keeps
   * the historical single-number contract. */
  function scoreParts(e, info) {
    var parts = { number: 0, name: 0, ja: 0, illustrator: 0, bonus: 0 };
    var num = App.util.normNumber(info.number || "");
    if (num && App.util.normNumber(e.localId) === num) parts.number = 80;
    var en = String(e.name || "").toLowerCase().trim();
    var qn = String(info.name || "").toLowerCase().trim();
    if (en && qn) {
      if (en === qn) {
        parts.name = 100;
      } else {
        var nameTokens = tokens(en);
        /* The catalog names energy cards "Grass Energy" but the card
         * prints "Basic Grass Energy". Without this, a clean energy
         * read scores only 30, and a mangled one ("Basic.Enerdy")
         * fuzzy-matches every energy type equally. */
        if (/energy$/.test(en) && nameTokens.indexOf("basic") === -1) {
          nameTokens.push("basic");
        }
        var hits = 0, fuzzy = 0;
        tokens(qn).forEach(function (t) {
          /* Short fragments never score. Phone-photo OCR produces
           * garbage like "tt" that used to substring-match any catalog
           * word containing it ("banette", "jett", "floette") and
           * surface completely random cards. A token must be a full
           * word of the catalog name, or within edit distance 2
           * (fuzzyTokenHit already requires length >= 4). */
          if (t.length < 4) return;
          if (nameTokens.indexOf(t) !== -1) hits++;
          else if (fuzzyTokenHit(nameTokens, t)) fuzzy++;
        });
        /* Fuzzy hits are worth less than exact ones: two fuzzy
         * fragments are usually one mangled word ("enerdy", "energ"
         * for "energy"), and must not sum to near-exact strength —
         * cf. the iPhone photo of Basic Grass Energy, whose fragments
         * matched every Basic Energy type at gate-clearing strength. */
        parts.name = hits * 15 + fuzzy * 5;
        /* The containment bonus needs real words on both sides: a
         * single-letter catalog name ("N") is contained in almost any
         * garbage query ("ssn ue i e"). Exact full-name equality above
         * is unaffected. */
        if (qn.length >= 4 && en.length >= 4 &&
            (en.indexOf(qn) !== -1 || qn.indexOf(en) !== -1)) parts.name += 20;
      }
    }
    var ja = String(e.nameJa || "").replace(/\s+/g, "");
    var qj = String(info.nameJa || "").replace(/\s+/g, "");
    if (ja && qj && ja.length > 1 && qj.length > 1) {
      if (ja === qj) parts.ja = 100;
      else if (ja.indexOf(qj) !== -1 || qj.indexOf(ja) !== -1) parts.ja = 50;
    }
    /* The printed illustrator credit disambiguates printings when the
     * card number is unreadable ("Illus. chibi" narrows 145 Pikachus
     * to two). */
    var qi = String(info.illustrator || "").toLowerCase().trim();
    if (qi && e.illustrator &&
        String(e.illustrator).toLowerCase().indexOf(qi) !== -1) parts.illustrator = 40;
    /* Language alignment: a Latin-script read is an English card and
     * vice versa. JA index entries carry English names, so without this
     * a Japanese printing can outrank the English one on ties (or on a
     * stray number hit) and the English printing vanishes from the
     * candidate list entirely. The bonus only applies on top of other
     * evidence — never on its own. */
    if (parts.number + parts.name + parts.ja + parts.illustrator > 0) {
      if (e.lang === "en" && parts.name > 0) parts.bonus = 10;
      else if (e.lang === "ja" && parts.ja > 0) parts.bonus = 10;
    }
    return parts;
  }

  function scoreEntry(e, info) {
    var p = scoreParts(e, info);
    return p.number + p.name + p.ja + p.illustrator + p.bonus;
  }

  /* setRank (optional): App.tcg.getSetRank() map, newest set first.
   * Breaks score ties toward recent printings — the card in hand is
   * usually a recent one when the OCR number is missing. */
  function setRankOf(e, setRank) {
    if (!setRank) return 0;
    var id = String(e.id || "");
    var prefix = id.slice(0, Math.max(0, id.lastIndexOf("-")));
    var r = setRank[(e.lang === "ja" ? "ja-" : "") + prefix];
    return (typeof r === "number") ? r : 9999;
  }

  /* Minimum score for a candidate to be shown. Below this, the read
   * is too weak to be useful — the view renders its honest "couldn't
   * read it" state instead of a list of random cards. 40 is the weakest
   * legitimate standalone signal (an illustrator-credit match); a lone
   * short name fragment or stray token can never clear it, and a bare
   * card number alone is withheld by the rule below regardless of its
   * 80-point score. */
  var MIN_SCORE = 40;

  function rankCandidates(entries, info, limit, setRank, minScore, opts) {
    limit = limit || 8;
    if (typeof minScore !== "number") minScore = MIN_SCORE;
    /* Manual search explicitly asks for a number; the number-only
     * withhold below is about weak OCR evidence, not deliberate
     * queries. */
    var allowNumberOnly = !!(opts && opts.allowNumberOnly);
    var scored = [];
    (entries || []).forEach(function (e) {
      var p = scoreParts(e, info || {});
      var s = p.number + p.name + p.ja + p.illustrator + p.bonus;
      if (s <= 0 || s < minScore) return;
      /* A bare card number matches every set's printing of that number
       * ("005" hits 150+ cards), so a number-only read can only ever
       * surface a random cross-set list. Withhold it unless other
       * evidence — name, Japanese name, or illustrator — backs it up;
       * the honest "couldn't read it" state beats random cards, and
       * manual search is one tap away. Cf. the iPhone photo of N's
       * Zekrom, whose misread "5" surfaced twelve unrelated #005s. */
      if (!allowNumberOnly && p.number > 0 && p.name === 0 && p.ja === 0 && p.illustrator === 0) return;
      scored.push({ entry: e, score: s });
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var ra = setRankOf(a.entry, setRank), rb = setRankOf(b.entry, setRank);
      if (ra !== rb) return ra - rb;
      return String(a.entry.name || "").localeCompare(String(b.entry.name || ""));
    });
    return scored.slice(0, limit).map(function (x) { return x.entry; });
  }

  /* Manual-fallback search: turn a typed query into info (digits become a
   * number guess) and rank the same way. */
  function searchIndexQuery(entries, query, limit, setRank) {
    var q = String(query || "").trim();
    var num = "";
    var m = q.match(/(\d{1,3})\s*\/\s*\d{1,3}/) || q.match(/\b(\d{1,3})\b/);
    if (m) num = m[1];
    var info = {
      name: hasJapanese(q) ? "" : q.replace(/[0-9/]/g, " ").trim(),
      nameJa: hasJapanese(q) ? q : "",
      number: App.util.normNumber(num)
    };
    /* A typed number is a deliberate query, not weak OCR evidence —
     * don't apply the number-only withhold here. */
    return rankCandidates(entries, info, limit, setRank, undefined, { allowNumberOnly: true });
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
    buildIllustratorTokens: buildIllustratorTokens,
    scoreEntry: scoreEntry,
    rankCandidates: rankCandidates,
    MIN_SCORE: MIN_SCORE,
    searchIndexQuery: searchIndexQuery,
    loadOcr: loadOcr,
    recognize: recognize
  };
})();
