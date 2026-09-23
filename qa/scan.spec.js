/* VaultDex — /scan Playwright coverage (chromium, mobile-first).
 *
 * Signed-out tests run against any BASE_URL (same contract as smoke.spec.js).
 * The signed-in camera test stubs getUserMedia with a canvas-backed fake
 * stream and stubs the OCR engine with a canned payload — it exercises the
 * real capture → review → ranking → confirm-sheet wiring against the local
 * catalog, never the real camera or the OCR CDN. It never clicks "Add",
 * so no collection rows are written.
 */
"use strict";

const { test, expect } = require("@playwright/test");
const { gotoSignedIn } = require("./fake-supabase");

/* Attach zero-error listeners; also track 4xx/5xx response URLs so known
 * backend gaps can be filtered by URL (Chrome's console text omits it). */
function collectErrors(page) {
  const errors = [];
  const badUrls = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("[console] " + m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errors.push("[pageerror] " + String(e).slice(0, 200)));
  page.on("response", (r) => {
    if (r.status() >= 400) badUrls.push(r.status() + " " + r.url().slice(0, 160));
  });
  return { errors, badUrls };
}

/* The fake backend has no collection_value_snapshots table (it exists in
 * production) and the VM's egress path intermittently throws
 * ERR_HTTP2_PROTOCOL_ERROR on third-party fetches — both are pre-existing
 * infra noise, not scan failures. Everything else must be silent. */
function expectCleanErrors({ errors, badUrls }) {
  const knownGap = (u) => /collection_value_snapshots/.test(u);
  const realBadUrls = badUrls.filter((u) => !knownGap(u));
  const realErrors = errors.filter((e) => {
    if (/ERR_HTTP2_PROTOCOL_ERROR/.test(e)) return false;
    if (/Failed to load resource/.test(e) && /404/.test(e) && realBadUrls.length === 0) return false;
    return true;
  });
  expect(realBadUrls).toEqual([]);
  expect(realErrors).toEqual([]);
}

async function expectNoOverflow(page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
}

/* Touch-enabled context for the phone-class tests: App.scan.scanCapable()
 * needs coarse pointer/touch, which the default desktop-headless context
 * lacks. Real phones always qualify. */
test.describe("mobile viewport", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("signed-out mobile /scan asks for sign-in: zero errors, no overflow", async ({ page }) => {
  const collected = collectErrors(page);
  const resp = await page.goto("/scan", { waitUntil: "networkidle", timeout: 60000 });
  expect(resp && resp.ok()).toBe(true);
  await expect(page.locator(".empty-state h3")).toContainText("Sign in to scan cards");
  await expect(page.locator("[data-scan-signin]")).toBeVisible();
  await expectNoOverflow(page);
  expectCleanErrors(collected);
});

test("signed-out mobile home shows the Scan entry point", async ({ page }) => {
  const collected = collectErrors(page);
  await page.goto("/", { waitUntil: "networkidle", timeout: 60000 });
  const cta = page.locator(".home-scan-cta");
  await expect(cta).toBeVisible({ timeout: 20000 });
  await expect(cta).toHaveAttribute("href", "/scan");
  await expectNoOverflow(page);
  expectCleanErrors(collected);
});
}); // mobile viewport

test.describe("desktop viewport", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("desktop /scan explains the scanner is phone-only", async ({ page }) => {
    const collected = collectErrors(page);
    const resp = await page.goto("/scan", { waitUntil: "networkidle", timeout: 60000 });
    expect(resp && resp.ok()).toBe(true);
    await expect(page.locator(".empty-state h3")).toContainText("Scanning lives on your phone");
    // No camera UI may exist on desktop.
    await expect(page.locator(".scan-finder")).toHaveCount(0);
    await expectNoOverflow(page);
    expectCleanErrors(collected);
  });

  test("desktop home shows no scan entry point", async ({ page }) => {
    const collected = collectErrors(page);
    await page.goto("/", { waitUntil: "networkidle", timeout: 60000 });
    await expect(page.locator(".home-title")).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".home-scan-cta")).toHaveCount(0);
    // Desktop nav has no scan item either.
    await expect(page.locator('#sidebar [data-nav="scan"]')).toHaveCount(0);
    await expectNoOverflow(page);
    expectCleanErrors(collected);
  });
});

/* Touch-enabled context so App.scan.scanCapable() is true (the default
 * headless context has no touch and would take the desktop path). */
test.describe("signed-in camera flow", () => {
  /* Local-server only: this block injects a fake owner session. */
  test.skip(
    !!process.env.BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.BASE_URL),
    "signed-in scan suite runs against the local static server only"
  );
  test.use({ hasTouch: true, isMobile: true });

  test("capture → review → candidates → confirm sheet: zero errors, no overflow", async ({ page }) => {
    // Stub the camera before the app boots: a canvas painting frames.
    await page.addInitScript(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#1c2333";
      ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = "#ffffff";
      ctx.font = "32px sans-serif";
      ctx.fillText("Pikachu 025/102", 200, 240);
      const stream = canvas.captureStream(30);
      Object.defineProperty(navigator, "mediaDevices", {
        value: { getUserMedia: async () => stream },
        configurable: true,
      });
    });

    const collected = collectErrors(page);
    await gotoSignedIn(page, "/scan");
    // The fake localStorage session needs a reload for auth.init to pick it up.
    await page.reload({ waitUntil: "networkidle", timeout: 60000 });

    // Camera stage renders.
    await expect(page.locator(".scan-title")).toContainText("Scan a card");
    await expect(page.locator(".scan-shutter")).toBeVisible({ timeout: 20000 });
    // Wait for a real frame so capture has dimensions.
    await page.waitForFunction(
      () => {
        const v = document.querySelector(".scan-finder video");
        return v && v.videoWidth > 0;
      },
      null,
      { timeout: 20000 }
    );

    // Stub OCR (not under test here) with a canned payload, then capture.
    await page.evaluate(() => {
      window.App.scan.recognize = async () => ({
        text: "Pikachu\n025/102",
        lines: [],
      });
    });
    await page.locator(".scan-shutter").click();

    // Review stage: captured photo, retake, read.
    await expect(page.locator(".scan-review img")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("[data-retake]")).toBeVisible();
    await page.locator("[data-read]").click();

    // Candidates ranked from the canned OCR ("Pikachu" #25).
    const tiles = page.locator(".scan-cands .card-tile");
    await expect(tiles.first()).toBeVisible({ timeout: 30000 });
    const names = await page.locator(".scan-cands .card-tile .name").allTextContents();
    expect(names.some((n) => /pikachu/i.test(n))).toBe(true);

    // Pick the first candidate → confirm sheet (never auto-adds).
    await tiles.first().click();
    const sheet = page.locator(".scan-sheet");
    await expect(sheet).toBeVisible({ timeout: 15000 });
    await expect(sheet.locator(".sheet-head h2")).not.toBeEmpty();
    await expect(sheet.locator("[data-add]")).toContainText("Add to collection");
    // Price block and ownership line.
    await expect(sheet.locator("[data-price]")).not.toBeEmpty({ timeout: 15000 });
    await expect(sheet.locator("[data-owned]")).toContainText(/You own|Not in your collection yet/, { timeout: 15000 });
    // Variant pills, quantity stepper, condition label.
    await expect(sheet.locator(".variant-pill").first()).toBeVisible();
    await expect(sheet.locator(".stepper .qty")).toHaveText("1");
    await sheet.locator("[data-inc]").click();
    await expect(sheet.locator(".stepper .qty")).toHaveText("2");
    await expect(sheet.locator(".scan-condition")).toContainText("Near Mint");

    await expectNoOverflow(page);
    // Escape closes the sheet without adding.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden({ timeout: 10000 });
  });
});
