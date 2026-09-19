/* VaultDex — signed-in collection flows, tested against a fake Supabase.
 *
 * These run the REAL auth/collection/views/pkmn query code against
 * qa/fake-supabase.js (in-memory PostgREST + injected owner session), so
 * the historically buggiest paths — set-page checkbox toggles, variant
 * merging, the card-modal add flow — finally have automated coverage
 * without any real credentials in CI.
 */
"use strict";

const { test, expect } = require("@playwright/test");
const { gotoSignedIn, appConfig } = require("./fake-supabase");

const SET = "/set/me02"; // 130 cards, per-variant checkboxes incl. Cosmos Holo
const OWNER = appConfig().owner;

/* Local-server only: the suite injects a fake owner session and intercepts
 * every backend route, so it must never run against a real deployment. */
test.skip(
  !!process.env.BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.BASE_URL),
  "signed-in suite runs against the local static server only"
);

const rowsOf = db => db.tables.collection_items;

async function tileState(page, cardId) {
  return page.evaluate(cardId => {
    const tile = document.querySelector(`.card-tile[data-id="${cardId}"]`);
    if (!tile) return null;
    const btns = Array.from(tile.querySelectorAll(".variant-check"));
    return {
      labels: btns.map(b => (b.getAttribute("aria-label") || b.textContent || "").trim()),
      pressed: btns.map(b => b.getAttribute("aria-pressed"))
    };
  }, cardId);
}

async function clickBox(page, cardId, idx) {
  await page.locator(`.card-tile[data-id="${cardId}"] .variant-check`).nth(idx).click();
}

function seedRow(over) {
  return Object.assign({
    id: 1,
    user_id: OWNER,
    card_id: "me02-003",
    card_name: "Vileplume",
    set_id: "me02",
    number: "003",
    variant: "Holo",
    quantity: 1,
    market_price: null,
    added_at: new Date().toISOString()
  }, over);
}

test.describe("signed-in collection flows (stubbed Supabase)", () => {
  test("boot signs in as the owner with zero console errors", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => errors.push(String(e && e.message || e)));
    const { db } = await gotoSignedIn(page, SET);
    await page.waitForSelector('.card-tile[data-id="me02-001"] .variant-check');
    expect(errors).toEqual([]);
    expect(rowsOf(db)).toEqual([]);
  });

  test("checkbox check adds exactly one row; uncheck removes it (no duplicates)", async ({ page }) => {
    const { db } = await gotoSignedIn(page, SET);
    await page.waitForSelector('.card-tile[data-id="me02-001"] .variant-check');

    let st = await tileState(page, "me02-001");
    expect(st).not.toBeNull();
    expect(st.labels.length).toBeGreaterThan(1);
    expect(st.pressed.every(p => p === "false")).toBe(true);

    await clickBox(page, "me02-001", 0);
    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(1);
    expect(rowsOf(db)[0].card_id).toBe("me02-001");

    st = await tileState(page, "me02-001");
    expect(st.pressed[0]).toBe("true");

    // The historical bug: the box looked checked but the row's variant
    // didn't match, so every tap silently inserted a DUPLICATE row and the
    // box could never be unchecked.
    await clickBox(page, "me02-001", 0);
    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(0);

    st = await tileState(page, "me02-001");
    expect(st.pressed[0]).toBe("false");
  });

  test("two printings of one card are separate rows; unchecking one keeps the other", async ({ page }) => {
    const { db } = await gotoSignedIn(page, SET);
    await page.waitForSelector('.card-tile[data-id="me02-003"] .variant-check');

    await clickBox(page, "me02-003", 0); // Holo
    await clickBox(page, "me02-003", 2); // Cosmos Holo
    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(2);
    expect(rowsOf(db).map(r => r.variant).sort()).toEqual(["Cosmos Holo", "Holo"]);

    let st = await tileState(page, "me02-003");
    expect(st.pressed).toEqual(["true", "false", "true"]);

    await clickBox(page, "me02-003", 0); // uncheck Holo only
    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(1);
    expect(rowsOf(db)[0].variant).toBe("Cosmos Holo");

    st = await tileState(page, "me02-003");
    expect(st.pressed).toEqual(["false", "false", "true"]);
  });

  test("row stored as 'holofoil' unchecks via the 'Holo' box (no duplicate, no qty bump)", async ({ page }) => {
    const { db } = await gotoSignedIn(page, SET, [seedRow({ variant: "holofoil" })]);
    await page.waitForSelector('.card-tile[data-id="me02-003"] .variant-check');

    // Same printing under a different label spelling still lights the box.
    let st = await tileState(page, "me02-003");
    expect(st.pressed[0]).toBe("true");

    await clickBox(page, "me02-003", 0);
    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(0);

    st = await tileState(page, "me02-003");
    expect(st.pressed[0]).toBe("false");
  });

  test("card modal add saves the chosen quantity as a single row", async ({ page }) => {
    const { db } = await gotoSignedIn(page, SET);
    await page.waitForSelector('.card-tile[data-id="me02-001"]');

    await page.locator('.card-tile[data-id="me02-001"] .art img').click();
    await page.waitForSelector("#cm-add", { timeout: 15000 });

    await page.click("#cm-plus");
    await expect(page.locator("#cm-qty")).toHaveText("2");
    await page.click("#cm-add");

    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(1);
    expect(rowsOf(db)[0].card_id).toBe("me02-001");
    expect(rowsOf(db)[0].quantity).toBe(2);
  });
});
