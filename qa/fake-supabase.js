/* VaultDex QA — fake Supabase backend for signed-in Playwright tests.
 *
 * Why this exists: CI must never hold real credentials, so signed-in flows
 * (set-page checkboxes, card modal add, variant merging) had zero automated
 * coverage — yet every historical collection bug lived exactly there.
 *
 * How it works:
 *  1. A fake owner session is injected into localStorage before any app
 *     script runs, so the REAL auth.js init() picks it up and the app
 *     renders as the signed-in owner (isOwner() === true).
 *  2. All /rest/v1/* traffic is intercepted and served by an in-memory
 *     fake PostgREST (select/eq/is/in/order/range + insert/upsert/update/
 *     delete), so the REAL supabase-js query builder runs unmodified.
 *  3. Pricing lookups (App.pkmn.*) are stubbed to null after load, so no
 *     PkmnPrices credits are spent and no network leaves the test.
 *
 * Tests get the live `db` object to seed rows and assert on writes.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* Read the Supabase URL + owner id from the app's own config so the fake
 * can never drift from what the app actually uses. */
function appConfig() {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "config.js"), "utf8");
  const url = (src.match(/SUPABASE_URL:\s*"([^"]+)"/) || [])[1] || "";
  const owner = (src.match(/OWNER_USER_ID:\s*"([^"]+)"/) || [])[1] || "";
  const ref = url.replace(/^https?:\/\//, "").split(".")[0];
  return { url, owner, storageKey: `sb-${ref}-auth-token` };
}

function makeSession(ownerId) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: "vaultdex-qa-fake-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "vaultdex-qa-fake-refresh",
    user: {
      id: ownerId,
      aud: "authenticated",
      role: "authenticated",
      email: "owner@vaultdex.test",
      user_metadata: { full_name: "QA Owner" },
      app_metadata: { provider: "google" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  };
}

/* ---------- in-memory PostgREST ---------- */

const SKIP_PARAMS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function splitOp(raw) {
  const dot = raw.indexOf(".");
  if (dot === -1) return ["eq", raw];
  return [raw.slice(0, dot), raw.slice(dot + 1)];
}

function parseList(raw) {
  // "(a,b,\"c,d\")" -> ["a","b","c,d"]
  const inner = raw.replace(/^\(/, "").replace(/\)$/, "");
  const out = [];
  let cur = "", inQ = false;
  for (const ch of inner) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur !== "" || out.length) out.push(cur);
  return out;
}

function testFilter(cell, op, raw) {
  switch (op) {
    case "eq": return String(cell) === raw;
    case "neq": return String(cell) !== raw;
    case "is":
      if (raw === "null") return cell === null || cell === undefined;
      if (raw === "true") return cell === true;
      if (raw === "false") return cell === false;
      return String(cell) === raw;
    case "in": return parseList(raw).some(v => String(cell) === v);
    case "gte": return Number(cell) >= Number(raw);
    case "gt": return Number(cell) > Number(raw);
    case "lte": return Number(cell) <= Number(raw);
    case "lt": return Number(cell) < Number(raw);
    default: return true; // unknown op: don't filter (fail open, like tests should notice)
  }
}

function applyFilters(rows, params) {
  const filters = [];
  for (const [k, v] of params) {
    if (SKIP_PARAMS.has(k)) continue;
    const [op, raw] = splitOp(v);
    filters.push([k, op, raw]);
  }
  if (!filters.length) return rows.slice();
  return rows.filter(r => filters.every(([k, op, raw]) => testFilter(r[k], op, raw)));
}

function applyOrder(rows, params) {
  const spec = params.get("order");
  if (!spec) return rows;
  const keys = spec.split(",").map(s => {
    const parts = s.split(".");
    return { col: parts[0], desc: parts[1] === "desc" };
  });
  return rows.slice().sort((a, b) => {
    for (const { col, desc } of keys) {
      const av = a[col], bv = b[col];
      const cmp = av == null ? (bv == null ? 0 : -1) : bv == null ? 1
        : av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp) return desc ? -cmp : cmp;
    }
    return 0;
  });
}

function applyRange(rows, params) {
  const off = parseInt(params.get("offset") || "0", 10) || 0;
  const lim = params.get("limit");
  return lim == null ? rows.slice(off) : rows.slice(off, off + parseInt(lim, 10));
}

function project(rows, select) {
  if (!select || select === "*") return rows.map(r => ({ ...r }));
  const cols = select.split(",").map(s => s.trim()).filter(Boolean);
  return rows.map(r => {
    const o = {};
    for (const c of cols) o[c] = r[c];
    return o;
  });
}

function createDb(seedRows) {
  const tables = {
    collection_items: (seedRows || []).map(r => ({ ...r })),
    profiles: [],
    wishlist: []
  };
  let nextId = 1;
  for (const r of tables.collection_items) {
    if (typeof r.id === "number" && r.id >= nextId) nextId = r.id + 1;
  }
  return { tables, nextId: () => nextId++ };
}

async function handleRest(route, db) {
  const req = route.request();
  const url = new URL(req.url());
  const table = url.pathname.split("/").pop();
  const params = url.searchParams;
  const json = body =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  if (!db.tables[table]) {
    return route.fulfill({ status: 404, contentType: "application/json", body: '{"message":"table not found"}' });
  }

  try {
    if (req.method() === "GET") {
      let rows = applyFilters(db.tables[table], params);
      rows = applyOrder(rows, params);
      rows = applyRange(rows, params);
      return json(project(rows, params.get("select")));
    }
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() || "null");
      const prefer = (req.headers()["prefer"] || "").toLowerCase();
      const isUpsert = prefer.includes("resolution=merge-duplicates");
      const onConflict = params.get("on_conflict") || "id";
      const incoming = Array.isArray(body) ? body : [body];
      const out = [];
      for (const obj of incoming) {
        const row = { ...obj };
        if (row.id == null) row.id = db.nextId();
        if (row.added_at == null) row.added_at = new Date().toISOString();
        if (isUpsert) {
          const hit = db.tables[table].find(r => String(r[onConflict]) === String(row[onConflict]));
          if (hit) { Object.assign(hit, row); out.push({ ...hit }); continue; }
        }
        db.tables[table].push(row);
        out.push({ ...row });
      }
      return json(out);
    }
    if (req.method() === "PATCH") {
      const patch = JSON.parse(req.postData() || "{}");
      const rows = applyFilters(db.tables[table], params);
      rows.forEach(r => Object.assign(r, patch));
      return json(rows.map(r => ({ ...r })));
    }
    if (req.method() === "DELETE") {
      const rows = applyFilters(db.tables[table], params);
      const gone = new Set(rows);
      db.tables[table] = db.tables[table].filter(r => !gone.has(r));
      return json(rows.map(r => ({ ...r })));
    }
    return route.fulfill({ status: 405, body: "method not allowed" });
  } catch (e) {
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: String(e && e.message || e) }) });
  }
}

/* Serve single-card catalog lookups (App.tcg.getCard -> api.tcgdex.net)
/ from the local snapshots, so modal/detail flows work with zero network.
 * EN cards hit the live API in production; JA cards prefer snapshots. */
const snapCache = new Map();
function snapFor(lang, setId) {
  const key = lang + ":" + setId;
  if (!snapCache.has(key)) {
    const p = lang === "ja"
      ? path.join(__dirname, "..", "data", "tcgdex", "sets", "ja", setId + ".json")
      : path.join(__dirname, "..", "data", "tcgdex", "sets", setId + ".json");
    let snap = null;
    try { snap = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { /* no snapshot */ }
    snapCache.set(key, snap);
  }
  return snapCache.get(key);
}

async function installCatalogCards(page) {
  await page.route("https://api.tcgdex.net/**", route => {
    const m = route.request().url().match(/^https:\/\/api\.tcgdex\.net\/v2\/(en|ja)\/cards\/([^/?#]+)/);
    if (m) {
      const lang = m[1], cardId = decodeURIComponent(m[2]);
      const dash = cardId.lastIndexOf("-");
      const setId = dash > 0 ? cardId.slice(0, dash) : "";
      const snap = setId && snapFor(lang, setId);
      const card = snap && (snap.cards || []).find(c => c.id === cardId);
      if (card) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(card) });
      }
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: '{"message":"not found"}' });
  });
}

/* Install the fake backend on a Playwright page. Call BEFORE page.goto().
 * Returns { db, config } — db.tables.collection_items is the live store. */
async function installFakeSupabase(page, seedRows) {
  const config = appConfig();
  const db = createDb(seedRows);
  const sessionJson = JSON.stringify(makeSession(config.owner));

  // Fake owner session in localStorage before any app script runs. The poll
  // is needed because addInitScript runs before js/config.js defines APP_CONFIG;
  // auth.init() runs on DOMContentLoaded, long after this resolves.
  await page.addInitScript(({ storageKey, sessionJson }) => {
    try { window.localStorage.setItem(storageKey, sessionJson); } catch (e) { /* ignore */ }
  }, { storageKey: config.storageKey, sessionJson });

  await page.route("**/rest/v1/**", route => handleRest(route, db));
  // Defensive: nothing in the tested flows should hit GoTrue over the
  // network, but never let a test touch the real auth endpoint.
  await page.route("**/auth/v1/**", route =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  // Card-detail lookups (api.tcgdex.net) resolve from local snapshots.
  await installCatalogCards(page);

  return { db, config };
}

/* After load: neutralize every PkmnPrices lookup so tests spend zero
 * credits and make zero external calls. Call before interacting. */
async function stubPricing(page) {
  await page.evaluate(() => {
    ["findVariantPrice", "priceForRow", "nearMintPrice", "findCardId", "gradedPrice", "refreshRowPrice"]
      .forEach(k => { if (window.App && App.pkmn && typeof App.pkmn[k] === "function") App.pkmn[k] = async () => null; });
  });
}

/* Signed-in goto helper: installs the fake, navigates, waits for the app
 * to finish booting as owner, then stubs pricing. */
async function gotoSignedIn(page, path, seedRows) {
  const installed = await installFakeSupabase(page, seedRows);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.App && App.auth && App.auth.isOwner && App.auth.isOwner(), null, { timeout: 15000 });
  await stubPricing(page);
  return installed;
}

module.exports = { installFakeSupabase, stubPricing, gotoSignedIn, appConfig, createDb };
