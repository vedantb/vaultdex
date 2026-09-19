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
 *   /trophies    — owner-only empty state (Trophy Case is the owner's private shelf)
 *   /pokedex     — public species grid (all 1025, captured cells)
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

test("signed-out /trophies shows the owner-only empty state", async ({
  page,
}) => {
  await expectCleanPage(page, "/trophies", ".empty-state h3", "Owner only");
});

test("signed-out /pokedex renders the species grid: zero errors, no overflow", async ({
  page,
}) => {
  // All 1025 species render; captured cells carry the owner's card art.
  await expectCleanPage(page, "/pokedex", ".pokedex-title", "Pokédex");
});

test("signed-out /pokedex filters are mutually exclusive and filter the grid", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto("/pokedex", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector(".dex-cell", { timeout: 20000 });
  const total = await page.locator(".dex-cell").count();
  expect(total).toBe(1025);

  const caughtBox = page.locator('[data-dex-filter="caught"]');
  const missingBox = page.locator('[data-dex-filter="missing"]');

  await caughtBox.check();
  await expect(missingBox).not.toBeChecked();
  const caughtCount = await page.locator(".dex-cell").count();
  expect(caughtCount).toBeGreaterThan(0);
  expect(caughtCount).toBeLessThan(total);
  expect(await page.locator(".dex-cell.dex-missing").count()).toBe(0);

  // Checking "Not captured" unchecks "Captured only".
  await missingBox.check();
  await expect(caughtBox).not.toBeChecked();
  const missingCount = await page.locator(".dex-cell").count();
  expect(missingCount).toBe(total - caughtCount);
  expect(await page.locator(".dex-cell:not(.dex-missing)").count()).toBe(0);

  // Unchecking the active filter returns to "All".
  await missingBox.uncheck();
  expect(await page.locator(".dex-cell").count()).toBe(total);

  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test("signed-out /pokedex uncaptured cells show greyscale art and open missing printings", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto("/pokedex", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector(".dex-cell", { timeout: 20000 });

  await page.locator('[data-dex-filter="missing"]').check();
  const cell = page.locator(".dex-cell.dex-missing").first();
  await expect(cell).toBeVisible();
  // Greyscale official artwork (falls back to number-only if art 404s).
  const art = cell.locator("img.dex-art-missing");
  await expect(art).toHaveAttribute(
    "src",
    /raw\.githubusercontent\.com\/PokeAPI\/sprites\/.*\/official-artwork\/\d+\.png/
  );
  const filter = await page.evaluate((el) => getComputedStyle(el).filter, await art.elementHandle());
  expect(filter).toContain("grayscale");

  // Uncaptured cells are clickable: the modal shows 0 owned + missing printings.
  await cell.click();
  const modal = page.locator(".modal-body");
  await expect(modal.locator(".dex-modal-head h3")).toBeVisible({ timeout: 20000 });
  await expect(modal.locator(".result-meta")).toContainText("0 cards in the vault");
  await expect(modal.locator(".dex-modal-sub")).toContainText(/Missing printings \(\d+\)/, { timeout: 20000 });
  const missingImg = modal.locator(".dex-modal-missing img").first();
  await expect(missingImg).toBeVisible();
  const mFilter = await page.evaluate((el) => getComputedStyle(el).filter, await missingImg.elementHandle());
  expect(mFilter).toContain("grayscale");

  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test.describe("desktop viewport", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("desktop viewport: signed-out home (/) renders cleanly", async ({ page }) => {
    await expectCleanPage(page, "/", ".home-title");
  });
});

test("signed-out /games hub renders tiles + Card of the Day hero: zero errors, no overflow", async ({
  page,
}) => {
  await expectCleanPage(page, "/games", ".games-title", "Games");
  await expect(page.locator(".game-tile")).toHaveCount(3);
  // Card of the Day hero features a real card from the vault.
  await expect(page.locator(".cotd-hero .cotd-hero-name")).toBeVisible();
  // The Games nav entry is public and active on the hub.
  await expect(page.locator('.main-nav [data-nav="games"], .page-nav [data-nav="games"]').first()).toHaveClass(/active/);
});

test("signed-out /games/higher-lower plays a full round: zero errors, no overflow", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto("/games/higher-lower", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector(".hl-duel", { timeout: 20000 });
  await expect(page.locator("[data-hl-pick]")).toHaveCount(2);
  // Prices stay hidden until a pick.
  await expect(page.locator("[data-hl-price]").first()).toBeHidden();

  await page.locator("[data-hl-pick]").first().click();
  const result = page.locator("[data-hl-result]");
  await expect(result).toBeVisible();
  // Both prices revealed, formatted as money.
  const prices = await page.locator("[data-hl-price]").allTextContents();
  expect(prices).toHaveLength(2);
  expect(prices[0]).toMatch(/\$/);
  expect(prices[1]).toMatch(/\$/);
  await expect(page.locator("[data-hl-next]")).toBeVisible();
  await expect(page.locator("[data-hl-streak]")).toContainText(/Streak: [01]/);

  // Next round deals a fresh pair.
  await page.locator("[data-hl-next]").click();
  await page.waitForSelector(".hl-duel", { timeout: 20000 });
  await expect(page.locator("[data-hl-result]")).toBeHidden();

  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test("signed-out /games/quiz plays one round: zero errors, no overflow", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto("/games/quiz", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector(".quiz-crop", { timeout: 20000 });
  await expect(page.locator(".quiz-opt")).toHaveCount(4);

  await page.locator(".quiz-opt").first().click();
  await expect(page.locator("[data-quiz-feedback]")).toBeVisible();
  // The correct option is always marked after answering.
  await expect(page.locator(".quiz-opt.quiz-right")).toHaveCount(1);
  await expect(page.locator("[data-quiz-next]")).toBeVisible();
  // Answering reveals the full card: the crop opens up and the feedback
  // names the card + set.
  await expect(page.locator(".quiz-crop.quiz-revealed")).toBeVisible();
  await expect(page.locator(".quiz-crop.quiz-revealed img")).not.toHaveAttribute("style", /width:/);
  await expect(page.locator("[data-quiz-feedback]")).toContainText("·");

  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test("signed-out /games/card-of-the-day renders today's card: zero errors, no overflow", async ({
  page,
}) => {
  await expectCleanPage(page, "/games/card-of-the-day", ".games-title", "Card of the Day");
  await expect(page.locator(".cotd-name")).toBeVisible();
  await expect(page.locator(".cotd-art")).toBeVisible();
  // Deterministic date stamp (YYYY-MM-DD).
  await expect(page.locator(".cotd-date")).toHaveText(/\d{4}-\d{2}-\d{2}/);
  // "Did you know?" facts resolve async (PokéAPI lore + local artist
  // stats). Lenient by design: when they resolve the block appears with
  // real text; a flaky network must not fail the suite.
  const factBlock = await page
    .waitForSelector(".fact-block:not([hidden])", { timeout: 15000 })
    .catch(() => null);
  if (factBlock) {
    const texts = await page.locator(".fact-text").allTextContents();
    expect(texts.some((t) => t.trim().length > 0)).toBe(true);
  }
});
