/* VaultDex sidebar navigation tests (Playwright, chromium).
 *
 * Covers the grouped sidebar (desktop) / hamburger drawer (mobile):
 * section grouping, owner-only visibility rules, active-route highlight,
 * collapse persistence, drawer open/close, and no horizontal overflow.
 *
 * Signed-out tests are read-only and safe against production; signed-in
 * tests stub Supabase via qa/fake-supabase.js and are local-only.
 */
"use strict";

const { test, expect } = require("@playwright/test");
const { gotoSignedIn } = require("./fake-supabase");

const LOCAL_ONLY = !!process.env.BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.BASE_URL);

function collectErrors(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("[console] " + m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errors.push("[pageerror] " + String(e).slice(0, 200)));
  return errors;
}

// Signed-in runs stub Supabase (fake-supabase.js doesn't implement every
// table, e.g. collection_value_snapshots 404s there but exists in prod), so
// only pageerrors are asserted — same convention as qa/signed-in.spec.js.
function collectPageErrors(page) {
  const errors = [];
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

async function visibleNavLabels(page) {
  return page.locator('#sidebar .nav-item:visible .nav-label').allTextContents();
}

test.describe("sidebar nav — signed out", () => {
  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("grouped sidebar, owner-only items hidden, active highlight", async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto("/");
      const sidebar = page.locator("#sidebar");
      await expect(sidebar).toBeVisible();
      await expect(sidebar.locator(".nav-heading", { hasText: "Explore" })).toBeVisible();
      await expect(sidebar.locator(".nav-heading", { hasText: "My Vault" })).toBeVisible();

      // Signed-out: Browse / Wishlist / Trophies are owner-only.
      expect(await visibleNavLabels(page)).toEqual([
        "Home", "Vedant's Collection", "Pokédex", "Trade Binder", "Games",
        "Price Movers",
      ]);
      // Every nav item carries an icon.
      const iconCount = await sidebar.locator(".nav-item:visible .nav-ico svg").count();
      expect(iconCount).toBe(6);

      // Active route highlight follows navigation.
      await page.goto("/games");
      await expect(sidebar.locator('a[data-nav="games"].active')).toBeVisible();
      await expect(sidebar.locator('a[data-nav="home"].active')).toHaveCount(0);

      // /set/* reads as Browse.
      await page.goto("/set/me02");
      await expect(page.locator(".empty-state, .owner-only")).toBeVisible(); // signed-out set page
      await expectNoOverflow(page);
      expect(errors).toEqual([]);
    });

    test("collapse toggle persists across reloads", async ({ page }) => {
      await page.goto("/");
      const collapse = page.locator("#sidebar-collapse");
      await expect(collapse).toBeVisible();
      await collapse.click();
      await expect(page.locator("body.sidebar-collapsed")).toHaveCount(1);
      // Icon rail: labels hidden, icons still laid out. Poll — the width
      // transition (0.22s) may still be in flight right after the click.
      await expect(page.locator('#sidebar .nav-label').first()).toBeHidden();
      await expect
        .poll(async () => page.locator("#sidebar").evaluate((el) => el.getBoundingClientRect().width), { timeout: 5000 })
        .toBeLessThanOrEqual(80);
      await page.reload();
      await expect(page.locator("body.sidebar-collapsed")).toHaveCount(1);
      // Expand again.
      await page.locator("#sidebar-collapse").click();
      await expect(page.locator("body.sidebar-collapsed")).toHaveCount(0);
      await expect(page.locator('#sidebar .nav-label').first()).toBeVisible();
      await expectNoOverflow(page);
    });
  });

  test.describe("mobile drawer", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("hamburger opens drawer with same sections; closes on navigation", async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto("/");
      const burger = page.locator("#hamburger");
      await expect(burger).toBeVisible();
      // Brand stays in the slim header; collapse toggle is desktop-only.
      await expect(page.locator(".header-brand")).toBeVisible();
      await expect(page.locator("#sidebar-collapse")).toBeHidden();

      // Drawer starts off-canvas.
      const offX = await page.locator("#sidebar").evaluate((el) => el.getBoundingClientRect().x);
      expect(offX).toBeLessThan(0);

      await burger.click();
      await expect(page.locator("body.drawer-open")).toHaveCount(1);
      // Poll — the 0.26s slide transition may still be in flight.
      await expect
        .poll(async () => page.locator("#sidebar").evaluate((el) => el.getBoundingClientRect().x), { timeout: 5000 })
        .toBeCloseTo(0, 0);
      expect(await visibleNavLabels(page)).toEqual([
        "Home", "Vedant's Collection", "Pokédex", "Trade Binder", "Games",
        "Price Movers",
      ]);

      // Navigating closes the drawer.
      await page.locator('#sidebar a[data-nav="games"]').click();
      await expect(page).toHaveURL(/\/games$/);
      await expect(page.locator("body.drawer-open")).toHaveCount(0);
      await expect(page.locator('#sidebar a[data-nav="games"].active')).toBeVisible();
      await expectNoOverflow(page);
      expect(errors).toEqual([]);
    });

    test("scrim and Escape close the drawer", async ({ page }) => {
      await page.goto("/");
      await page.locator("#hamburger").click();
      await expect(page.locator("body.drawer-open")).toHaveCount(1);
      await page.locator("#sidebar-scrim").click();
      await expect(page.locator("body.drawer-open")).toHaveCount(0);
      await page.locator("#hamburger").click();
      await page.keyboard.press("Escape");
      await expect(page.locator("body.drawer-open")).toHaveCount(0);
      await expectNoOverflow(page);
    });
  });
});

test.describe("sidebar nav — signed in (local only)", () => {
  test.skip(LOCAL_ONLY, "signed-in suite runs against the local static server only");
  test.use({ viewport: { width: 1440, height: 900 } });

  test("owner sees every item; wishlist and movers highlight their own rows", async ({ page }) => {
    const errors = collectPageErrors(page);
    await gotoSignedIn(page, "/");
    expect(await visibleNavLabels(page)).toEqual([
      "Home", "My Collection", "Pokédex", "Trade Binder", "Games",
      "Browse", "Wishlist", "Trophies", "Price Movers",
    ]);

    await gotoSignedIn(page, "/wishlist");
    await expect(page.locator('#sidebar a[data-nav="wishlist"].active')).toBeVisible();

    await gotoSignedIn(page, "/movers");
    await expect(page.locator('#sidebar a[data-nav="movers"].active')).toBeVisible();

    await gotoSignedIn(page, "/games/quiz");
    await expect(page.locator('#sidebar a[data-nav="games"].active')).toBeVisible();

    await expectNoOverflow(page);
    expect(errors).toEqual([]);
  });
});
