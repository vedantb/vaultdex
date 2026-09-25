/* VaultDex — collection data layer (Supabase: collection_items).
 * Every write is gated behind an active session.
 */
(function () {
  window.App = window.App || {};

  function needUser() {
    var u = App.auth.user;
    if (!u) { App.ui.signInPrompt(); return null; }
    return u;
  }

  /* Pick the variant with the highest market price (fallback: 'normal'). */
  function defaultVariant(card) {
    var vs = App.tcg.variantsOf(card);
    return (vs.length ? vs[0].key : "normal");
  }

  /* ---- pure helpers (extracted for unit testing; behavior-identical) ---- */

  /* addItem clamps every quantity into [1, 99]. */
  function clampQuantity(q) {
    return Math.max(1, Math.min(99, q || 1));
  }

  /* Japanese set ids are stored appId-style ("ja-M4") so pricing can
   * always tell Japanese printings apart — even for ids like neo1
   * that exist in both languages. */
  function rowSetId(card) {
    var setLang = (card.set && card.set.lang) || "en";
    var setId = (card.set && card.set.id) || null;
    if (setId && setLang === "ja" && !App.util.isJa(setId)) setId = "ja-" + setId;
    return { setId: setId, setLang: setLang };
  }

  /* Incremental refresh: only rows whose own price is missing or older
   * than 24h. A full pass over thousands of rows would take over an hour. */
  var PRICE_REFRESH_MS = 24 * 60 * 60 * 1000;
  function needsPriceRefresh(row, nowMs) {
    var t = row.price_updated_at ? Date.parse(row.price_updated_at) : 0;
    return !t || t < nowMs - PRICE_REFRESH_MS;
  }

  /* Refresh queue priority (2026-09-25): a full pass over ~450 unpriced
   * rows takes 10+ minutes at 1.2s pacing, and a pass can be cut short at
   * any time (tab backgrounded, phone locked, rate limit). The old code ran
   * rows in database order, so a partial pass priced random bulk rows while
   * the owner's most visible cards — the unpriced graded cards at the top
   * of the collection — sat at the back of the queue indefinitely.
   * Order: unpriced graded rows first, then other unpriced rows, then
   * stale rows stalest-first. Pure, unit-tested. */
  function sortRefreshQueue(items) {
    function rank(row) {
      var graded = row.grading_company && row.grade ? 0 : 1;
      var unpriced = (row.market_price == null) ? 0 : 1;
      return graded * 2 + unpriced;
    }
    return items.slice().sort(function (a, b) {
      var ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      var ta = a.price_updated_at ? Date.parse(a.price_updated_at) : 0;
      var tb = b.price_updated_at ? Date.parse(b.price_updated_at) : 0;
      return ta - tb;
    });
  }

  /* Price currency column ("price_currency" on collection_items) may not
   * exist yet — Vedant runs supabase/migration-price-currency.sql in the
   * dashboard, and there is no service key on this VM to apply it for him.
   * Probe once per session; writes include the column only when it exists,
   * reads treat a missing value as USD either way. */
  var HAS_PRICE_CURRENCY = false;
  var priceCurrencyProbe = null;
  async function probePriceCurrencyOnce() {
    try {
      if (!App.sb) return false;
      var res = await App.sb.from("collection_items").select("price_currency").limit(1);
      HAS_PRICE_CURRENCY = !res.error;
    } catch {
      HAS_PRICE_CURRENCY = false;
    }
    return HAS_PRICE_CURRENCY;
  }
  function ensurePriceCurrencyProbe() {
    if (!priceCurrencyProbe) {
      priceCurrencyProbe = probePriceCurrencyOnce().catch(function () { return false; });
    }
    return priceCurrencyProbe;
  }

  /* Plausibility-quarantine columns ("price_pending" + "price_pending_at"
   * on collection_items) may not exist yet — Vedant runs
   * supabase/migration-price-pending.sql in the dashboard, and there is
   * no service key on this VM to apply it for him. Probe once per
   * session; the two-confirmation gate below is active only when the
   * columns exist, otherwise extreme prices are written with a loud
   * warning (today's behavior). */
  var HAS_PRICE_PENDING = false;
  var pricePendingProbe = null;
  async function probePricePendingOnce() {
    try {
      if (!App.sb) return false;
      var res = await App.sb.from("collection_items").select("price_pending").limit(1);
      HAS_PRICE_PENDING = !res.error;
    } catch {
      HAS_PRICE_PENDING = false;
    }
    return HAS_PRICE_PENDING;
  }
  function ensurePricePendingProbe() {
    if (!pricePendingProbe) {
      pricePendingProbe = probePricePendingOnce().catch(function () { return false; });
    }
    return pricePendingProbe;
  }

  /* Plausibility gate (2026-09-25): a single price write may never move a
   * row's value by an order of magnitude on first sight. If the fresh
   * lookup says a $5+ row is suddenly worth 10x more (or 90% less), the
   * displayed price is HELD and the candidate parked in price_pending.
   * Only when the NEXT pass computes the same extreme value is it
   * confirmed and written — a one-off bad lookup (wrong printing, bad
   * comps, provider glitch) can never move the collection total or the
   * graph again. Legitimate spikes land 24h later; the graph stays
   * honest. Sub-$5 rows are exempt: bulk-bin noise can't move the total.
   * Pure — exported for unit tests. */
  var PLAUS_MAX_RATIO = 10;
  var PLAUS_MIN_BASE = 5;
  function pricePlausibility(row, newPrice) {
    var old = row && row.market_price;
    if (typeof old !== "number" || !(old >= PLAUS_MIN_BASE)) return { hold: false };
    if (typeof newPrice !== "number" || !(newPrice >= 0)) return { hold: false };
    var extreme = newPrice === 0 || newPrice / old >= PLAUS_MAX_RATIO || newPrice / old <= 1 / PLAUS_MAX_RATIO;
    if (!extreme) return { hold: false };
    var pending = row.price_pending;
    if (typeof pending === "number" && Math.abs(pending - newPrice) < 0.005) {
      return { hold: false, confirmed: true }; /* same extreme twice running: trust it */
    }
    return { hold: true };
  }

  /* Mover history (Feature 4): NULL prev_price means "no mover data" — a
   * row that was never refreshed, or whose price never moved, shows no
   * mover data rather than a fake zero. Only when the row had a real
   * price before AND the new price differs do we record the old price
   * as prev_price. Returns the update object, or null when the new
   * price isn't a real number. The currency travels with the price so
   * movers/tiles never render EUR prices with a "$". */
  function moverUpdate(row, newPrice, priceSource, now, currency) {
    if (typeof newPrice !== "number") return null;
    var update = { market_price: newPrice, price_source: priceSource, price_updated_at: now };
    if (HAS_PRICE_CURRENCY) update.price_currency = currency || "USD";
    var oldPrice = row.market_price;
    if (typeof oldPrice === "number" && newPrice !== oldPrice) {
      update.prev_price = oldPrice;
      update.prev_price_at = row.price_updated_at || null;
    }
    return update;
  }

  /* Legacy catalog price for a freshly added card. Used only when the
   * PkmnPrices proxy isn't configured or can't match the printing. */
  function legacyMarket(card, variant) {
    var variants = App.tcg.variantsOf(card);
    var v = variants.filter(function (x) { return x.key === variant; })[0];
    var m = (v && typeof v.prices.market === "number") ? v.prices.market : App.tcg.marketOf(card);
    return typeof m === "number" ? m : null;
  }

  /* Row identity for addItem's duplicate check: (normalized variant label,
   * pkmn_id). Two printings can share one PkmnPrices record (Holo and Cosmos
   * Holo both price off the base record when the provider carries no cosmos
   * listing), and one printing can be stored under different label spellings
   * ("Holo" vs "holofoil"). Pure so it can be unit-tested. */
  function findMatchingRow(rows, variant, pkmnId) {
    var wantV = App.tcg.normVLabel(variant);
    var wantP = pkmnId || null;
    return (rows || []).find(function (r) {
      return App.tcg.normVLabel(r.variant) === wantV && (r.pkmn_id || null) === wantP;
    }) || null;
  }

  /* pkmn: optional { pkmnId, label } for a PkmnPrices print variant
   * (per-variant set-page checkboxes). Prices directly against that exact
   * record; the row keeps the variant's human label. */
  async function rowFromCard(u, card, variant, quantity, pkmn, grading) {
    var market = null;
    var priceSource = null;
    var priceCurrency = "USD";
    var pkmnId = (pkmn && pkmn.pkmnId) || null;
    var label = variant;
    var ids = rowSetId(card);
    var setLang = ids.setLang;
    var setId = ids.setId;
    /* Grading (Feature 5): { company, grade } or null. A graded and an
     * ungraded copy of the same card+variant are distinct rows. */
    var gradingCompany = (grading && grading.company) || null;
    var gradingGrade = (grading && grading.grade) || null;
    // Graded cards: try the graded market price first (exact company+grade).
    // Never invent one — on miss, fall through to the raw Near Mint flow.
    if (gradingCompany && gradingGrade) {
      try {
        var gid = pkmnId || await App.pkmn.findCardId({
          name: card.name,
          setName: card.set && card.set.name,
          number: card.number,
          lang: setLang,
          setId: setId
        });
        var g = gid ? await App.pkmn.gradedPrice(gid, gradingCompany, gradingGrade, { lang: setLang }) : null;
        if (g && typeof g.price === "number") {
          market = g.price;
          priceSource = "pkmnprices-graded";
          priceCurrency = g.currency || "USD";
        }
      } catch (e) {
        console.warn("[VaultDex] PkmnPrices graded lookup failed:", e && e.message);
      }
    }
    if (market === null) {
    if (pkmnId) {
      try {
        // findVariantPrice callers pass their already-priced match through
        // as pkmn.resolved so we don't pay for a second lookup.
        var p = (pkmn && pkmn.resolved) || await App.pkmn.nearMintPrice(pkmnId, null);
        if (p && typeof p.price === "number") {
          market = p.price;
          priceSource = "pkmnprices";
          priceCurrency = p.currency || "USD";
          if (!pkmn.label || pkmn.label === "Standard") label = p.variant || "Normal";
          else label = pkmn.label;
        }
      } catch (e) {
        console.warn("[VaultDex] PkmnPrices variant lookup failed:", e && e.message);
      }
    } else {
      // Prefer PkmnPrices: exact printing mapped by set + card number,
      // always the Near Mint price.
      try {
        var q = await App.pkmn.priceForRow({
          card_name: card.name,
          set_name: card.set && card.set.name,
          set_id: setId,
          number: card.number,
          variant: variant,
          lang: setLang
        });
        if (q && typeof q.price === "number") {
          market = q.price;
          priceSource = "pkmnprices";
          priceCurrency = q.currency || "USD";
        }
      } catch (e) {
        // Not configured yet (or lookup failed): fall back to the legacy price
        // rather than blocking the add. The next price refresh will fix it
        // once the key is in place.
        console.warn("[VaultDex] PkmnPrices lookup failed, using legacy price:", e && e.message);
      }
      if (market === null) market = legacyMarket(card, variant);
    }
    } /* end if (market === null): graded lookup ran first, raw Near Mint is the fallback */
    /* The currency column may not exist yet (probe at the top of this
     * module). Omit it from the insert when unsupported so older DBs
     * never see an unknown column. */
    var insert = {
      user_id: u.id,
      card_id: card.id,
      card_name: card.name,
      set_id: setId,
      set_name: (card.set && card.set.name) || null,
      number: card.number || null,
      image_small: (card.images && card.images.small) || null,
      image_large: (card.images && card.images.large) || null,
      artist: card.artist || null,
      rarity: card.rarity || null,
      variant: label,
      pkmn_id: pkmnId,
      grading_company: gradingCompany,
      grade: gradingGrade,
      quantity: quantity,
      market_price: market,
      price_source: priceSource,
      price_updated_at: typeof market === "number" ? new Date().toISOString() : null
    };
    if (await ensurePriceCurrencyProbe()) insert.price_currency = priceCurrency;
    return insert;
  }

  /* Paginated fetch: PostgREST caps a single response at 1000 rows,
   * so large collections must be pulled in pages. */
  async function fetchAllPages(queryBuilder) {
    var out = [];
    var pageSize = 1000;
    var from = 0;
    for (;;) {
      var res = await queryBuilder(from, from + pageSize - 1);
      if (res.error) throw res.error;
      var rows = res.data || [];
      out = out.concat(rows);
      if (rows.length < pageSize) break;
      from += pageSize;
    }
    return out;
  }

  async function list() {
    var u = needUser();
    if (!u) return null;
    var rows = await fetchAllPages(function (from, to) {
      return App.sb
        .from("collection_items")
        .select("*")
        .eq("user_id", u.id)
        .order("added_at", { ascending: false })
        .range(from, to);
    });
    await backfillRowImages(rows, true);
    /* One-shot repair: unsupported Japanese sets (M6a/MC/SM1p) can hold a
     * poisoned pkmn_id + price from the removed number-only fallback —
     * e.g. M6a Pikachu #017 priced as SV2D Clay Burst #017. Clear them. */
    await repairMissingSetPrices(rows);
    /* One-shot repair: accent-blind set matching let the number-only
     * fallback cross-price rows in accented sets (Pokémon GO Moltres #12
     * Holo as Fossil Moltres). Clear them; the next refresh re-prices. */
    await repairAccentFallbackPrices(rows);
    /* One-shot repair: name-normalization-only set matching let the
     * number-only fallback cross-price rows in any set whose provider
     * name never normalized cleanly (SV Professor's Research #189/#190
     * as Professor Program promos). Now that lookups are set_id-scoped,
     * clear the stale ids + prices; the next refresh re-prices them. */
    await repairSetMatchPrices(rows);
    /* One-shot repair: graded prices from before the exact-attribution
     * fix may be medians of unverified comps (Latias & Latios GX PSA 10
     * at €5,496.45). Clear them; the next refresh re-prices with the
     * fixed lookup. */
    await repairGradedAttributionPrices(rows);
    return rows;
  }

  /* Public read for signed-out visitors: the owner's collection only.
   * Requires the "collection_items_public_owner_read" RLS policy
   * (supabase/migration-public-collection.sql). Returns [] when the
   * owner id isn't configured yet. */
  async function listPublic() {
    var ownerId = (window.APP_CONFIG && window.APP_CONFIG.OWNER_USER_ID) || "";
    if (!ownerId || ownerId.indexOf("00000000") === 0) return [];
    var rows = await fetchAllPages(function (from, to) {
      return App.sb
        .from("collection_items")
        .select("*")
        .eq("user_id", ownerId)
        .order("added_at", { ascending: false })
        .range(from, to);
    });
    /* Signed-out: in-memory healing only — anon has no write grant. */
    await backfillRowImages(rows, false);
    return rows;
  }

  async function addItem(card, variant, quantity, pkmn, grading) {
    var u = needUser();
    if (!u) return false;
    variant = variant || defaultVariant(card);
    quantity = clampQuantity(quantity);
    var pkmnId = (pkmn && pkmn.pkmnId) || null;

    var lookup = App.sb
      .from("collection_items")
      .select("id,quantity,variant,pkmn_id")
      .eq("user_id", u.id)
      .eq("card_id", card.id);
    var gCompany = (grading && grading.company) || null;
    var gGrade = (grading && grading.grade) || null;
    // Graded and ungraded copies of the same card+variant are distinct rows.
    // NULL-safe: pre-migration rows have NULL grading columns.
    lookup = gCompany === null ? lookup.is("grading_company", null) : lookup.eq("grading_company", gCompany);
    lookup = gGrade === null ? lookup.is("grade", null) : lookup.eq("grade", gGrade);
    var found = await lookup;
    if (found.error) throw found.error;
    /* Row identity is (normalized variant label, pkmn_id): two printings can
     * share one PkmnPrices record — e.g. Holo and Cosmos Holo both price off
     * the base record when the provider carries no cosmos listing — and the
     * same printing can be stored under different label spellings ("Holo"
     * vs "holofoil"). Matching on pkmn_id alone merged distinct printings,
     * so checking Holo made Cosmos Holo uncheckable (it just bumped the
     * Holo row's quantity). */
    var ex = findMatchingRow(found.data, variant, pkmnId);

    var addedPriceSource = null;
    if (ex) {
      var up = await App.sb
        .from("collection_items")
        .update({ quantity: ex.quantity + quantity })
        .eq("id", ex.id);
      if (up.error) throw up.error;
    } else {
      var newRow = await rowFromCard(u, card, variant, quantity, pkmn, grading);
      var ins = await App.sb.from("collection_items").insert(newRow);
      if (ins.error) throw ins.error;
      addedPriceSource = newRow.price_source;
    }
    App.emit("collection:changed", { cardId: card.id });
    // Truthy-compatible with the old boolean. priceSource === "pkmnprices-graded"
    // means a real graded price was stored; anything else with grading set means
    // the raw Near Mint fallback was used (no graded comps found).
    return { added: true, priceSource: addedPriceSource };
  }

  /* Pure predicate for the missing-set repair: a row from an unsupported
   * set needs clearing when it carries any pricing residue — a stored
   * pkmn_id OR a market_price written without an ID (the old number-only
   * fallback priced rows via priceForRow without persisting pkmn_id).
   * Exported for unit tests. */
  /* Continuity guard (2026-09-25): a repair NEVER deletes a displayed
   * price. The old value may be wrong, but nulling it drops the collection
   * total and carves a fake cliff into the value graph — strictly worse
   * than showing the stale price until its replacement lands. So a repair
   * clears only the poisoned identity (pkmn_id, mover history, any parked
   * plausibility candidate) and backdates price_updated_at past the refresh
   * horizon, forcing the next pass to reprice the row; the refresh then
   * overwrites the price in a single atomic write. The total never dips. */
  var STALE_REPRICE_AT = "2000-01-01T00:00:00.000Z";
  async function staleForReprice(u, row, hasCurrency, hasPending) {
    var patch = {
      pkmn_id: null,
      price_updated_at: STALE_REPRICE_AT,
      prev_price: null,
      prev_price_at: null
    };
    if (hasCurrency) patch.price_currency = "USD";
    if (hasPending) { patch.price_pending = null; patch.price_pending_at = null; }
    try {
      var up = await App.sb
        .from("collection_items")
        .update(patch)
        .eq("id", row.id)
        .eq("user_id", u.id);
      if (!up.error) {
        row.pkmn_id = null;
        row.price_updated_at = STALE_REPRICE_AT;
        row.prev_price = null;
        row.prev_price_at = null;
        if (hasCurrency) row.price_currency = "USD";
        if (hasPending) { row.price_pending = null; row.price_pending_at = null; }
        return true;
      }
      return false;
    } catch (e) {
      console.warn("[VaultDex] continuity repair failed for", row.card_name, e && e.message);
      return false;
    }
  }

  /* One-shot repair flags (2026-09-25): every data repair runs exactly
   * once per browser via a persistent flag, set only after a fully
   * successful pass. A bare timestamp cutoff re-clears prices the fixed
   * code writes before the cutoff passes — wipe-looping them on every
   * collection read (this erased all graded prices nightly on 2026-09-25).
   * If anything fails the flag stays unset and the repair retries next
   * boot. The cutoffs in the predicates below still scope WHICH rows each
   * repair may touch; the flag scopes HOW OFTEN. */
  function repairDone(key) {
    try { return localStorage.getItem(key) === "1"; } catch (e) { return false; }
  }
  function markRepairDone(key) {
    try { localStorage.setItem(key, "1"); } catch (e) { /* ignored */ }
  }
  var ACCENT_REPAIR_FLAG = "vd_accent_repair_v1";
  var SETMATCH_REPAIR_FLAG = "vd_setmatch_repair_v1";

  function needsMissingSetRepair(row) {
    if (!row || !App.pkmn || typeof App.pkmn.pkmnMissingSet !== "function") return false;
    if (!App.pkmn.pkmnMissingSet(row.set_name, App.util.langOf(row))) return false;
    return !!(row.pkmn_id || row.market_price != null);
  }

  /* One-shot repair (2026-09-22): rows from Japanese sets PkmnPrices doesn't
   * carry (M6a, MC, SM1p) can hold a pkmn_id + market_price from the unsafe
   * number-only fallback — e.g. M6a Pikachu #017 priced as SV2D Clay Burst
   * #017, which ranked M6a cards at the top of the collection by value.
   * Some rows were priced without a pkmn_id, so any market_price on these
   * sets is cross-set residue too. Clear them all — id and price
   * fields plus mover history — while keeping quantity, ownership, variant,
   * images, and grading data untouched. Idempotent: rows already clean are
   * skipped, so later runs are a no-op. */
  async function repairMissingSetPrices(rows) {
    var u = App.auth.user;
    if (!u || !rows || !rows.length) return;
    var bad = rows.filter(needsMissingSetRepair);
    if (!bad.length) return;
    console.warn("[VaultDex] clearing cross-set prices from", bad.length, "unsupported-set row(s)");
    for (var i = 0; i < bad.length; i++) {
      var row = bad[i];
      try {
        var up = await App.sb
          .from("collection_items")
          .update({
            pkmn_id: null,
            market_price: null,
            price_source: null,
            price_updated_at: null,
            prev_price: null,
            prev_price_at: null
          })
          .eq("id", row.id)
          .eq("user_id", u.id);
        if (!up.error) {
          row.pkmn_id = null;
          row.market_price = null;
          row.price_source = null;
          row.price_updated_at = null;
          row.prev_price = null;
          row.prev_price_at = null;
        }
      } catch (e) {
        console.warn("[VaultDex] missing-set repair failed for", row.card_name, e && e.message);
      }
    }
  }

  /* Repair cutoffs — one-shot scoping (2026-09-24): the repairs below exist
   * to clear prices that could only have been written by the old buggy
   * matchers. Any price with price_updated_at at/after the fix's deploy was
   * written by the fixed code and must be left alone — without this, every
   * signed-in collection read re-wipes freshly repriced rows in sets whose
   * names never normalize equally (266 of 381 mapped sets, e.g. 151), so
   * they can never hold a price. Padded past the deploy to cover the Vercel
   * rollout + client clock skew; a row caught inside the padding is simply
   * repriced once more, then stable. Null/unparseable timestamps count as
   * old (fail toward clearing stale residue). */
  var ACCENT_REPAIR_CUTOFF_MS = Date.parse("2026-09-24T00:20:00Z");    /* 1fbc92e deployed 00:14:22Z */
  var SETMATCH_REPAIR_CUTOFF_MS = Date.parse("2026-09-24T01:00:00Z");  /* ce974ee deployed 00:41:20Z */
  var GRADED_REPAIR_CUTOFF_MS = Date.parse("2026-09-25T01:00:00Z");    /* graded exact-attribution fix, deploys ~00:20Z */
  function priceIsPostFix(row, cutoffMs) {
    var t = row.price_updated_at ? Date.parse(row.price_updated_at) : 0;
    return !(t < cutoffMs); /* NaN/0 -> false: old */
  }

  /* Pure predicate for the accent-fallback repair: the row's set name
   * normalizes differently now that normSetName strips accents. Under the
   * old accent-blind normalization the exact set+number match necessarily
   * failed for these rows, so any stored pkmn_id or market_price could only
   * have come from the number-only fallback — e.g. Pokémon GO Moltres #12
   * priced as Fossil Moltres ($196.25). Prices written after the accent fix
   * deployed are trusted and never re-cleared (see cutoffs above).
   * Exported for unit tests. */
  function needsAccentRepair(row) {
    if (!row || !App.pkmn || typeof App.pkmn.normSetName !== "function") return false;
    if (!row.pkmn_id && row.market_price == null) return false;
    if (priceIsPostFix(row, ACCENT_REPAIR_CUTOFF_MS)) return false;
    var s = String(row.set_name || "");
    if (!s) return false;
    /* The pre-fix normalization: lowercase + ": " cut, accents kept. */
    var cut = s.indexOf(": ");
    if (cut !== -1) s = s.slice(cut + 2);
    var oldNorm = s.trim().toLowerCase();
    return oldNorm !== App.pkmn.normSetName(row.set_name);
  }

  /* Pre-fix set-name normalization for the set-match repair predicate:
   * lowercase + ": " cut, accents KEPT — exactly what normSetName did
   * before the 2026-09-23 accent fix. Exported for unit tests. */
  function oldNormSetName(name) {
    var s = String(name || "");
    var cut = s.indexOf(": ");
    if (cut !== -1) s = s.slice(cut + 2);
    return s.trim().toLowerCase();
  }

  /* Pure predicate for the set-match repair: given a row and its mapped
   * PkmnPrices set entry, could the stored pkmn_id / market_price only
   * have come from the number-only fallback? Under the old normalization
   * the exact set+number match could only succeed when the provider name
   * normalized to the row's set name — anything else fell through to the
   * fallback (e.g. SV Professor's Research #190 as the $36.23 Professor
   * Program promo). Prices written after the set-scoped lookup deployed
   * are trusted and never re-cleared (see cutoffs above) — otherwise rows
   * in name-mismatched sets are wiped on every read and can never hold a
   * price. Exported for unit tests. */
  function setMatchNeedsRepair(row, entry) {
    if (!row) return false;
    if (!row.pkmn_id && row.market_price == null) return false;
    if (!entry || !entry.ppName) return false;
    if (priceIsPostFix(row, SETMATCH_REPAIR_CUTOFF_MS)) return false;
    return oldNormSetName(entry.ppName) !== oldNormSetName(row.set_name);
  }

  /* Pure predicate for the graded-attribution repair: gradedPrice() used
   * to fall back to unverified ("unknown"/"shared" attribution) eBay
   * comps when no exact-attribution comp existed, so graded rows could
   * hold fantasy prices — e.g. Latias & Latios GX PSA 10 at €5,496.45,
   * the median of six unknown-attribution German listings at
   * €1,313–€14,999. Any pkmnprices-graded price written before the
   * exact-only fix deployed could be poisoned; prices written after are
   * by the fixed lookup and are never re-cleared (see cutoffs above).
   * Exported for unit tests. */
  function gradedAttributionNeedsRepair(row) {
    if (!row) return false;
    if (row.price_source !== "pkmnprices-graded") return false;
    if (row.market_price == null) return false;
    return !priceIsPostFix(row, GRADED_REPAIR_CUTOFF_MS);
  }

  /* One-shot repair (2026-09-24): rows priced while set matching was
   * name-normalization-only hold cross-set prices from the number-only
   * fallback — e.g. Scarlet & Violet Professor's Research #190 priced as
   * the $36.23 Professor Program promo, because "SV01: Scarlet & Violet
   * Base Set" never normalized to "Scarlet & Violet". Any row whose set
   * now maps to a PkmnPrices set the OLD normalization couldn't match has
   * its poisoned pkmn_id cleared and is forced stale; the displayed price
   * is KEPT until the next refresh re-prices it set-scoped (continuity
   * guard). Rows in sets the old matcher DID match (e.g. "Fossil") are
   * untouched, as are unmapped sets. Quantity, ownership, variant, images,
   * and grading are untouched. One-shot via SETMATCH_REPAIR_FLAG; the
   * cutoff in setMatchNeedsRepair still scopes which rows qualify. */
  async function repairSetMatchPrices(rows) {
    var u = App.auth.user;
    if (!u || !rows || !rows.length) return;
    if (repairDone(SETMATCH_REPAIR_FLAG)) return;
    if (!App.pkmn || typeof App.pkmn.ppSetEntry !== "function") return;
    var bad = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row.pkmn_id && row.market_price == null) continue;
      var sid = row.set_id || "";
      if (!sid && row.card_id) {
        var dash = String(row.card_id).lastIndexOf("-");
        if (dash > 0) sid = row.card_id.slice(0, dash);
      }
      if (!sid) continue;
      var entry = null;
      try { entry = await App.pkmn.ppSetEntry(sid); } catch (e) { entry = null; }
      if (setMatchNeedsRepair(row, entry)) bad.push(row);
    }
    var ok = true;
    if (bad.length) {
      var hasCurrency = await ensurePriceCurrencyProbe();
      var hasPending = await ensurePricePendingProbe();
      console.warn("[VaultDex] forcing reprice (keeping displayed prices) for", bad.length, "set-match row(s)");
      for (var j = 0; j < bad.length; j++) {
        if (!await staleForReprice(u, bad[j], hasCurrency, hasPending)) ok = false;
      }
    }
    if (ok) markRepairDone(SETMATCH_REPAIR_FLAG);
  }

  /* One-shot repair (2026-09-24): rows holding a pkmnprices-graded price
   * from before the exact-attribution fix may be the median of
   * unverified comps — e.g. Latias & Latios GX PSA 10 at €5,496.45 from
   * six unknown-attribution German listings. The stored pkmn_id can be
   * wrong too (that row pointed at the German "Teams Sind Trumpf"
   * printing, set 2653, instead of the English Team Up printing), so it
   * is cleared and the row forced stale; the displayed price is KEPT
   * until the next refresh overwrites it with the fixed lookup
   * (continuity guard — the total never dips mid-repair):
   * exact-attribution comps keep their graded price, anything else falls
   * back to the raw Near Mint price with its explicit label. Quantity,
   * ownership, variant, images, and grading are untouched.
   *
   * One-shot via GRADED_REPAIR_FLAG (not the timestamp cutoff): the
   * cutoff alone re-clears prices the fixed code writes before the cutoff
   * passes, wipe-looping them on every collection read until the top of
   * the hour. The flag is set only after a fully successful pass; if
   * anything fails it retries on the next boot. */
  var GRADED_REPAIR_FLAG = "vd_graded_attribution_repaired_v1";
  async function repairGradedAttributionPrices(rows) {
    var u = App.auth.user;
    if (!u || !rows || !rows.length) return;
    if (repairDone(GRADED_REPAIR_FLAG)) return;
    var bad = rows.filter(gradedAttributionNeedsRepair);
    var ok = true;
    if (bad.length) {
      var hasCurrency = await ensurePriceCurrencyProbe();
      var hasPending = await ensurePricePendingProbe();
      console.warn("[VaultDex] forcing reprice (keeping displayed prices) for", bad.length, "graded row(s)");
      for (var i = 0; i < bad.length; i++) {
        if (!await staleForReprice(u, bad[i], hasCurrency, hasPending)) ok = false;
      }
    }
    if (ok) markRepairDone(GRADED_REPAIR_FLAG);
  }

  /* One-shot repair (2026-09-23): rows priced while normSetName was
   * accent-blind hold cross-set prices from the number-only fallback.
   * The poisoned pkmn_id is cleared and the row forced stale; the
   * displayed price is KEPT until the next refresh overwrites it with the
   * fixed matcher (continuity guard — no fake dip in the total or graph).
   * Quantity, ownership, variant, images, and grading are untouched.
   * One-shot via ACCENT_REPAIR_FLAG; the cutoff in needsAccentRepair
   * still scopes which rows qualify. */
  async function repairAccentFallbackPrices(rows) {
    var u = App.auth.user;
    if (!u || !rows || !rows.length) return;
    if (repairDone(ACCENT_REPAIR_FLAG)) return;
    var bad = rows.filter(needsAccentRepair);
    var ok = true;
    if (bad.length) {
      /* The currency column may not exist yet — only reset it when the
       * schema probe says it's there (same guard as the price writes). */
      var hasCurrency = await ensurePriceCurrencyProbe();
      var hasPending = await ensurePricePendingProbe();
      console.warn("[VaultDex] forcing reprice (keeping displayed prices) for", bad.length, "accent-fallback row(s)");
      for (var i = 0; i < bad.length; i++) {
        if (!await staleForReprice(u, bad[i], hasCurrency, hasPending)) ok = false;
      }
    }
    if (ok) markRepairDone(ACCENT_REPAIR_FLAG);
  }

  /* Backfill: rows that carry no pkmn_id (added before the per-variant
   * checkboxes existed, or while PkmnPrices was unreachable) are mapped to
   * their exact print-variant PkmnPrices record — name + set + number +
   * print variant — once. After that the row's pricing and owned-state are
   * exact. Runs lazily, only for rows that still lack a pkmn_id. */
  async function backfillPkmnIds(rows) {
    var u = App.auth.user;
    if (!u || !rows || !rows.length) return;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.pkmn_id) continue;
      /* Never re-poison: unsupported sets stay unpriced until the provider
       * carries them. */
      if (App.pkmn && typeof App.pkmn.pkmnMissingSet === "function" &&
          App.pkmn.pkmnMissingSet(row.set_name, App.util.langOf(row))) continue;
      try {
        var pv = App.tcg.printVariantForLabel(row.variant);
        var m = await App.pkmn.findVariantPrice({
          name: row.card_name,
          setName: row.set_name,
          setId: row.set_id,
          number: row.number,
          lang: App.util.langOf(row),
          pkmnLabel: pv.pkmnLabel,
          priceVariant: pv.priceVariant
        });
        if (!m) continue;
        var up = await App.sb
          .from("collection_items")
          .update({ pkmn_id: m.pkmnId })
          .eq("id", row.id)
          .eq("user_id", u.id);
        if (!up.error) row.pkmn_id = m.pkmnId;
      } catch (e) {
        console.warn("[VaultDex] pkmn_id backfill failed for", row.card_name, e && e.message);
      }
    }
  }

  /* Image healing: rowFromCard snapshots image_small/image_large at add
   * time, so a row added before a catalog image backfill (e.g. the EN
   * image backfill of 2026-09-18/19) keeps NULL images forever — the
   * collection tile and card modal render the row's stored URLs, not a
   * live catalog lookup. Fill the gaps from the local catalog on read.
   * Lazy: only rows still missing images trigger a set-file lookup, and
   * getSetCardList caches each set's snapshot. With persist, healed URLs
   * are written back to the row (owner pass only) so the fix is permanent;
   * cards with no catalog image at all (deliberate gaps like svp Terapagos
   * & Friends) are left alone — never rewritten, so no repeated writes
   * and no invented images. */
  async function backfillRowImages(rows, persist) {
    var missing = (rows || []).filter(function (r) {
      return r && r.card_id && !r.image_small;
    });
    if (!missing.length) return rows;
    var tcg = App.tcg;
    if (!tcg || typeof tcg.getSetCardList !== "function") return rows;
    var bySet = {};
    missing.forEach(function (r) {
      var sid = r.set_id || "";
      if (!sid) return;
      (bySet[sid] = bySet[sid] || []).push(r);
    });
    var healed = [];
    var setIds = Object.keys(bySet);
    for (var i = 0; i < setIds.length; i++) {
      var cards;
      try {
        cards = await tcg.getSetCardList(setIds[i]);
      } catch (e) {
        console.warn("[VaultDex] image backfill: set lookup failed for", setIds[i], e && e.message);
        continue;
      }
      var group = bySet[setIds[i]];
      for (var j = 0; j < group.length; j++) {
        var row = group[j];
        var hit = (cards || []).filter(function (c) {
          return c && String(c.id) === String(row.card_id);
        })[0];
        if (!hit || !hit.images || !hit.images.small) continue;
        row.image_small = hit.images.small;
        if (hit.images.large) row.image_large = hit.images.large;
        healed.push(row);
      }
    }
    if (persist && healed.length && App.sb) {
      var u = App.auth && App.auth.user;
      for (var k = 0; k < healed.length; k++) {
        var hr = healed[k];
        try {
          var q = App.sb.from("collection_items")
            .update({ image_small: hr.image_small, image_large: hr.image_large })
            .eq("id", hr.id);
          if (u && u.id) q = q.eq("user_id", u.id);
          await q;
        } catch (e) {
          console.warn("[VaultDex] image backfill: write-back failed for", hr.card_name, e && e.message);
        }
      }
    }
    return rows;
  }

  /* One-time migration: rows written before the TCGdex switch carry the old
   * catalog's ids (e.g. set "me2pt5", card "me2pt5-276"). Rewrite them to
   * TCGdex ids ("me02.5", "me02.5-276") so set pages, owned checkboxes, and
   * progress counters match again. Runs once per browser (localStorage
   * flag); if anything fails it simply retries on the next boot. */
  var LEGACY_SET_IDS = {
    "me2pt5": { setId: "me02.5", imgBase: "https://assets.tcgdex.net/en/me/me02.5" }
  };
  var LEGACY_FLAG = "vd_legacy_ids_migrated_v1";

  async function migrateLegacyCatalogIds() {
    var u = App.auth.user;
    if (!u) return;
    try {
      if (localStorage.getItem(LEGACY_FLAG)) return;
    } catch { /* no storage: run each boot, harmless */ }
    var res;
    try {
      res = await App.sb.from("collection_items").select("id,card_id").eq("user_id", u.id);
    } catch (e) {
      console.warn("[VaultDex] legacy id migration: select failed:", e && e.message);
      return;
    }
    if (res.error) {
      console.warn("[VaultDex] legacy id migration: select failed:", res.error.message);
      return;
    }
    var rows = (res.data || []).filter(function (r) {
      var dash = String(r.card_id || "").lastIndexOf("-");
      var sid = dash > 0 ? r.card_id.slice(0, dash) : "";
      return !!LEGACY_SET_IDS[sid];
    });
    if (!rows.length) {
      try { localStorage.setItem(LEGACY_FLAG, "1"); } catch { /* ignored */ }
      return;
    }
    var ok = true;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var dash = String(r.card_id).lastIndexOf("-");
      var oldSet = r.card_id.slice(0, dash);
      var map = LEGACY_SET_IDS[oldSet];
      var n = r.card_id.slice(dash + 1).padStart(3, "0");
      try {
        var up = await App.sb.from("collection_items").update({
          card_id: map.setId + "-" + n,
          set_id: map.setId,
          image_small: map.imgBase + "/" + n + "/low.png",
          image_large: map.imgBase + "/" + n + "/high.png"
        }).eq("id", r.id).eq("user_id", u.id);
        if (up.error) { ok = false; console.warn("[VaultDex] legacy id migration: update failed:", up.error.message); }
      } catch (e) {
        ok = false;
        console.warn("[VaultDex] legacy id migration: update failed:", e && e.message);
      }
    }
    if (ok) {
      try { localStorage.setItem(LEGACY_FLAG, "1"); } catch { /* ignored */ }
    }
  }

  /* Bulk add: one existence lookup, batched inserts, individual qty bumps. */
  async function bulkAdd(cards, onProgress) {
    var u = needUser();
    if (!u) return false;
    if (!cards.length) return true;

    var ids = cards.map(function (c) { return c.id; });
    var ex = await App.sb
      .from("collection_items")
      .select("id,card_id,variant,quantity")
      .eq("user_id", u.id)
      .in("card_id", ids);
    if (ex.error) throw ex.error;
    var existing = {};
    (ex.data || []).forEach(function (r) { existing[r.card_id + "|" + r.variant] = r; });

    var toInsert = [];
    var toBump = [];
    for (var ci = 0; ci < cards.length; ci++) {
      var card = cards[ci];
      var variant = defaultVariant(card);
      var hit = existing[card.id + "|" + variant];
      if (hit) toBump.push(hit);
      else toInsert.push(await rowFromCard(u, card, variant, 1));
    }

    if (toInsert.length) {
      var ins = await App.sb.from("collection_items").insert(toInsert);
      if (ins.error) throw ins.error;
    }
    var done = toInsert.length;
    for (var i = 0; i < toBump.length; i++) {
      var b = toBump[i];
      var up = await App.sb
        .from("collection_items")
        .update({ quantity: b.quantity + 1 })
        .eq("id", b.id);
      if (up.error) throw up.error;
      done++;
      if (onProgress) onProgress(done, cards.length);
    }
    if (onProgress) onProgress(cards.length, cards.length);
    App.emit("collection:changed", { cardId: null });
    return true;
  }

  async function setQuantity(id, qty) {
    var u = needUser();
    if (!u) return false;
    if (qty <= 0) return remove(id);
    var res = await App.sb
      .from("collection_items")
      .update({ quantity: qty })
      .eq("id", id)
      .eq("user_id", u.id);
    if (res.error) throw res.error;
    /* Views (tile badges, owned-count lines) refresh off this event — the
     * card modal's live stepper writes through setQuantity, so it must
     * emit just like addItem/remove do. */
    var cardId = null;
    try {
      var lk = await App.sb.from("collection_items").select("card_id").eq("id", id).eq("user_id", u.id).maybeSingle();
      if (lk.data) cardId = lk.data.card_id;
    } catch { /* best effort; views fall back to a full refresh */ }
    App.emit("collection:changed", { cardId: cardId });
    return true;
  }

  /* Undo support for the card modal's live stepper: re-inserts a previously
   * removed row verbatim (original quantity, pricing, pkmn_id, slab) instead
   * of re-adding it through addItem, which would re-resolve prices. The
   * snapshot is a row object as selected from collection_items; the id is
   * dropped so the database assigns a fresh one. */
  async function restoreRow(snapshot) {
    var u = needUser();
    if (!u) return false;
    var row = Object.assign({}, snapshot);
    delete row.id;
    row.user_id = u.id;
    var ins = await App.sb.from("collection_items").insert(row);
    if (ins.error) throw ins.error;
    App.emit("collection:changed", { cardId: row.card_id || null });
    return true;
  }

  async function remove(id) {
    var u = needUser();
    if (!u) return false;
    var cardId = null;
    try {
      var lookup = await App.sb.from("collection_items").select("card_id").eq("id", id).eq("user_id", u.id).maybeSingle();
      if (lookup.data) cardId = lookup.data.card_id;
    } catch { /* best effort; views fall back to a full refresh */ }
    var res = await App.sb
      .from("collection_items")
      .delete()
      .eq("id", id)
      .eq("user_id", u.id);
    if (res.error) throw res.error;
    App.emit("collection:changed", { cardId: cardId });
    return true;
  }

  /* Graded rows re-price from company+grade eBay sold comps, never from
   * raw Near Mint. Resolves the PkmnPrices id when the row doesn't carry
   * one yet. Returns the gradedPrice() shape or null (row keeps its
   * existing price on miss — never clobber a real graded price). */
  async function gradedPriceForRow(row) {
    var lang = App.util.langOf(row);
    var gid = row.pkmn_id;
    if (!gid) {
      var number = row.number;
      if (!number) {
        var m = String(row.card_id || "").match(/-([A-Za-z0-9]+)$/);
        number = m ? m[1] : null;
      }
      if (row.card_name && number) {
        gid = await App.pkmn.findCardId({
          name: row.card_name,
          setName: row.set_name,
          number: number,
          lang: lang,
          setId: row.set_id
        });
      }
    }
    if (!gid) return null;
    return App.pkmn.gradedPrice(gid, row.grading_company, row.grade, { lang: lang });
  }

  /* Pure: on a graded lookup miss (no exact company+grade comps), decide
   * the refresh fallback. A never-priced row falls back to raw Near Mint
   * ("raw") so the card isn't invisible forever; a row that already holds
   * a price keeps it ("keep") — a temporary comp drought must never
   * downgrade a real graded price to raw. Exported for unit tests. */
  function gradedMissFallback(row) {
    return (row && row.market_price == null) ? "raw" : "keep";
  }

  /* Re-fetch market prices via PkmnPrices, one row at a time.
   * Each row is mapped to its exact printing by set + card number, and the
   * price picked is always the Near Mint row (USD preferred) — except
   * graded rows, which re-price from exact company+grade eBay sold comps. */
  async function refreshPrices(onProgress) {
    var u = needUser();
    if (!u) return null;
    var all = await list();
    if (!all || !all.length) return { updated: 0, at: new Date().toISOString() };

    /* Incremental: only rows whose own price is missing or older than 24h.
     * A full pass over thousands of rows would take over an hour. */
    var nowMs = Date.now();
    var items = all.filter(function (row) { return needsPriceRefresh(row, nowMs); });
    if (!items.length) return { updated: 0, at: new Date().toISOString() };
    /* Most visible cards first: a partial pass still fixes the top of the
     * collection (see sortRefreshQueue). */
    items = sortRefreshQueue(items);

    var updated = 0;
    var now = new Date().toISOString();
    var rateLimited = false;

    /* One tiny query per pass: learn whether price_currency exists before
     * writing it (Vedant applies the migration in the dashboard). */
    await ensurePriceCurrencyProbe();
    /* And whether the plausibility-quarantine columns exist. */
    await ensurePricePendingProbe();

    for (var i = 0; i < items.length && !rateLimited; i++) {
      var row = items[i];
      var attempts = 0;
      while (attempts < 2) {
        attempts++;
        try {
          /* Graded rows price from exact company+grade eBay comps
           * (price_source "pkmnprices-graded"); everything else prices
           * Near Mint raw. A graded miss leaves the row untouched rather
           * than overwriting a real graded price with raw. */
          var p = null;
          var src = "pkmnprices";
          if (row.grading_company && row.grade) {
            p = await gradedPriceForRow(row);
            if (p && typeof p.price === "number") {
              src = "pkmnprices-graded";
            } else {
              /* Graded miss: no exact company+grade eBay comps. A row that
               * already holds a price keeps it — never downgrade a real
               * graded price to raw when comps temporarily vanish. A
               * never-priced row falls back to raw Near Mint so the card
               * isn't invisible forever (2026-09-25: two PSA 10 Japanese
               * promos sat at null for a day because the refresh had no
               * fallback). Downstream UI labels it via price_source
               * "pkmnprices" on a graded row = raw fallback, no comps. */
              p = (gradedMissFallback(row) === "raw") ? await App.pkmn.priceForRow(row) : null;
              if (!(p && typeof p.price === "number")) p = null;
            }
          } else {
            p = await App.pkmn.priceForRow(row);
          }
          if (p && typeof p.price === "number") {
            /* Plausibility gate: an order-of-magnitude swing on first
             * sight is parked, not written (see pricePlausibility). */
            var gate = pricePlausibility(row, p.price);
            var update;
            var held = gate.hold && HAS_PRICE_PENDING;
            if (held) {
              update = {
                price_pending: Math.round(p.price * 100) / 100,
                price_pending_at: now,
                price_updated_at: now /* not stale: re-check on the next cycle, not every visit */
              };
              console.warn("[VaultDex] holding implausible price for", row.card_name,
                ": candidate", p.price, "vs stored", row.market_price, "- parked for confirmation");
            } else {
              if (gate.hold) {
                console.warn("[VaultDex] plausibility guard inactive (run supabase/migration-price-pending.sql); writing extreme price for", row.card_name, p.price, "vs", row.market_price);
              }
              update = moverUpdate(row, p.price, src, now, p.currency);
              if (HAS_PRICE_PENDING) { update.price_pending = null; update.price_pending_at = null; }
            }
            var up = await App.sb
              .from("collection_items")
              .update(update)
              .eq("id", row.id);
            if (!up.error && !held) updated++;
          }
          break;
        } catch (e) {
          if (e && e.notConfigured) throw e; // surface: user must add the API key
          if (e && e.status === 429) {
            // Daily credit budget exhausted (or throttled): stop the pass
            // cleanly instead of burning one retry per row. Unpriced rows
            // keep their missing price and are picked up on the next visit.
            console.warn("[VaultDex] price refresh rate-limited; stopping this pass.");
            rateLimited = true;
            break;
          }
          // One retry for transient failures (network/timeout): HTTP errors
          // carry a status and are final, so they don't burn a retry.
          if (attempts < 2 && !(e && e.status)) {
            console.warn("[VaultDex] price refresh failed for", row.card_name, e && e.message, "— retrying once");
            continue;
          }
          console.warn("[VaultDex] price refresh failed for", row.card_name, e && e.message);
          break;
        }
      }
      if (onProgress) onProgress(i + 1, items.length);
      await new Promise(function (r) { setTimeout(r, 1200); }); // gentle pacing: the Pro plan budgets 20k credits/day, not a per-minute tier — keep requests spread out
    }
    // Fresh prices = fresh history point for the value-over-time chart.
    try { await recordValueSnapshot(); } catch { /* already warned inside */ }
    return { updated: updated, at: now };
  }

  /* ---- value history -------------------------------------------------
   * One snapshot row per owner per day (UTC). recordValueSnapshot upserts
   * today's row from the current stored prices; valueHistory reads the
   * series for the chart (public for the owner's rows, like listPublic).
   * ------------------------------------------------------------------ */
  function totals(items) {
    var value = 0, count = 0;
    (items || []).forEach(function (it) {
      var q = Number(it.quantity) || 1;
      count += q;
      if (typeof it.market_price === "number") value += it.market_price * q;
    });
    return { value: value, count: count };
  }

  /* Pure: is today's total sane enough to record as a value-history
   * point? A pricing bug must never carve a fake cliff (or spike) into
   * the graph: a collapse to under 60% of the previous point, or a
   * >2.5x spike with no real card growth, is skipped — a gap in the
   * graph is honest, a cliff is a lie. The next sane pass records
   * normally (the upsert overwrites today's row). Exported for tests. */
  function snapshotLooksSane(prevTotal, prevCount, total, count) {
    if (!(prevTotal > 0)) return true;
    if (total < prevTotal * 0.6) return false;
    if (total > prevTotal * 2.5 && !(count > prevCount * 1.1)) return false;
    return true;
  }

  async function recordValueSnapshot() {
    var u = App.auth.user;
    if (!u) return null;
    try {
      var items = await list();
      var t = totals(items);
      var total = Math.round(t.value * 100) / 100;
      /* Graph guard (2026-09-25): never record a history point that
       * collapses the graph on bad data — e.g. the graded repair that
       * nulled every graded price recorded $12,669.87, halving the
       * series overnight on zero market movement. */
      try {
        var hist = await App.sb
          .from("collection_value_snapshots")
          .select("day,total_value,card_count")
          .eq("user_id", u.id)
          .order("day", { ascending: false })
          .limit(2);
        if (!hist.error && hist.data && hist.data.length) {
          var todayStr = new Date().toISOString().slice(0, 10);
          var prev = null;
          for (var hi = 0; hi < hist.data.length; hi++) {
            if (hist.data[hi].day !== todayStr) { prev = hist.data[hi]; break; }
          }
          if (prev && !snapshotLooksSane(prev.total_value, prev.card_count, total, t.count)) {
            console.warn("[VaultDex] skipping value snapshot: total", total,
              "fails sanity vs previous", prev.total_value, "on", prev.day, "- bug-guard, not a market move");
            return null;
          }
        }
      } catch (e) { /* history check failed: record anyway, don't lose the point */ }
      var res = await App.sb
        .from("collection_value_snapshots")
        .upsert({
          user_id: u.id,
          total_value: total,
          card_count: t.count
        }, { onConflict: "user_id,day" });
      if (res.error) throw res.error;
      // One-shot vault-value milestone celebrations (owner only; the
      // achievements module guards, dedupes, and toasts internally).
      try { if (App.achievements) App.achievements.checkValueMilestones(t.value); } catch { /* garnish */ }
      return true;
    } catch (e) {
      console.warn("[VaultDex] value snapshot failed:", e && e.message);
      return null;
    }
  }

  async function valueHistory() {
    var ownerId;
    if (App.auth.user && App.auth.isOwner && App.auth.isOwner()) {
      ownerId = App.auth.user.id;
    } else {
      ownerId = (window.APP_CONFIG && window.APP_CONFIG.OWNER_USER_ID) || "";
    }
    if (!ownerId || ownerId.indexOf("00000000") === 0) return [];
    try {
      var res = await App.sb
        .from("collection_value_snapshots")
        .select("total_value, card_count, day")
        .eq("user_id", ownerId)
        .order("day", { ascending: true })
        .limit(365);
      if (res.error) throw res.error;
      return res.data || [];
    } catch (e) {
      console.warn("[VaultDex] value history failed:", e && e.message);
      return [];
    }
  }

  App.collection = {
    list: list,
    listPublic: listPublic,
    addItem: addItem,
    bulkAdd: bulkAdd,
    setQuantity: setQuantity,
    remove: remove,
    restoreRow: restoreRow,
    refreshPrices: refreshPrices,
    recordValueSnapshot: recordValueSnapshot,
    valueHistory: valueHistory,
    totals: totals,
    backfillPkmnIds: backfillPkmnIds,
    backfillRowImages: backfillRowImages,
    migrateLegacyCatalogIds: migrateLegacyCatalogIds,
    defaultVariant: defaultVariant,
    needUser: needUser,
    /* Pure helpers, exported for unit tests. */
    clampQuantity: clampQuantity,
    rowSetId: rowSetId,
    needsPriceRefresh: needsPriceRefresh,
    sortRefreshQueue: sortRefreshQueue,
    moverUpdate: moverUpdate,
    fetchAllPages: fetchAllPages,
    legacyMarket: legacyMarket,
    findMatchingRow: findMatchingRow,
    needsMissingSetRepair: needsMissingSetRepair,
    needsAccentRepair: needsAccentRepair,
    oldNormSetName: oldNormSetName,
    setMatchNeedsRepair: setMatchNeedsRepair,
    gradedAttributionNeedsRepair: gradedAttributionNeedsRepair,
    repairGradedAttributionPrices: repairGradedAttributionPrices,
    repairAccentFallbackPrices: repairAccentFallbackPrices,
    repairSetMatchPrices: repairSetMatchPrices,
    pricePlausibility: pricePlausibility,
    snapshotLooksSane: snapshotLooksSane,
    gradedMissFallback: gradedMissFallback,
    /* Test seam: force the price_currency capability flag (the real value
     * comes from the runtime probe of the live schema). */
    _setPriceCurrencySupport: function (v) { HAS_PRICE_CURRENCY = !!v; }
  };
})();
