/* VaultDex upstream contract test — PkmnPrices response shape.
 *
 * PkmnPrices has already changed its response shape once (the double-encoded
 * JSON the app unwraps in js/pkmn.js), which broke pricing until the parser
 * was fixed. This spec runs in the DAILY scheduled workflow against the
 * production /api/pkmnprices proxy and asserts the shapes the app actually
 * reads, so the next drift is caught by CI before the Sunday refresh runs
 * into it.
 *
 * Cost: 2 API credits per run (one 1-item search + one card detail) out of
 * the 20,000/day Pro budget. Runs against production ONLY — it is skipped
 * whenever BASE_URL is local, because the local static server has no /api
 * routes and PR CI must stay secret-free.
 */
"use strict";

const { test, expect } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8000";
const isLocal = /localhost|127\.0\.0\.1/.test(BASE);

test.describe("PkmnPrices upstream contract", () => {
  test.skip(isLocal, "contract test runs against the deployed proxy only");

  // The deployed proxy admits browser callers by Referer/Origin host. This
  // is the app's own proxy and budget; the check exists to keep third
  // parties out, not the app's own CI.
  const headers = { Referer: "https://vaultdex-three.vercel.app/" };

  test("GET /v1/cards returns a data array of card records", async ({ request }) => {
    const resp = await request.get(BASE + "/api/pkmnprices/v1/cards", {
      headers,
      params: { name: "Pikachu", per_page: 1 },
    });
    expect(resp.status(), "proxy should admit the browser-caller check").toBe(200);
    const json = await resp.json();
    // The double-encoded-JSON regression: data must be an array, not a string.
    expect(Array.isArray(json.data), "json.data must be an array").toBe(true);
    expect(json.data.length).toBeGreaterThan(0);
    const card = json.data[0];
    expect(typeof card.id).toBe("string");
    expect(typeof card.name).toBe("string");
    expect(card.number, "card.number must be present (set matching)").toBeDefined();
    expect(card.set && typeof card.set.name, "card.set.name must be present").toBe("string");
  });

  test("GET /v1/cards/{id} returns a prices array the refresh loop reads", async ({
    request,
  }) => {
    const search = await request.get(BASE + "/api/pkmnprices/v1/cards", {
      headers,
      params: { name: "Pikachu", per_page: 1 },
    });
    const id = (await search.json()).data[0].id;

    const resp = await request.get(BASE + "/api/pkmnprices/v1/cards/" + encodeURIComponent(id), {
      headers,
    });
    expect(resp.status()).toBe(200);
    const card = await resp.json();
    // js/pkmn.js reads card.prices[] with condition + market_price.
    expect(Array.isArray(card.prices), "card.prices must be an array").toBe(true);
    for (const p of card.prices.slice(0, 5)) {
      expect(typeof p.condition).toBe("string");
      expect(p.market_price === null || typeof p.market_price === "number").toBe(true);
    }
  });
});
