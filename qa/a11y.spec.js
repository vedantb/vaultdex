/* VaultDex accessibility checks (axe-core, chromium only).
 *
 * Runs the axe ruleset against the main signed-out pages and fails on
 * serious or critical violations. No sign-in, no secrets — safe for PR CI.
 * Color-contrast is included: the app's theme tokens must stay legible.
 */
"use strict";

const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const PAGES = ["/", "/collection", "/browse", "/trade", "/trophies", "/pokedex"];

test.describe("accessibility (axe-core)", () => {
  for (const path of PAGES) {
    test(`${path} has no serious/critical a11y violations`, async ({ page }) => {
      await page.goto(path, { waitUntil: "networkidle", timeout: 60000 });
      // Let tiles/hubs/empty states settle before scanning.
      await page.locator(".card-tile, .empty-state, .home-title, .hub-page-title, .badge-card, .dex-cell").first().waitFor({ timeout: 20000 });

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      const bad = results.violations.filter(v => v.impact === "serious" || v.impact === "critical");
      if (bad.length) {
        console.log(JSON.stringify(bad.map(v => ({
          id: v.id, impact: v.impact, help: v.help,
          nodes: v.nodes.length,
          html: v.nodes.slice(0, 3).map(n => n.html.slice(0, 160))
        })), null, 2));
      }
      expect(bad).toEqual([]);
    });
  }
});
