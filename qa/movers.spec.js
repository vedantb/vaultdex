/* VaultDex — price movers vs card dialog agreement.
 *
 * Regression for the movers/dialog price mismatch: the mover tile shows the
 * collection row's PkmnPrices price (prev_price → market_price) while the
 * dialog's price table shows TCGPlayer catalog data — different providers —
 * and the row currency was dropped entirely (EUR rows rendered as "$").
 * This spec seeds a EUR mover row, opens the tile, and asserts the dialog's
 * owned section shows the SAME number in the SAME currency as the tile,
 * plus the catalog table is labeled as a TCGPlayer reference.
 */
"use strict";

const { test, expect } = require("@playwright/test");
const { gotoSignedIn, appConfig } = require("./fake-supabase");

const OWNER = appConfig().owner;

/* Local-server only: the suite injects a fake owner session and intercepts
 * every backend route, so it must never run against a real deployment. */
test.skip(
  !!process.env.BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.BASE_URL),
  "signed-in suite runs against the local static server only"
);

function seedRow(over) {
  return Object.assign({
    id: 1,
    user_id: OWNER,
    card_id: "me02-003",
    card_name: "Vileplume",
    set_id: "me02",
    set_name: "Mega Evolution",
    number: "003",
    variant: "Holo",
    quantity: 1,
    market_price: 25.0,
    prev_price: 20.0,
    prev_price_at: new Date(Date.now() - 86400000).toISOString(),
    price_currency: "EUR",
    price_source: "pkmnprices",
    price_updated_at: new Date().toISOString(),
    added_at: new Date().toISOString()
  }, over);
}

test.describe("price movers agree with the card dialog", () => {
  test("mover tile opens the dialog; dialog owned section shows the same price + currency", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => errors.push(String((e && e.message) || e)));
    await gotoSignedIn(page, "/movers", [seedRow()]);

    await page.waitForSelector(".movers-section .card-tile");
    const tilePrices = await page.locator(".movers-section .mover-prices").first().innerText();
    expect(tilePrices).toContain("€20.00");
    expect(tilePrices).toContain("€25.00");

    await page.locator(".movers-section .card-tile").first().click();
    const owned = page.locator("#cm-owned");
    await expect(owned).toContainText("€25.00", { timeout: 10000 });
    // The per-variant breakdown carries the same value the tile showed.
    await expect(owned).toContainText("Holo ×1 · €25.00");
    // The catalog price table is explicitly labeled as a TCGPlayer reference
    // so it is never mistaken for the collection value above it.
    await expect(page.locator(".card-detail")).toContainText("Catalog reference · TCGPlayer");
    expect(errors).toEqual([]);
  });

  test("USD rows keep the $ rendering (no currency regression)", async ({ page }) => {
    await gotoSignedIn(page, "/movers", [seedRow({ id: 2, price_currency: "USD" })]);
    await page.waitForSelector(".movers-section .card-tile");
    const tilePrices = await page.locator(".movers-section .mover-prices").first().innerText();
    expect(tilePrices).toContain("$20.00");
    expect(tilePrices).toContain("$25.00");
  });
});
