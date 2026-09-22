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

  /* Mover history (Feature 4): NULL prev_price means "no mover data" — a
   * row that was never refreshed, or whose price never moved, shows no
   * mover data rather than a fake zero. Only when the row had a real
   * price before AND the new price differs do we record the old price
   * as prev_price. Returns the update object, or null when the new
   * price isn't a real number. */
  function moverUpdate(row, newPrice, priceSource, now) {
    if (typeof newPrice !== "number") return null;
    var update = { market_price: newPrice, price_source: priceSource, price_updated_at: now };
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
          lang: setLang
        });
        var g = gid ? await App.pkmn.gradedPrice(gid, gradingCompany, gradingGrade, { lang: setLang }) : null;
        if (g && typeof g.price === "number") {
          market = g.price;
          priceSource = "pkmnprices-graded";
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
          number: card.number,
          variant: variant,
          lang: setLang
        });
        if (q && typeof q.price === "number") {
          market = q.price;
          priceSource = "pkmnprices";
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
    return {
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

  /* One-shot repair (2026-09-22): rows from Japanese sets PkmnPrices doesn't
   * carry (M6a, MC, SM1p) can hold a pkmn_id + market_price from the unsafe
   * number-only fallback — e.g. M6a Pikachu #017 priced as SV2D Clay Burst
   * #017, which ranked M6a cards at the top of the collection by value.
   * Those IDs and prices were never real. Clear them all — id and price
   * fields plus mover history — while keeping quantity, ownership, variant,
   * images, and grading data untouched. Idempotent: rows already clean are
   * skipped, so later runs are a no-op. */
  async function repairMissingSetPrices(rows) {
    var u = App.auth.user;
    if (!u || !rows || !rows.length || !App.pkmn || typeof App.pkmn.pkmnMissingSet !== "function") return;
    var bad = rows.filter(function (r) {
      return r && r.pkmn_id && App.pkmn.pkmnMissingSet(r.set_name, App.util.langOf(r));
    });
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
          lang: lang
        });
      }
    }
    if (!gid) return null;
    return App.pkmn.gradedPrice(gid, row.grading_company, row.grade, { lang: lang });
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

    var updated = 0;
    var now = new Date().toISOString();
    var rateLimited = false;

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
            if (p && typeof p.price === "number") src = "pkmnprices-graded";
            else p = null;
          } else {
            p = await App.pkmn.priceForRow(row);
          }
          if (p && typeof p.price === "number") {
            var update = moverUpdate(row, p.price, src, now);
            var up = await App.sb
              .from("collection_items")
              .update(update)
              .eq("id", row.id);
            if (!up.error) updated++;
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

  async function recordValueSnapshot() {
    var u = App.auth.user;
    if (!u) return null;
    try {
      var items = await list();
      var t = totals(items);
      var res = await App.sb
        .from("collection_value_snapshots")
        .upsert({
          user_id: u.id,
          total_value: Math.round(t.value * 100) / 100,
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
    moverUpdate: moverUpdate,
    fetchAllPages: fetchAllPages,
    legacyMarket: legacyMarket,
    findMatchingRow: findMatchingRow
  };
})();
