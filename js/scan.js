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

  /* A first-pass read at or above this score is trusted outright and
   * skips the second (bottom-strip) OCR pass. An exact name read scores
   * 100+, so in practice the strip pass only runs when the name bar
   * didn't read cleanly. */
  var HIGH_CONFIDENCE = 90;

  /* Shared scored loop behind rankCandidates and topScore: same gate,
   * same number-only withhold, so both always agree on what counts. */
  /* Bonus for entries in the set read from the bottom strip. The strip
   * code is strong evidence of the SET even when the number didn't
   * survive ("MEE" without "001"), so printings from that set get a
   * lift. Deliberately gated on non-number evidence: a bare misread
   * number must never surface a wrong card just because the set
   * matched (cf. the number-only withhold below). */
  var SET_BOOST = 30;

  function scoredEntries(entries, info, minScore, opts) {
    var allowNumberOnly = !!(opts && opts.allowNumberOnly);
    var boostSet = (opts && opts.setId) || "";
    var out = [];
    (entries || []).forEach(function (e) {
      var p = scoreParts(e, info || {});
      var s = p.number + p.name + p.ja + p.illustrator + p.bonus;
      if (boostSet && (p.name > 0 || p.ja > 0 || p.illustrator > 0)) {
        var id = String(e.id || "");
        var prefix = id.slice(0, Math.max(0, id.lastIndexOf("-"))).toLowerCase();
        if (prefix === boostSet || prefix === boostSet + "tg") s += SET_BOOST;
      }
      if (s <= 0 || s < minScore) return;
      /* A bare card number matches every set's printing of that number
       * ("005" hits 150+ cards), so a number-only read can only ever
       * surface a random cross-set list. Withhold it unless other
       * evidence — name, Japanese name, or illustrator — backs it up;
       * the honest "couldn't read it" state beats random cards, and
       * manual search is one tap away. Cf. the iPhone photo of N's
       * Zekrom, whose misread "5" surfaced twelve unrelated #005s. */
      if (!allowNumberOnly && p.number > 0 && p.name === 0 && p.ja === 0 && p.illustrator === 0) return;
      out.push({ entry: e, score: s });
    });
    return out;
  }

  function rankCandidates(entries, info, limit, setRank, minScore, opts) {
    limit = limit || 8;
    if (typeof minScore !== "number") minScore = MIN_SCORE;
    var scored = scoredEntries(entries, info, minScore, opts);
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var ra = setRankOf(a.entry, setRank), rb = setRankOf(b.entry, setRank);
      if (ra !== rb) return ra - rb;
      return String(a.entry.name || "").localeCompare(String(b.entry.name || ""));
    });
    return scored.slice(0, limit).map(function (x) { return x.entry; });
  }

  /* Best production score for this read (same gate + evidence rules as
   * rankCandidates). The view uses it to decide whether the first pass
   * is already confident enough to skip the bottom-strip OCR pass. */
  function topScore(entries, info, opts) {
    var scored = scoredEntries(entries, info, MIN_SCORE, opts);
    var best = 0;
    for (var i = 0; i < scored.length; i++) {
      if (scored[i].score > best) best = scored[i].score;
    }
    return best;
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

  /* ---------- printed set code + card number (bottom-strip pass) ---------- */

  /* Official printed abbreviations for modern sets, code -> catalog id.
   * The code on the card isn't always the TCGdex id ("ASC" on the card,
   * "me02.5" in the catalog). Anything not listed here falls back to a
   * case-insensitive code == id match ("MEP" -> "mep", "30TH" -> "30th"). */
  var SET_CODE_MAP = {
    /* Mega Evolution era */
    MEE: "mee", MEP: "mep", ASC: "me02.5",
    /* Scarlet & Violet era */
    SVI: "sv01", PAL: "sv02", OBF: "sv03", MEW: "sv03.5", PAR: "sv04",
    PAF: "sv04.5", TEF: "sv05", TWM: "sv06", SFA: "sv06.5", SCR: "sv07",
    SSP: "sv08", PRE: "sv08.5", JTG: "sv09", DRI: "sv10",
    BLK: "sv10.5b", WHT: "sv10.5w", SVP: "svp", SVE: "sve",
    /* Sword & Shield era */
    SSH: "swsh1", RCL: "swsh2", DAA: "swsh3", CPA: "swsh3.5",
    VIV: "swsh4", SHF: "swsh4.5", BST: "swsh5", CRE: "swsh6",
    EVS: "swsh7", CEL: "cel25", FST: "swsh8", BRS: "swsh9",
    ASR: "swsh10", PGO: "swsh10.5", LOR: "swsh11", SIT: "swsh12",
    CRZ: "swsh12.5", SWSH: "swshp"
  };

  function setIdForCode(code) {
    var c = String(code || "").toUpperCase().trim();
    if (!c) return "";
    return SET_CODE_MAP[c] || c.toLowerCase();
  }

  /* The bottom copyright line prints e.g. "MEE EN 001", "ASC EN 159/217".
   * Strict form (with the EN/JA marker) is preferred and scanned
   * bottom-up; the loose form covers strips where OCR dropped the marker.
   * The number allows a letter prefix ("TG01/TG30" trainer-gallery
   * cards). Pure: OCR text in, { code, number, lang } out (number is
   * normNumber-normalized), or null when nothing code-like is found. */
  var SETCODE_STRICT = /([A-Z0-9]{2,5})\s*(EN|JA)\s*([A-Z]{0,2}0*\d{1,3})(?![\dA-Z])/;
  var SETCODE_LOOSE = /([A-Z0-9]{2,5})\s+([A-Z]{0,2}0*\d{1,3})(?![\dA-Z])/;
  var SETCODE_MARKER = /([A-Z0-9]{2,5})\s*(EN|JA)(?![\dA-Z])/;
  /* Bare-code tokens: the strip often reads the 3-letter code while
   * mangling the marker/number ("MEE is a p", "MEP ep + a"). Only accept
   * standalone tokens from the curated code map — never bare English
   * words like SIT or PAL, which show up in flavor text. */
  var BARECODE_DENY = { SIT: 1, PAL: 1 };
  /* The copyright line ("©2026 Pokémon / Nintendo / Creatures / GAME
   * FREAK") lives right next to the set code and its mangled tokens
   * ("BRS Poksmon", "KSMON 1") are the main source of false codes. The
   * bare-token and loose patterns skip it; strict and marker-only keep
   * scanning it because the EN/JA marker is distinctive enough. */
  var COPYRIGHT_LINE = /POK[ÉE]MON|NINTENDO|CREATURES|FREAK/;

  function extractSetCode(text) {
    var lines = String(text || "").toUpperCase().split(/\n+/);
    var marker = null;
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i];
      /* Strict (code + EN/JA + number) is near-certain: return at once. */
      var m = SETCODE_STRICT.exec(line);
      if (m) {
        return {
          code: m[1],
          number: App.util.normNumber(m[3]),
          lang: m[2] === "JA" ? "ja" : "en"
        };
      }
      if (!marker) {
        var m3 = SETCODE_MARKER.exec(line);
        if (m3) marker = { code: m3[1], number: "", lang: m3[2] === "JA" ? "ja" : "en" };
      }
    }
    if (marker) return marker;
    /* Bare known-code token ("MEE is a p"): the strip often reads the
     * code while mangling the marker and number. Standalone tokens from
     * the curated map only — never bare English words like SIT or PAL,
     * which show up in flavor text. */
    for (var j = lines.length - 1; j >= 0; j--) {
      if (COPYRIGHT_LINE.test(lines[j])) continue;
      var toks = lines[j].split(/[^A-Z0-9]+/);
      for (var k = toks.length - 1; k >= 0; k--) {
        var t = toks[k];
        if (t.length >= 3 && SET_CODE_MAP[t] && !BARECODE_DENY[t]) {
          return { code: t, number: "", lang: null };
        }
      }
    }
    /* Loose (code + number, no marker) is the last resort: a bare
     * "CODE NUMBER" also matches mangled copyright lines. */
    for (var l = lines.length - 1; l >= 0; l--) {
      if (COPYRIGHT_LINE.test(lines[l])) continue;
      var m2 = SETCODE_LOOSE.exec(lines[l]);
      if (m2) return { code: m2[1], number: App.util.normNumber(m2[2]), lang: null };
    }
    return null;
  }

  /* Resolve a printed set code + card number to exactly one index entry.
   * Only succeeds on an exact set+number hit — an unmapped code, or a
   * number the set doesn't carry, resolves to null (never a guess).
   * `lang` ("en"/"ja"/null) comes from the printed EN/JA marker when the
   * strip read included one. */
  function resolvePrintedCode(entries, code, number, lang) {
    var setId = setIdForCode(code);
    var num = App.util.normNumber(number);
    if (!setId || !num) return null;
    var hits = (entries || []).filter(function (e) {
      if (lang === "en" && e.lang !== "en") return false;
      if (lang === "ja" && e.lang !== "ja") return false;
      var id = String(e.id || "");
      var prefix = id.slice(0, Math.max(0, id.lastIndexOf("-"))).toLowerCase();
      /* Trainer-gallery printings share the main set's printed code
       * ("BRS" on a "TG01/TG30" card lives in swsh9tg, not swsh9). */
      if (prefix !== setId && prefix !== setId + "tg") return false;
      return App.util.normNumber(e.localId) === num;
    });
    return hits.length === 1 ? hits[0] : null;
  }

  /* True when the index has at least one entry from this set — guards
   * the code-only path against a misread code boosting a phantom set. */
  function hasSetEntries(entries, setId) {
    if (!setId) return false;
    return (entries || []).some(function (e) {
      var id = String(e.id || "");
      var prefix = id.slice(0, Math.max(0, id.lastIndexOf("-"))).toLowerCase();
      return prefix === setId || prefix === setId + "tg";
    });
  }

  /* Pure hue classifier for basic Energy cards. The strip tells us the
   * set ("MEE") and the name tells us it's an energy, but nothing in the
   * OCR text says which type — the big colored orb does. r/g/b are 0-1.
   * Returns "grass" | "fire" | "water" | "lightning" | "psychic" |
   * "fighting" | "darkness" | "metal" | null when unsure. Conservative:
   * low-saturation or out-of-range colors return null rather than guess. */
  function energyTypeByHue(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var sat = mx === 0 ? 0 : (mx - mn) / mx, val = mx;
    if (val < 0.22) return "darkness";
    if (sat < 0.18) return "metal";
    if (sat < 0.25) return null;
    var d = mx - mn;
    if (d === 0) return null;
    var h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    if (h < 18 || h >= 340) return "fire";
    if (h < 45) return "fighting";
    if (h < 72) return "lightning";
    if (h < 155) return "grass";
    if (h < 255) return "water";
    if (h < 300) return "psychic";
    return "fairy";
  }

  /* Sample the center of the captured frame (where an energy orb sits)
   * and classify its color. Never rejects — resolves null on any
   * failure or ambiguity, so the caller can fall back silently. */
  function detectEnergyType(dataUrl) {
    return new Promise(function (resolve) {
      try {
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) return resolve(null);
            var cw = w * 0.3, ch = h * 0.3;
            var c = document.createElement("canvas");
            c.width = 32; c.height = 32;
            var ctx = c.getContext("2d");
            ctx.drawImage(img, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, 32, 32);
            var d = ctx.getImageData(0, 0, 32, 32).data;
            var n = 0, rs = 0, gs = 0, bs = 0;
            for (var i = 0; i < d.length; i += 4) {
              var r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
              var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
              var sat = mx === 0 ? 0 : (mx - mn) / mx;
              if (sat < 0.15 || mx > 0.95) continue; /* glare / background */
              rs += r; gs += g; bs += b; n++;
            }
            if (!n) return resolve(null);
            resolve(energyTypeByHue(rs / n, gs / n, bs / n));
          } catch { resolve(null); }
        };
        img.onerror = function () { resolve(null); };
        img.src = dataUrl;
      } catch { resolve(null); }
    });
  }

  /* Within one set, pick the single energy card matching a detected
   * type ("grass" hits "Grass Energy" / "Basic Grass Energy"). Returns
   * null unless exactly one card matches — ambiguity is not resolved
   * by guessing. */
  function resolveEnergyType(entries, setId, type) {
    if (!setId || !type) return null;
    var hits = (entries || []).filter(function (e) {
      var id = String(e.id || "");
      var prefix = id.slice(0, Math.max(0, id.lastIndexOf("-"))).toLowerCase();
      if (prefix !== setId) return false;
      return String(e.name || "").toLowerCase().indexOf(type) !== -1;
    });
    return hits.length === 1 ? hits[0] : null;
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
  async function recognize(image, onProgress, langs) {
    var T = await loadOcr();
    var res = await T.recognize(image, langs || "eng+jpn", {
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

  /* Crop the bottom strip of the captured frame — where the set code +
   * card number print — and upscale 3x for a dedicated OCR pass. The
   * full-card pass can't read that tiny line; a second pass on just the
   * strip can. The strip is a generous bottom quarter because phone
   * photos are often tilted: the card's bottom-left corner (where the
   * code prints) can sit well above the frame's bottom edge. */
  function bottomStripDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      try {
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) throw new Error("strip crop: empty image");
            var stripH = Math.max(1, Math.round(h * 0.25));
            var k = 3;
            var c = document.createElement("canvas");
            c.width = Math.round(w * k);
            c.height = Math.round(stripH * k);
            c.getContext("2d").drawImage(img, 0, h - stripH, w, stripH, 0, 0, c.width, c.height);
            resolve(c.toDataURL("image/jpeg", 0.9));
          } catch (e) { reject(e); }
        };
        img.onerror = function () { reject(new Error("strip crop: image failed to load")); };
        img.src = dataUrl;
      } catch (e) { reject(e); }
    });
  }

  /* Second OCR pass: read the printed set code + card number from the
   * bottom strip. English-only: the strip line is Latin ("MEE EN 001"),
   * and eng+jpn hallucinates kana on tiny text. Returns { code, number,
   * lang } or null. Rejects when the strip can't be cropped or OCR'd —
   * the caller falls back to the first pass silently. The Tesseract
   * engine is already loaded by the first pass, so this is just one
   * more recognition job. */
  async function recognizeSetCode(image, onProgress) {
    var strip = await bottomStripDataUrl(image);
    var ocr = await recognize(strip, onProgress, "eng");
    return extractSetCode(ocr.text);
  }

  App.scan = {
    scanCapable: scanCapable,
    extractCardInfo: extractCardInfo,
    buildIllustratorTokens: buildIllustratorTokens,
    scoreEntry: scoreEntry,
    rankCandidates: rankCandidates,
    topScore: topScore,
    MIN_SCORE: MIN_SCORE,
    HIGH_CONFIDENCE: HIGH_CONFIDENCE,
    extractSetCode: extractSetCode,
    resolvePrintedCode: resolvePrintedCode,
    setIdForCode: setIdForCode,
    hasSetEntries: hasSetEntries,
    energyTypeByHue: energyTypeByHue,
    detectEnergyType: detectEnergyType,
    resolveEnergyType: resolveEnergyType,
    SET_BOOST: SET_BOOST,
    searchIndexQuery: searchIndexQuery,
    loadOcr: loadOcr,
    recognize: recognize,
    recognizeSetCode: recognizeSetCode
  };
})();
