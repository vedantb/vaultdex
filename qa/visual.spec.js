/* VaultDex visual regression (Playwright, chromium only).
 *
 * toHaveScreenshot baselines, committed to the repo. The page under test is
 * rendered through qa/fake-supabase.js (in-memory PostgREST + injected owner
 * session, empty collection), so the pixels are fully determined by repo
 * content: the catalog snapshots and the app's own CSS/JS. No live prices,
 * no real backend, no secrets — safe for PR CI.
 *
 * Local-server only: same guard as qa/signed-in.spec.js. To regenerate
 * baselines after an intentional UI change:
 *   npx playwright test qa/visual.spec.js --update-snapshots
 */
"use strict";

const { test, expect } = require("@playwright/test");
const { gotoSignedIn } = require("./fake-supabase");

/* Local-server only: the suite injects a fake owner session and intercepts
 * every backend route, so it must never run against a real deployment. */
test.skip(
  !!process.env.BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.BASE_URL),
  "visual suite runs against the local static server only"
);

test.describe("visual regression", () => {
  test("set page (me02, empty collection) matches baseline", async ({ page }) => {
    await gotoSignedIn(page, "/set/me02");
    // All tiles up before the screenshot; images off the CDN included.
    await page.locator(".card-tile").first().waitFor({ timeout: 20000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await expect(page).toHaveScreenshot("set-me02.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: false,
      // Same-OS Chromium rendering is near-identical, but font rasterization
      // drifts across versions — allow a small pixel budget for that.
      maxDiffPixelRatio: 0.02,
    });
  });
});
