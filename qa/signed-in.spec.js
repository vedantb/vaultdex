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

  test("set-page tile shows ×N badge summing all variant rows; uncheck lowers it", async ({ page }) => {
    const { db } = await gotoSignedIn(page, SET, [
      seedRow({ id: 1, card_id: "me02-003", variant: "Holo", quantity: 2 }),
      seedRow({ id: 2, card_id: "me02-003", variant: "Cosmos Holo", quantity: 1 })
    ]);
    await page.waitForSelector('.card-tile[data-id="me02-003"] .variant-check');
    const badge = page.locator('.card-tile[data-id="me02-003"] .qty-badge');
    await expect(badge).toHaveText("×3");

    await clickBox(page, "me02-003", 0); // uncheck Holo (both copies live in one row)
    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(1);
    await expect(badge).toHaveText("×1");

    await clickBox(page, "me02-003", 2); // uncheck Cosmos Holo: badge disappears
    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(0);
    await expect(badge).toHaveCount(0);
  });

  test("card modal stepper shows owned qty for the selected variant; + bumps it live", async ({ page }) => {
    const { db } = await gotoSignedIn(page, SET, [
      seedRow({ id: 1, card_id: "me02-001", variant: "Normal", quantity: 2 }),
      seedRow({ id: 2, card_id: "me02-001", variant: "Reverse Holo", quantity: 1 })
    ]);
    await page.waitForSelector('.card-tile[data-id="me02-001"]');

    await page.locator('.card-tile[data-id="me02-001"] .art img').click();
    await page.waitForSelector("#cm-minus", { timeout: 15000 });
    const line = page.locator("#cm-owned");
    await expect(line).toContainText("In your collection:");
    await expect(line).toContainText("×3");
    await expect(line).toContainText("Normal ×2 · Reverse Holo ×1");

    // Default pill is the first printing ("Normal") — the stepper binds its row.
    await expect(page.locator("#cm-qty")).toHaveText("2", { timeout: 10000 });
    await expect(page.locator("#cm-own-label")).toContainText("Normal");

    await page.click("#cm-plus");
    await expect(page.locator("#cm-qty")).toHaveText("3", { timeout: 10000 });
    await expect(line).toContainText("×4", { timeout: 10000 });
    const normal = rowsOf(db).find(r => r.card_id === "me02-001" && r.variant === "Normal");
    expect(normal.quantity).toBe(3);
  });

  test("card modal - at 1 removes the row; Undo restores it", async ({ page }) => {
    const { db } = await gotoSignedIn(page, SET, [
      seedRow({ id: 1, card_id: "me02-001", variant: "Normal", quantity: 1 })
    ]);
    await page.waitForSelector('.card-tile[data-id="me02-001"]');

    await page.locator('.card-tile[data-id="me02-001"] .art img').click();
    await page.waitForSelector("#cm-minus", { timeout: 15000 });
    await expect(page.locator("#cm-qty")).toHaveText("1", { timeout: 10000 });

    await page.click("#cm-minus");
    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(0);

    // Click Undo promptly: the toast auto-dismisses after a few seconds.
    const undo = page.locator(".toast-action");
    await expect(undo).toBeVisible({ timeout: 10000 });
    await undo.click();
    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(1);
    expect(rowsOf(db)[0].quantity).toBe(1);

    await expect(page.locator("#cm-qty")).toHaveText("1", { timeout: 10000 });
    await expect(page.locator("#cm-owned")).toContainText("×1");
  });

  test("card modal - on an unowned variant does nothing; switching pills rebinds", async ({ page }) => {
    const { db } = await gotoSignedIn(page, SET, [
      seedRow({ id: 1, card_id: "me02-001", variant: "Normal", quantity: 2 }),
      seedRow({ id: 2, card_id: "me02-001", variant: "Reverse Holo", quantity: 5 })
    ]);
    await page.waitForSelector('.card-tile[data-id="me02-001"]');

    await page.locator('.card-tile[data-id="me02-001"] .art img').click();
    await page.waitForSelector("#cm-minus", { timeout: 15000 });

    // "Cosmos Holo" is unowned: the stepper shows 0 and - is disabled.
    await page.locator(".variant-pill", { hasText: /^Cosmos Holo$/ }).click();
    await expect(page.locator("#cm-qty")).toHaveText("0", { timeout: 10000 });
    await expect(page.locator("#cm-own-label")).toContainText("not owned yet");
    await expect(page.locator("#cm-minus")).toBeDisabled();

    await page.locator(".variant-pill", { hasText: /^Reverse Holo$/ }).click();
    await expect(page.locator("#cm-qty")).toHaveText("5", { timeout: 10000 });
    await expect(page.locator("#cm-own-label")).toContainText("Reverse Holo");

    await page.click("#cm-plus");
    await expect(page.locator("#cm-qty")).toHaveText("6", { timeout: 10000 });
    const rh = rowsOf(db).find(r => r.variant === "Reverse Holo");
    expect(rh.quantity).toBe(6);
    // The Normal row was untouched.
    expect(rowsOf(db).find(r => r.variant === "Normal").quantity).toBe(2);

    // + on an unowned variant creates the row at 1 (same lazy-match add path
    // as the old add flow; pricing is stubbed to null in this suite).
    await page.locator(".variant-pill", { hasText: /^Cosmos Holo$/ }).click();
    await page.click("#cm-plus");
    await expect(page.locator("#cm-qty")).toHaveText("1", { timeout: 10000 });
    await expect.poll(() => rowsOf(db).length, { timeout: 10000 }).toBe(3);
    expect(rowsOf(db).find(r => r.variant === "Cosmos Holo").quantity).toBe(1);
  });

  test("set-page tile badge updates when the modal stepper changes quantity", async ({ page }) => {
    await gotoSignedIn(page, SET, [
      seedRow({ id: 1, card_id: "me02-001", variant: "Normal", quantity: 1 })
    ]);
    const badge = page.locator('.card-tile[data-id="me02-001"] .qty-badge');
    await expect(badge).toContainText("×1", { timeout: 15000 });

    await page.locator('.card-tile[data-id="me02-001"] .art img').click();
    await page.waitForSelector("#cm-minus", { timeout: 15000 });
    await expect(page.locator("#cm-qty")).toHaveText("1", { timeout: 10000 });
    await page.click("#cm-plus");
    await expect(badge).toContainText("×2", { timeout: 10000 });
  });

  test("signed-in /trophies renders the owner's badge grid (owner-only view)", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => errors.push(String(e && e.message || e)));
    await gotoSignedIn(page, "/trophies", [
      seedRow({ id: 1, card_name: "Bulbasaur", number: "001" }),
      seedRow({ id: 2, card_name: "Ivysaur", number: "002" }),
    ]);
    await page.waitForSelector(".trophies-title", { timeout: 20000 });
    await expect(page.locator(".trophies-count")).toContainText("unlocked");
    // The seeded rows unlock at least the First Steps badge; locked badges
    // render as locked cards, never as visitor read-only content.
    expect(await page.locator(".badge-card").count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("signed-in /pokedex species modal shows owned in color + missing in greyscale", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => errors.push(String(e && e.message || e)));
    // Seed one Bulbasaur printing; the catalog carries many more.
    await gotoSignedIn(page, "/pokedex", [
      seedRow({ id: 1, card_id: "sv03.5-001", card_name: "Bulbasaur", set_id: "sv03.5", set_name: "151", number: "001" }),
    ]);
    await page.waitForSelector('[data-dex-species="bulbasaur"]', { timeout: 20000 });
    await page.locator('[data-dex-species="bulbasaur"]').click();

    const modal = page.locator(".modal-body");
    await expect(modal.locator(".dex-modal-head h3")).toContainText("Bulbasaur", { timeout: 20000 });
    await expect(modal.locator(".result-meta")).toContainText("1 card in the vault");
    // The owned printing renders in color.
    expect(await modal.locator(".dex-modal-card:not(.dex-modal-missing)").count()).toBe(1);
    // Missing printings load lazily from the local index and render greyscale.
    await expect(modal.locator(".dex-modal-sub")).toContainText(/Missing printings \(\d+\)/, { timeout: 30000 });
    const missingCards = modal.locator(".dex-modal-missing");
    expect(await missingCards.count()).toBeGreaterThan(0);
    // The seeded owned printing is excluded from the missing list.
    for (const id of await missingCards.evaluateAll(els => els.map(e => e.getAttribute("data-dex-missing")))) {
      expect(id).not.toBe("sv03.5-001");
    }
    const mImg = missingCards.locator("img").first();
    await expect(mImg).toBeVisible();
    const filter = await page.evaluate(el => getComputedStyle(el).filter, await mImg.elementHandle());
    expect(filter).toContain("grayscale");
    expect(errors).toEqual([]);
  });
});
