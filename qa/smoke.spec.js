/* VaultDex signed-out smoke tests (Playwright, chromium only).
 *
 * Extracted essentials from the unversioned ~/workspace/.qa harness. Runs at
 * a mobile 390x844 viewport and asserts zero console errors, zero pageerrors,
 * and no horizontal overflow on each page. No sign-in, no secrets — safe for
 * PR CI and the daily production run.
 *
 * NOTE: /set/<id> and /browse are owner-only (App.views.setView /
 * App.views.browse render an "Owner only" empty state when signed out), and
 * the review spec explicitly forbids signed-in CI (no service keys in the
 * pipeline). Signed-in coverage lives in qa/signed-in.spec.js, which stubs
 * Supabase instead. So the signed-out spec covers the public surface:
 *   /            — home: hero, vault stats, entry cards, top-of-vault rail
 *   /collection  — public read-only collection grid (renders card tiles)
 *   /browse      — owner-only empty state
 *   /set/me02    — owner-only empty state
 *   /wishlist    — private empty state
 *   /trade       — public trade binder (tiles or empty state)
 */
const { test, expect } = require("@playwright/test");

// Attach zero-error listeners and return the collected messages.
function collectErrors(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("[console] " + m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errors.push("[pageerror] " + String(e).slice(0, 200)));
  return errors;
}

async function expectNoOverflow(page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
}

/* Load a path and assert the clean-render contract: HTTP ok, a marker
 * element visible, no horizontal overflow, zero console/page errors. */
async function expectCleanPage(page, path, marker, markerText) {
  const errors = collectErrors(page);
  const resp = await page.goto(path, { waitUntil: "networkidle", timeout: 60000 });
  expect(resp && resp.ok()).toBe(true);
  const el = page.locator(marker).first();
  await expect(el).toBeVisible({ timeout: 20000 });
  if (markerText) await expect(el).toContainText(markerText);
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
}

test("signed-out home (/) renders: zero errors, no horizontal overflow", async ({
  page,
}) => {
  // Home hero must be up (public, signed-out view).
  await expectCleanPage(page, "/", ".home-title");
});

test("signed-out collection (/collection) grid renders tiles: zero errors, no overflow", async ({
  page,
}) => {
  // At least one card tile must paint (public collection is served by the
  // owner's Supabase rows; catalog tiles render the same .card-tile markup).
  await expectCleanPage(page, "/collection", ".card-tile");
});

test("signed-out /browse shows the owner-only empty state", async ({ page }) => {
  await expectCleanPage(page, "/browse", ".empty-state h3", "Owner only");
});

test("signed-out /set/me02 shows the owner-only empty state", async ({ page }) => {
  await expectCleanPage(page, "/set/me02", ".empty-state h3", "Owner only");
});

test("signed-out /wishlist shows the private empty state", async ({ page }) => {
  await expectCleanPage(page, "/wishlist", ".empty-state h3", "Wishlist is private");
});

test("signed-out /trade renders the public binder hub: zero errors, no overflow", async ({
  page,
}) => {
  // /trade lands on a section hub for visitors; tiles render per section.
  await expectCleanPage(page, "/trade", ".hub-page-title", "Trade Binder");
});

test.describe("desktop viewport", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("desktop viewport: signed-out home (/) renders cleanly", async ({ page }) => {
    await expectCleanPage(page, "/", ".home-title");
  });
});
