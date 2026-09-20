/* VaultDex — Binder Studio idea generator.
 *
 * Pure-ish logic for composing 9-pocket binder page ideas from 1-3 anchor
 * cards. Data comes in through `ctx` so the algorithms are unit-testable
 * with stub data; the view (js/views/binder-view.js) wires the real
 * providers (catalog, collection, palettes, PokéAPI).
 *
 * A page is 9 slots (row-major positions 0-8). Slot kinds:
 *   card   — a TCG card: {kind, key, name, image, reason, owned, anchor}
 *   insert — Michi-method art spanning 1-3 pockets:
 *            {kind, insert:{kind:'art'|'terrain',...}, span, positions, reason}
 *   blank  — intentional negative space: {kind:'blank', reason}
 */
(function () {
  window.App = window.App || {};
  var B = App.binder = {};

  /* ================= color utils ================= */

  function hueDist(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }
  B.hueDist = hueDist;

  /* Coarse hue families for labels and gradient bucketing. */
  B.hueFamily = function (h) {
    h = ((h % 360) + 360) % 360;
    if (h < 12 || h >= 345) return "red";
    if (h < 38) return "orange";
    if (h < 70) return "yellow";
    if (h < 160) return "green";
    if (h < 195) return "teal";
    if (h < 255) return "blue";
    if (h < 295) return "purple";
    return "pink";
  };

  /* Dominant entry of a palette: [h,s,l,w]. */
  function dominant(pal) {
    if (!pal || !pal.length) return null;
    var best = pal[0];
    for (var i = 1; i < pal.length; i++) {
      if (pal[i][3] > best[3]) best = pal[i];
    }
    return best;
  }
  B.dominant = dominant;

  function paletteStats(pal) {
    var s = 0, l = 0, w = 0;
    (pal || []).forEach(function (e) {
      s += e[1] * e[3]; l += e[2] * e[3]; w += e[3];
    });
    if (!w) return { s: 0, l: 50 };
    return { s: s / w, l: l / w };
  }

  /* vibe = {hue: 0-360|null, mood: 'vibrant'|'muted'|'dark'|'pastel'|null}.
   * Returns 0..1. */
  B.vibeScore = function (pal, vibe) {
    if (!pal || !pal.length) return 0;
    vibe = vibe || {};
    var hueScore = 0.5, moodScore = 0.5;
    if (vibe.hue !== null && vibe.hue !== undefined) {
      var best = 0;
      pal.forEach(function (e) {
        var m = (1 - hueDist(e[0], vibe.hue) / 180) * (0.4 + 0.6 * (e[3] / 100));
        if (m > best) best = m;
      });
      hueScore = best;
    }
    if (vibe.mood) {
      var st = paletteStats(pal);
      var match = 0.25;
      if (vibe.mood === "vibrant") match = st.s >= 55 ? 1 : st.s / 55 * 0.8;
      else if (vibe.mood === "muted") match = st.s <= 35 ? 1 : Math.max(0.15, 1 - (st.s - 35) / 60);
      else if (vibe.mood === "dark") match = st.l <= 38 ? 1 : Math.max(0.15, 1 - (st.l - 38) / 50);
      else if (vibe.mood === "pastel") match = (st.l >= 68 && st.s <= 55) ? 1 : 0.25;
      moodScore = match;
    }
    if (vibe.mood && (vibe.hue === null || vibe.hue === undefined)) return moodScore;
    if (!vibe.mood) return hueScore;
    return hueScore * 0.65 + moodScore * 0.35;
  };

  /* Weighted palette-to-palette distance, 0 (identical) .. ~1. */
  B.paletteDistance = function (pa, pb) {
    if (!pa || !pa.length || !pb || !pb.length) return 1;
    var total = 0, wsum = 0;
    pa.forEach(function (a) {
      var best = Infinity;
      pb.forEach(function (b) {
        var d = hueDist(a[0], b[0]) / 180 * 0.6 +
          Math.abs(a[1] - b[1]) / 100 * 0.2 +
          Math.abs(a[2] - b[2]) / 100 * 0.2;
        // Weight by the other palette's entry weight too.
        d = d * (0.5 + 0.5 * (b[3] / 100));
        if (d < best) best = d;
      });
      total += best * (a[3] / 100);
      wsum += a[3] / 100;
    });
    return wsum ? total / wsum : 1;
  };

  /* Circular mean hue of several palettes (for "from my anchors"). */
  B.meanHue = function (pals) {
    var x = 0, y = 0, w = 0;
    (pals || []).forEach(function (pal) {
      var d = dominant(pal);
      if (!d) return;
      var rad = d[0] * Math.PI / 180, wt = d[3] / 100;
      x += Math.cos(rad) * wt; y += Math.sin(rad) * wt; w += wt;
    });
    if (!w) return null;
    var h = Math.atan2(y, x) * 180 / Math.PI;
    return Math.round(((h % 360) + 360) % 360);
  };

  /* ================= rarity scoring ================= */

  var RARITY_W = {
    "special illustration rare": 100, "illustration rare": 92,
    "hyper rare": 88, "secret rare": 84, "ultra rare": 78,
    "double rare": 72, "shiny ultra rare": 70, "shiny rare": 62,
    "promo": 58, "rare": 46, "holo rare": 42,
    "uncommon": 22, "common": 12
  };
  B.rarityWeight = function (rarity) {
    if (!rarity) return 15;
    var w = RARITY_W[String(rarity).toLowerCase()];
    return w === undefined ? 30 : w;
  };

  /* ================= recipes & layouts ================= */

  B.RECIPES = {
    evolution: { title: "Evolution line", blurb: "The full family, stage by stage." },
    artist: { title: "Artist spotlight", blurb: "One illustrator, many Pokémon." },
    species: { title: "Species shrine", blurb: "Nine arts of one Pokémon." },
    color: { title: "Color story", blurb: "Cards that share your palette." },
    gradient: { title: "Gradient", blurb: "Hues melting across the page." },
    set: { title: "Set showcase", blurb: "The chase cards of one set." }
  };
  B.LAYOUTS = {
    classic: { title: "Classic 9", blurb: "Nine cards, wall to wall." },
    panorama: { title: "Panorama", blurb: "Cards over a 3-pocket art span." },
    gallery: { title: "Gallery wall", blurb: "Few heroes, lots of air." }
  };

  /* ================= candidate pools ================= */

  /* Resolve catalog details for keys, grouped by set to bound fetches.
   * Returns Map key -> card (normCard-like). */
  async function resolveDetails(keys, ctx, maxSets) {
    maxSets = maxSets || 12;
    var bySet = {}, order = [];
    keys.forEach(function (k) {
      var p = ctx.parseKey(k); // {lang, id, appSetId}
      if (!p) return;
      if (!bySet[p.appSetId]) { bySet[p.appSetId] = []; order.push(p.appSetId); }
      bySet[p.appSetId].push(k);
    });
    var out = {};
    var sets = order.slice(0, maxSets);
    for (var i = 0; i < sets.length; i++) {
      var list;
      try { list = await ctx.getSetCards(sets[i]); } catch { continue; }
      (list || []).forEach(function (c) {
        var k = ctx.keyOf(c);
        if (bySet[sets[i]].indexOf(k) >= 0) out[k] = c;
      });
    }
    return out;
  }
  B.resolveDetails = resolveDetails;

  function ownedBoost(key, ctx, amount) {
    return ctx.ownedKeys && ctx.ownedKeys.has(key) ? (amount || 25) : 0;
  }

  /* Newest-first sampling of keys using ctx.setRank (appSetId -> rank). */
  function newestFirst(keys, ctx, cap) {
    var rank = ctx.setRank || {};
    return keys.slice().sort(function (a, b) {
      var ra = rank[ctx.parseKey(a).appSetId], rb = rank[ctx.parseKey(b).appSetId];
      ra = ra === undefined ? 1e9 : ra; rb = rb === undefined ? 1e9 : rb;
      return ra - rb;
    }).slice(0, cap);
  }

  /* Each pool fn: async (anchors, opts, ctx) -> [{key, score, reason}]. */
  var pools = {};

  pools.evolution = async function (anchors, opts, ctx) {
    var slugs = [];
    for (var i = 0; i < anchors.length; i++) {
      var chain;
      try { chain = await ctx.evoChain(anchors[i].speciesSlug); } catch { chain = null; }
      (chain || [anchors[i].speciesSlug]).forEach(function (s) {
        if (s && slugs.indexOf(s) < 0) slugs.push(s);
      });
    }
    var keys = [], stageOf = {};
    slugs.forEach(function (s, si) {
      ((ctx.speciesPrintings || {})[s] || []).forEach(function (pr) {
        var k = pr[1] + ":" + pr[0]; // lang:cardId
        if (keys.indexOf(k) < 0) { keys.push(k); stageOf[k] = si; }
      });
    });
    var owned = keys.filter(function (k) { return ctx.ownedKeys.has(k); });
    var fresh = newestFirst(keys.filter(function (k) { return !ctx.ownedKeys.has(k); }), ctx, 48);
    var details = await resolveDetails(owned.concat(fresh).slice(0, 60), ctx);
    var out = [];
    Object.keys(details).forEach(function (k) {
      var c = details[k];
      var st = stageOf[k];
      out.push({
        key: k, card: c, speciesSlug: ctx.speciesSlug(c.name),
        score: B.rarityWeight(c.rarity) + ownedBoost(k, ctx) + (st === 0 ? 4 : 0),
        reason: "Stage " + (st + 1) + " · " + (c.rarity || "card")
      });
    });
    return { cands: out, meta: { stages: slugs.length } };
  };

  pools.artist = async function (anchors, opts, ctx) {
    var artist = anchors[0] && anchors[0].card.artist;
    if (!artist) return { cands: [], meta: {} };
    var keys = ((ctx.artistCards || {})[artist] || []).slice();
    var owned = keys.filter(function (k) { return ctx.ownedKeys.has(k); });
    var fresh = newestFirst(keys.filter(function (k) { return !ctx.ownedKeys.has(k); }), ctx, 40);
    var details = await resolveDetails(owned.concat(fresh).slice(0, 60), ctx);
    var seenSpecies = {};
    var out = [];
    Object.keys(details).forEach(function (k) {
      var c = details[k];
      var sp = ctx.speciesSlug(c.name) || "";
      var dup = seenSpecies[sp] ? -18 : 0;
      seenSpecies[sp] = true;
      out.push({
        key: k, card: c, speciesSlug: sp,
        score: B.rarityWeight(c.rarity) + ownedBoost(k, ctx) + dup,
        reason: artist + " · " + (c.rarity || "card")
      });
    });
    return { cands: out, meta: { artist: artist } };
  };

  pools.species = async function (anchors, opts, ctx) {
    var slug = anchors[0] && anchors[0].speciesSlug;
    if (!slug) return { cands: [], meta: {} };
    var keys = (((ctx.speciesPrintings || {})[slug] || []).map(function (pr) {
      return pr[1] + ":" + pr[0];
    }));
    var owned = keys.filter(function (k) { return ctx.ownedKeys.has(k); });
    var fresh = newestFirst(keys.filter(function (k) { return !ctx.ownedKeys.has(k); }), ctx, 48);
    var details = await resolveDetails(owned.concat(fresh).slice(0, 60), ctx);
    var out = [];
    Object.keys(details).forEach(function (k) {
      var c = details[k];
      out.push({
        key: k, card: c, speciesSlug: ctx.speciesSlug(c.name),
        score: B.rarityWeight(c.rarity) + ownedBoost(k, ctx),
        reason: (c.set && c.set.name) + " · " + (c.rarity || "card")
      });
    });
    return { cands: out, meta: { species: slug } };
  };

  /* Palette-driven pools need no card details: index entries carry
   * name/image, palettes carry color. Details resolve lazily for the
   * final picks only. */
  function indexEntry(ctx, key) {
    return (ctx.indexById || {})[key] || null;
  }

  /* Index entries carry TCGdex asset base paths (no extension) for cards the
   * backfill didn't cover; those need /low.png to render as images. */
  function entryImage(e) {
    var u = e && e.image;
    if (!u) return null;
    if (u.indexOf("assets.tcgdex.net") >= 0 && !/\.(png|jpg|jpeg|webp)(\?|$)/i.test(u)) {
      return u.replace(/\/$/, "") + "/low.png";
    }
    return u;
  }
  B.entryImage = entryImage;

  /* Best-effort set display name for an index entry. */
  function setNameOf(ctx, key) {
    var e = indexEntry(ctx, key);
    if (e && e.setName) return e.setName;
    var p = ctx.parseKey(key);
    if (p && ctx.setNames && ctx.setNames[p.appSetId]) return ctx.setNames[p.appSetId];
    return null;
  }

  pools.color = async function (anchors, opts, ctx) {
    var vibe = opts.vibe || {};
    var keys = Object.keys(ctx.palettes || {});
    if (opts.ownedOnly) keys = keys.filter(function (k) { return ctx.ownedKeys.has(k); });
    var scored = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (anchors.some(function (a) { return a.key === k; })) continue;
      var pal = ctx.palettes[k].p;
      var s = B.vibeScore(pal, vibe) * 100 + ownedBoost(k, ctx, 12);
      if (s < 18) continue;
      scored.push({ key: k, score: s, pal: pal });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored.slice(0, 120);
    var details = await resolveDetails(top.map(function (t) { return t.key; }), ctx, 12);
    return {
      cands: top.map(function (t) {
        var e = indexEntry(ctx, t.key);
        var d = dominant(t.pal);
        return {
          key: t.key, card: details[t.key] || null, entry: e,
          speciesSlug: ctx.speciesSlug(e ? e.name : ""),
          score: t.score,
          reason: (d ? B.hueFamily(d[0]) + " · " : "") +
            (ctx.ownedKeys.has(t.key) ? "in your vault" : setNameOf(ctx, t.key) || "card")
        };
      }),
      meta: {}
    };
  };

  pools.gradient = async function (anchors, opts, ctx) {
    var keys = Object.keys(ctx.palettes || {});
    if (opts.ownedOnly) keys = keys.filter(function (k) { return ctx.ownedKeys.has(k); });
    var buckets = [];
    for (var b = 0; b < 9; b++) {
      var target = b * 40;
      var best = null, bestS = -1;
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (anchors.some(function (a) { return a.key === k; })) continue;
        if (buckets.some(function (x) { return x && x.key === k; })) continue;
        var pal = ctx.palettes[k].p;
        var s = B.vibeScore(pal, { hue: target, mood: opts.vibe && opts.vibe.mood }) * 100 +
          ownedBoost(k, ctx, 10);
        if (s > bestS) { bestS = s; best = { key: k, score: s, hue: target }; }
      }
      buckets.push(best);
    }
    var got = buckets.filter(Boolean);
    var details = await resolveDetails(got.map(function (g) { return g.key; }), ctx, 12);
    var cands = got.map(function (g) {
      var e = indexEntry(ctx, g.key);
      return {
        key: g.key, card: details[g.key] || null, entry: e, hue: g.hue,
        speciesSlug: ctx.speciesSlug(e ? e.name : ""),
        score: g.score, gradientHue: g.hue,
        reason: B.hueFamily(g.hue) + " band"
      };
    });
    // Hue order drives the melt effect at composition time.
    cands.sort(function (a, b) { return a.gradientHue - b.gradientHue; });
    return { cands: cands, meta: { gradient: true } };
  };

  pools.set = async function (anchors, opts, ctx) {
    var appSetId = anchors[0] && anchors[0].card.set && anchors[0].card.set.appId;
    if (!appSetId) return { cands: [], meta: {} };
    var list;
    try { list = await ctx.getSetCards(appSetId); } catch { list = []; }
    return {
      cands: (list || []).filter(function (c) {
        return !anchors.some(function (a) { return a.key === ctx.keyOf(c); });
      }).map(function (c) {
        var k = ctx.keyOf(c);
        return {
          key: k, card: c, speciesSlug: ctx.speciesSlug(c.name),
          score: B.rarityWeight(c.rarity) + ownedBoost(k, ctx),
          reason: (c.set && c.set.name) + " · " + (c.rarity || "card")
        };
      }),
      meta: { setName: anchors[0].card.set.name }
    };
  };

  /* ================= composition ================= */

  /* Anchor slots: the middle row, centered. */
  B.anchorPositions = function (n) {
    if (n >= 3) return [3, 4, 5];
    if (n === 2) return [3, 4];
    return [4];
  };

  /* Blank slots: prefer corners, then edges; count from density. */
  B.blankPositions = function (taken, count, rand) {
    var prefer = [0, 2, 6, 8, 1, 7, 5, 3];
    var out = [];
    prefer.forEach(function (p) {
      if (out.length >= count) return;
      if (taken.indexOf(p) < 0 && out.indexOf(p) < 0) out.push(p);
    });
    // Shuffle the chosen blanks lightly so pages vary.
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  };

  function cardSlot(cand, ctx, anchor) {
    var c = cand.card, e = cand.entry;
    var name = (c && c.name) || (e && e.name) || "Card";
    var image = (c && c.images && c.images.small) || entryImage(e);
    return {
      kind: "card", key: cand.key, name: name, image: image,
      reason: cand.reason || "", owned: ctx.ownedKeys.has(cand.key),
      anchor: !!anchor
    };
  }

  /* Pick an art-crop panorama insert: a paletted card whose art matches
   * the vibe; rendered as a CSS crop of its art region. */
  function pickArtInsert(vibe, takenKeys, ctx, rand) {
    var keys = Object.keys(ctx.palettes || {}).filter(function (k) {
      return takenKeys.indexOf(k) < 0;
    });
    if (!keys.length) return null;
    // Score by vibe; nudge toward dramatic art (rarer cards tend to have
    // bigger illustrations). Prefer cards whose index entry carries an
    // image — Japanese index entries don't, so they can't be panoramas.
    var scored = keys.map(function (k) {
      return { k: k, s: B.vibeScore(ctx.palettes[k].p, vibe) * 100 + rand() * 8 };
    }).sort(function (a, b) { return b.s - a.s; });
    var pick = null;
    for (var i = 0; i < scored.length; i++) {
      var e0 = indexEntry(ctx, scored[i].k);
      if (e0 && e0.image) { pick = scored[i]; break; }
    }
    pick = pick || scored[0];
    var e = indexEntry(ctx, pick.k);
    return {
      kind: "art", key: pick.k,
      image: entryImage(e), name: (e && e.name) || "Art",
      vibeScore: pick.s
    };
  }

  /* Pick a generated terrain insert from the shipped library. */
  function pickTerrainInsert(vibe, ctx, rand) {
    var libs = ctx.inserts || [];
    if (!libs.length) return null;
    var scored = libs.map(function (ins) {
      var hs;
      if (vibe.hue !== null && vibe.hue !== undefined && ins.hues) {
        hs = Math.max.apply(null, ins.hues.map(function (h) {
          return 1 - hueDist(h, vibe.hue) / 180;
        }));
      } else hs = 0.5;
      var ms = !vibe.mood || (ins.moods || []).indexOf(vibe.mood) >= 0 ? 1 : 0.3;
      return { ins: ins, s: hs * 0.6 + ms * 0.4 + rand() * 0.15 };
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored[0] && scored[0].s > 0.3 ? scored[0].ins : null;
  }

  function storyFor(recipe, layout, meta, anchors) {
    var names = anchors.map(function (a) { return a.card.name; }).join(" + ");
    switch (recipe) {
    case "evolution": return "The " + names + " family, stage by stage.";
    case "artist": return "One illustrator's hand: " + (meta.artist || "a single artist") + ".";
    case "species": return "Nine ways to love " + names + ".";
    case "color": return "A page tuned to your palette, orbiting " + names + ".";
    case "gradient": return "Hues melting across the page around " + names + ".";
    case "set": return "The chase cards of " + (meta.setName || "one set") + ".";
    default: return "A page idea for " + names + ".";
    }
  }

  /* Compose one page. `taken` seeds already-locked positions. */
  async function composePage(anchors, poolRes, opts, ctx, rand, locked) {
    var layout = opts.layout || "classic";
    var slots = new Array(9).fill(null);
    var taken = [];
    // 1. Locked slots survive.
    (locked || []).forEach(function (s, i) { if (s) { slots[i] = s; taken.push(i); } });
    // 2. Anchors (unless locked over).
    var apos = B.anchorPositions(anchors.length);
    anchors.forEach(function (a, i) {
      var p = apos[i];
      if (slots[p]) return;
      slots[p] = {
        kind: "card", key: a.key, name: a.card.name,
        image: a.card.images && a.card.images.small,
        reason: "Your anchor", owned: ctx.ownedKeys.has(a.key), anchor: true
      };
      taken.push(p);
    });
    // 3. Inserts per layout.
    var vibe = opts.vibe || {};
    var insertKeys = [];
    if (layout === "panorama" && taken.indexOf(6) < 0) {
      var art = pickArtInsert(vibe, anchors.map(function (a) { return a.key; }), ctx, rand);
      if (art) {
        var positions = [6, 7, 8].filter(function (p) { return !slots[p]; });
        if (positions.length >= 2) {
          positions = positions.slice(0, 3);
          var slot = {
            kind: "insert", span: positions.length, positions: positions,
            insert: art,
            reason: "Panorama crop · " + art.name + " art"
          };
          positions.forEach(function (p) { slots[p] = slot; taken.push(p); });
          if (art.key) insertKeys.push(art.key);
        }
      }
    }
    if (layout === "gallery") {
      var terr = pickTerrainInsert(vibe, ctx, rand);
      if (terr) {
        var gpos = [6, 7].filter(function (p) { return !slots[p]; });
        if (gpos.length === 2) {
          var gslot = {
            kind: "insert", span: 2, positions: gpos,
            insert: { kind: "terrain", src: terr.src, title: terr.title },
            reason: terr.title + " · generated backdrop"
          };
          gpos.forEach(function (p) { slots[p] = gslot; taken.push(p); });
        }
      }
    }
    // 4. Reserve blanks for air BEFORE filling cards, so "airy" pages
    // actually breathe instead of being packed and blanked after.
    var density = opts.density === undefined ? 0.7 : opts.density;
    var freeNow = [];
    for (var f = 0; f < 9; f++) if (taken.indexOf(f) < 0) freeNow.push(f);
    var blankTarget = layout === "gallery" ? Math.min(4, freeNow.length)
      : layout === "panorama" ? Math.min(1, freeNow.length)
      : Math.round((1 - density) * 2.5);
    blankTarget = Math.max(0, Math.min(blankTarget, freeNow.length));
    if (blankTarget > 0) {
      B.blankPositions(taken, blankTarget, rand).forEach(function (p) {
        slots[p] = { kind: "blank", reason: "Left empty on purpose" };
        taken.push(p);
      });
    }
    // 5. Card candidates, best-first, with diversity guard. Gradient
    // candidates arrive hue-sorted and fill left-to-right for the melt.
    var cands = (poolRes.cands || []).slice();
    if (!(poolRes.meta && poolRes.meta.gradient)) {
      // Per-page jitter: the three ideas stay on-brief but come out genuinely
      // different instead of three copies of the same best-first fill.
      for (var ji = 0; ji < cands.length; ji++) cands[ji]._j = cands[ji].score + rand() * 14;
      cands.sort(function (a, b) { return b._j - a._j; });
    }
    var anchorKeys = {};
    anchors.forEach(function (a) { anchorKeys[a.key] = true; });
    var wantCards = layout === "gallery" ? 4 : 99;
    var placedSpecies = {};
    anchors.forEach(function (a) { placedSpecies[a.speciesSlug] = true; });
    var order = [];
    for (var p = 0; p < 9; p++) if (!slots[p]) order.push(p);
    var placed = 0, qi = 0;
    var recipe = opts.recipe;
    while (placed < wantCards && qi < cands.length && order.length) {
      var c = cands[qi++];
      if (anchorKeys[c.key]) continue; // never re-suggest an anchor
      if (slotsTakenHasKey(slots, c.key)) continue;
      if (insertKeys.indexOf(c.key) >= 0) continue; // don't re-pick the panorama art
      var sp = c.speciesSlug;
      if ((recipe === "artist" || recipe === "color" || recipe === "set") &&
          sp && placedSpecies[sp]) continue; // no dup species on these pages
      var pos = order.shift();
      slots[pos] = cardSlot(c, ctx, false);
      taken.push(pos);
      if (sp) placedSpecies[sp] = true;
      placed++;
    }
    // 6. Anything still empty becomes the next-best card.
    for (var q = 0; q < 9; q++) {
      if (!slots[q]) {
        var nxt = null;
        for (var qi2 = 0; qi2 < cands.length; qi2++) {
          var ck = cands[qi2].key;
          if (anchorKeys[ck]) continue;
          if (!slotsTakenHasKey(slots, ck) && insertKeys.indexOf(ck) < 0) { nxt = cands[qi2]; break; }
        }
        slots[q] = nxt ? cardSlot(nxt, ctx, false)
          : { kind: "blank", reason: "Left empty on purpose" };
      }
    }
    return {
      recipe: opts.recipe, layout: layout,
      title: B.RECIPES[opts.recipe].title + " · " + B.LAYOUTS[layout].title,
      story: storyFor(opts.recipe, layout, poolRes.meta, anchors),
      slots: slots
    };
  }

  function slotsTakenHasKey(slots, key) {
    return slots.some(function (s) { return s && s.kind === "card" && s.key === key; });
  }

  /* Seedable PRNG (mulberry32) so "shuffle" varies but stays testable. */
  B.prng = function (seed) {
    var t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      var z = Math.imul(t ^ (t >>> 15), t | 1);
      z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
      return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* Main entry: 3 page ideas. `locked` is an optional array of 9 slots. */
  B.generatePages = async function (anchors, opts, ctx, locked) {
    opts = opts || {};
    var recipe = opts.recipe || "color";
    var poolFn = pools[recipe];
    if (!poolFn) throw new Error("unknown recipe: " + recipe);
    var poolRes = await poolFn(anchors, opts, ctx);
    var pages = [];
    var n = opts.count || 3;
    for (var i = 0; i < n; i++) {
      var rand = B.prng((opts.seed || 1) * 1000 + i * 77 + Date.now() % 1000);
      pages.push(await composePage(anchors, poolRes, opts, ctx, rand, locked));
    }
    return pages;
  };

  B._pools = pools; // exposed for tests
})();
