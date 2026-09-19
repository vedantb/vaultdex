/* VaultDex — achievements: badge definitions, evaluation, unlock tracking.
 *
 * BADGES is a list of { id, name, desc, icon, category, eval(input) }.
 * eval is pure: input = { rows, peakValue, completedSets, speciesCount,
 * speciesGroups } where speciesGroups = App.species.groupRowsBySpecies(rows).
 * Every eval returns { unlocked, current, target } so the trophy case can
 * render progress and the home page can find the closest-to-unlocking badge.
 *
 * Unlock toasts fire only for the owner (checkNewUnlocks), and the first
 * run populates localStorage silently so the owner isn't spammed with a
 * mass-unlock. Value milestones and set-completion celebrations are
 * one-shot each, stored in localStorage. Zero PkmnPrices credits — all
 * computed from collection rows, value snapshots, and the local catalog.
 * Pricing failures stay quiet: every entry point is wrapped in try/catch. */
(function () {
  window.App = window.App || {};

  function copies(rows) {
    return (rows || []).reduce(function (n, r) { return n + (Number(r.quantity) || 1); }, 0);
  }
  function holoCopies(rows) {
    return (rows || []).reduce(function (n, r) {
      return n + (/holo/i.test(String(r.variant || "")) ? (Number(r.quantity) || 1) : 0);
    }, 0);
  }
  function rarityCopies(rows, list) {
    var want = {};
    list.forEach(function (x) { want[x.toLowerCase()] = true; });
    return (rows || []).reduce(function (n, r) {
      return n + (want[String(r.rarity || "").toLowerCase()] ? (Number(r.quantity) || 1) : 0);
    }, 0);
  }
  function count(rows, pred) {
    var t = 0;
    (rows || []).forEach(function (r) { if (pred(r)) t += Number(r.quantity) || 1; });
    return t;
  }

  var BADGES = [
    /* ---- collection size ---- */
    { id: "first-card", name: "First Steps", desc: "Add your first card to the vault.", icon: "🎴", category: "Collection",
      eval: function (i) { var c = copies(i.rows); return { unlocked: c >= 1, current: Math.min(c, 1), target: 1 }; } },
    { id: "century-club", name: "Century Club", desc: "Own 100 cards.", icon: "💯", category: "Collection",
      eval: function (i) { var c = copies(i.rows); return { unlocked: c >= 100, current: Math.min(c, 100), target: 100 }; } },
    { id: "kilocard", name: "Kilocard", desc: "Own 1,000 cards.", icon: "📦", category: "Collection",
      eval: function (i) { var c = copies(i.rows); return { unlocked: c >= 1000, current: Math.min(c, 1000), target: 1000 }; } },
    { id: "vault-filler", name: "Vault Filler", desc: "Own 2,500 cards.", icon: "🗄️", category: "Collection",
      eval: function (i) { var c = copies(i.rows); return { unlocked: c >= 2500, current: Math.min(c, 2500), target: 2500 }; } },
    { id: "hoarder", name: "Hoarder Supreme", desc: "Own 4,000 cards. Seek help. (Affectionate.)", icon: "👑", category: "Collection",
      eval: function (i) { var c = copies(i.rows); return { unlocked: c >= 4000, current: Math.min(c, 4000), target: 4000 }; } },
    /* ---- vault value (peak, so a dip can't re-lock a badge) ---- */
    { id: "thousandaire", name: "Thousandaire", desc: "Vault value reaches $1,000.", icon: "💵", category: "Value",
      eval: function (i) { var v = i.peakValue || 0; return { unlocked: v >= 1000, current: Math.min(v, 1000), target: 1000 }; } },
    { id: "high-roller", name: "High Roller", desc: "Vault value reaches $5,000.", icon: "🎲", category: "Value",
      eval: function (i) { var v = i.peakValue || 0; return { unlocked: v >= 5000, current: Math.min(v, 5000), target: 5000 }; } },
    { id: "five-figures", name: "Five Figures", desc: "Vault value reaches $10,000.", icon: "💰", category: "Value",
      eval: function (i) { var v = i.peakValue || 0; return { unlocked: v >= 10000, current: Math.min(v, 10000), target: 10000 }; } },
    { id: "grail-vault", name: "Grail Vault", desc: "Vault value reaches $25,000.", icon: "🏦", category: "Value",
      eval: function (i) { var v = i.peakValue || 0; return { unlocked: v >= 25000, current: Math.min(v, 25000), target: 25000 }; } },
    /* ---- rarity & shine ---- */
    { id: "holo-century", name: "Holo Century", desc: "Own 100 holofoil cards.", icon: "✨", category: "Rarity",
      eval: function (i) { var c = holoCopies(i.rows); return { unlocked: c >= 100, current: Math.min(c, 100), target: 100 }; } },
    { id: "art-connoisseur", name: "Art Connoisseur", desc: "Own 10 illustration or special illustration rares.", icon: "🖼️", category: "Rarity",
      eval: function (i) { var c = rarityCopies(i.rows, ["Illustration rare", "Special illustration rare"]); return { unlocked: c >= 10, current: Math.min(c, 10), target: 10 }; } },
    { id: "chase-hunter", name: "Chase Hunter", desc: "Own 5 secret, ultra, double, or hyper rares.", icon: "🎯", category: "Rarity",
      eval: function (i) { var c = rarityCopies(i.rows, ["Secret Rare", "Ultra Rare", "Double rare", "Mega Hyper Rare"]); return { unlocked: c >= 5, current: Math.min(c, 5), target: 5 }; } },
    { id: "slabbed", name: "Slabbed", desc: "Own a graded card.", icon: "🧱", category: "Rarity",
      eval: function (i) { var c = count(i.rows, function (r) { return !!r.grading_company; }); return { unlocked: c >= 1, current: Math.min(c, 1), target: 1 }; } },
    { id: "grail-keeper", name: "Grail Keeper", desc: "Own a single card worth $500 or more.", icon: "💎", category: "Rarity",
      eval: function (i) { var c = count(i.rows, function (r) { return Number(r.market_price) >= 500; }); return { unlocked: c >= 1, current: Math.min(c, 1), target: 1 }; } },
    /* ---- species ---- */
    { id: "field-researcher", name: "Field Researcher", desc: "Capture 100 Pokémon species.", icon: "🔬", category: "Species",
      eval: function (i) { var c = i.speciesCount || 0; return { unlocked: c >= 100, current: Math.min(c, 100), target: 100 }; } },
    { id: "dex-builder", name: "Dex Builder", desc: "Capture 250 Pokémon species.", icon: "📖", category: "Species",
      eval: function (i) { var c = i.speciesCount || 0; return { unlocked: c >= 250, current: Math.min(c, 250), target: 250 }; } },
    { id: "professors-pride", name: "Professor's Pride", desc: "Capture 500 Pokémon species.", icon: "🎓", category: "Species",
      eval: function (i) { var c = i.speciesCount || 0; return { unlocked: c >= 500, current: Math.min(c, 500), target: 500 }; } },
    { id: "pikachu-hoarder", name: "Pikachu Hoarder", desc: "Own 25 Pikachu cards. No regrets.", icon: "⚡", category: "Species",
      eval: function (i) { var g = (i.speciesGroups || {}).pikachu; var c = g ? g.copies : 0; return { unlocked: c >= 25, current: Math.min(c, 25), target: 25 }; } },
    /* ---- set completion ---- */
    { id: "master-1", name: "Master Set", desc: "Complete your first set (100%).", icon: "🏅", category: "Sets",
      eval: function (i) { var c = i.completedSets || 0; return { unlocked: c >= 1, current: Math.min(c, 1), target: 1 }; } },
    { id: "master-5", name: "Set Master V", desc: "Complete 5 sets.", icon: "🥇", category: "Sets",
      eval: function (i) { var c = i.completedSets || 0; return { unlocked: c >= 5, current: Math.min(c, 5), target: 5 }; } },
    { id: "master-10", name: "Deca Master", desc: "Complete 10 sets.", icon: "🏆", category: "Sets",
      eval: function (i) { var c = i.completedSets || 0; return { unlocked: c >= 10, current: Math.min(c, 10), target: 10 }; } }
  ];

  function evaluate(input) {
    input = input || {};
    return BADGES.map(function (b) {
      var r;
      try { r = b.eval(input) || {}; }
      catch { r = {}; }
      return {
        badge: b,
        unlocked: !!r.unlocked,
        current: typeof r.current === "number" ? r.current : 0,
        target: typeof r.target === "number" && r.target > 0 ? r.target : 1
      };
    });
  }

  function unlockedIds(results) {
    return results.filter(function (r) { return r.unlocked; }).map(function (r) { return r.badge.id; });
  }

  /* The single locked badge closest to unlocking (highest current/target),
   * for the home-page nudge. Ties break toward the smaller target. */
  function closestLocked(results) {
    var best = null, bestRatio = -1;
    results.forEach(function (r) {
      if (r.unlocked || r.target <= 0) return;
      var ratio = r.current / r.target;
      if (ratio > bestRatio || (ratio === bestRatio && best && r.target < best.target)) {
        best = r; bestRatio = ratio;
      }
    });
    return best;
  }

  /* Build the evaluation input from collection rows. Async only because
   * the species mapping loads from disk; everything else is in memory. */
  async function buildInput(rows) {
    rows = rows || [];
    var t = App.collection.totals(rows);
    var peak = t.value;
    try {
      var hist = await App.collection.valueHistory();
      hist.forEach(function (p) {
        var v = Number(p.total_value) || 0;
        if (v > peak) peak = v;
      });
    } catch { /* history optional */ }
    var speciesCount = 0, speciesGroups = {};
    try {
      await App.species.loadMapping();
      speciesGroups = App.species.groupRowsBySpecies(rows);
      speciesCount = Object.keys(speciesGroups).length;
    } catch { /* species optional */ }
    var completed = [];
    try { completed = await completedSets(rows); } catch { /* optional */ }
    return {
      rows: rows,
      peakValue: peak,
      completedSets: completed.length,
      completedSetList: completed,
      speciesCount: speciesCount,
      speciesGroups: speciesGroups
    };
  }

  /* Owned distinct card_ids per set appId -> compare against catalog
   * totals (same denominator the set page uses). Pure on rows + sets. */
  function ownedBySetFromRows(rows) {
    var map = {};
    (rows || []).forEach(function (r) {
      if (!r.set_id || !r.card_id) return;
      var key = String(r.set_id);
      var set = map[key] || (map[key] = {});
      set[String(r.card_id)] = true;
    });
    return map;
  }

  async function completedSets(rows) {
    var bySet = ownedBySetFromRows(rows);
    var sets;
    try { sets = await App.tcg.getSets(); } catch { return []; }
    var out = [];
    sets.forEach(function (s) {
      var total = Number(s.total) || Number(s.printedTotal) || 0;
      if (!total) return;
      var owned = bySet[s.appId] ? Object.keys(bySet[s.appId]).length : 0;
      if (owned >= total) out.push({ appId: s.appId, name: s.name, owned: owned, total: total });
    });
    return out;
  }

  /* ---------- localStorage helpers ---------- */
  function lsGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ }
  }

  var KEY_UNLOCKED = "vd_unlocked_v1";
  var KEY_MASTER_SETS = "vd_master_sets_v1";
  var KEY_VALUE_MS = "vd_value_ms_v1";

  function isOwner() {
    return !!(App.auth && App.auth.isOwner && App.auth.isOwner());
  }

  /* ---------- confetti (reduced-motion aware) ---------- */
  function celebrate(title, sub) {
    if (App.ui && App.ui.reduceMotion) { /* toast only */ }
    else {
      try {
        var stage = document.createElement("div");
        stage.className = "confetti-stage";
        stage.setAttribute("aria-hidden", "true");
        var colors = ["#e3350d", "#ffcb05", "#2a75bb", "#7ac74c", "#ee8130", "#a33ea1"];
        for (var i = 0; i < 90; i++) {
          var p = document.createElement("i");
          p.style.left = (Math.random() * 100) + "%";
          p.style.background = colors[i % colors.length];
          p.style.animationDelay = (Math.random() * 0.6) + "s";
          p.style.animationDuration = (2.2 + Math.random() * 1.6) + "s";
          if (Math.random() < 0.4) p.className = "confetti-round";
          stage.appendChild(p);
        }
        document.body.appendChild(stage);
        setTimeout(function () { stage.remove(); }, 4200);
      } catch { /* confetti is garnish */ }
    }
    if (App.ui && App.ui.toast) App.ui.toast(title + (sub ? " — " + sub : ""), "success");
  }

  /* ---------- unlock diffing (owner only, first run silent) ---------- */
  async function checkNewUnlocks() {
    if (!isOwner()) return;
    try {
      var rows = await App.collection.list();
      if (!rows) return;
      var input = await buildInput(rows);
      var ids = unlockedIds(evaluate(input));
      var prev = lsGet(KEY_UNLOCKED, null);
      if (prev === null) { lsSet(KEY_UNLOCKED, ids); return; } // first run: silent
      var fresh = ids.filter(function (id) { return prev.indexOf(id) === -1; });
      if (fresh.length) {
        lsSet(KEY_UNLOCKED, ids);
        var byId = {};
        BADGES.forEach(function (b) { byId[b.id] = b; });
        fresh.slice(0, 3).forEach(function (id) {
          var b = byId[id];
          if (b && App.ui && App.ui.toast) App.ui.toast("🏆 Achievement unlocked: " + b.name, "success");
        });
        if (fresh.length > 3 && App.ui && App.ui.toast) {
          App.ui.toast("🏆 +" + (fresh.length - 3) + " more achievements — see the Trophy Case", "success");
        }
      }
    } catch { /* never block boot */ }
  }

  /* ---------- set-completion celebration (owner only) ---------- */
  async function checkSetCompletions() {
    if (!isOwner()) return;
    try {
      var rows = await App.collection.list();
      if (!rows) return;
      var done = await completedSets(rows);
      var ids = done.map(function (s) { return s.appId; });
      var prev = lsGet(KEY_MASTER_SETS, null);
      if (prev === null) { lsSet(KEY_MASTER_SETS, ids); return; } // first run: silent
      var byId = {};
      done.forEach(function (s) { byId[s.appId] = s; });
      ids.filter(function (id) { return prev.indexOf(id) === -1; }).forEach(function (id) {
        var s = byId[id];
        celebrate("Master Set complete!", (s && s.name) || id);
      });
      if (ids.length !== prev.length || ids.some(function (id) { return prev.indexOf(id) === -1; })) {
        lsSet(KEY_MASTER_SETS, ids);
      }
    } catch { /* never block */ }
  }

  var VALUE_MILESTONES = [10000, 25000, 50000, 100000];
  function fmtMs(v) { return "$" + Number(v).toLocaleString("en-US"); }

  /* ---------- value-milestone celebration (owner only) ----------
   * Called from recordValueSnapshot after a successful upsert. */
  function checkValueMilestones(value) {
    if (!isOwner()) return;
    try {
      value = Number(value) || 0;
      var fired = lsGet(KEY_VALUE_MS, []);
      VALUE_MILESTONES.forEach(function (ms) {
        if (value >= ms && fired.indexOf(ms) === -1) {
          fired.push(ms);
          celebrate("Vault milestone!", "Your collection crossed " + fmtMs(ms));
        }
      });
      lsSet(KEY_VALUE_MS, fired);
    } catch { /* never block */ }
  }

  App.achievements = {
    BADGES: BADGES,
    evaluate: evaluate,
    unlockedIds: unlockedIds,
    closestLocked: closestLocked,
    buildInput: buildInput,
    ownedBySetFromRows: ownedBySetFromRows,
    completedSets: completedSets,
    checkNewUnlocks: checkNewUnlocks,
    checkSetCompletions: checkSetCompletions,
    checkValueMilestones: checkValueMilestones,
    celebrate: celebrate
  };
})();
