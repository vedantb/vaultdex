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
 * pipeline). So the signed-out spec covers the two public pages instead:
 *   /            — home: hero, vault stats, entry cards, top-of-vault rail
 *   /collection  — public read-only collection grid (renders card tiles)
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

test("signed-out home (/) renders: zero errors, no horizontal overflow", async ({
  page,
}) => {
  const errors = collectErrors(page);
  const resp = await page.goto("/", { waitUntil: "networkidle", timeout: 60000 });
  expect(resp && resp.ok()).toBe(true);
  // Home hero must be up (public, signed-out view).
  await expect(page.locator(".home-title")).toBeVisible({ timeout: 20000 });
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test("signed-out collection (/collection) grid renders tiles: zero errors, no overflow", async ({
  page,
}) => {
  const errors = collectErrors(page);
  const resp = await page.goto("/collection", {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  expect(resp && resp.ok()).toBe(true);
  // At least one card tile must paint (public collection is served by the
  // owner's Supabase rows; catalog tiles render the same .card-tile markup).
  await expect(page.locator(".card-tile").first()).toBeVisible({ timeout: 20000 });
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});
