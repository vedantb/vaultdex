/* VaultDex — modal swipe navigation + touch tilt (2026-09-21).
 *
 * Covers the "physical cards" motion trio addition: flicking the modal
 * artwork steps through the set (slide out/in, edge nudge at the ends,
 * arrow keys on desktop), and touch tracks the 3D tilt toward the finger.
 * Runs against the local static server with the fake owner session.
 */
"use strict";

const { test, expect } = require("@playwright/test");
const { gotoSignedIn } = require("./fake-supabase");

const SET = "/set/me02";

/* Local-server only: the suite injects a fake owner session and intercepts
 * every backend route, so it must never run against a real deployment. */
test.skip(
  !!process.env.BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.BASE_URL),
  "signed-in suite runs against the local static server only"
);

async function openFirstTileModal(page) {
  await page.locator(".card-tile").first().click();
  await page.waitForSelector(".modal-overlay .card-detail");
  // Let the tile->modal FLIP fully settle: during the flight the ghost
  // covers the art and the art slot is visibility:hidden, so gestures must
  // wait for flip-done (or no FLIP at all: no prep, no flight, no ghost).
  await page.waitForFunction(() => {
    const ov = document.querySelector(".modal-overlay");
    if (!ov) return false;
    if (ov.classList.contains("flip-done")) return true;
    return !ov.classList.contains("flip-prep") &&
      !ov.classList.contains("flip-live") &&
      !document.querySelector(".flip-ghost");
  }, null, { timeout: 15000 });
}

function modalTitle(page) {
  return page.evaluate(() =>
    document.querySelector(".modal-overlay .card-detail h2")?.textContent?.trim()
  );
}

function artCenter(page) {
  return page.evaluate(() => {
    const r = document.querySelector(".modal-overlay .card-detail .art").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

/* Synthesized touch gesture via CDP (Playwright's touchscreen only taps).
 * Moves are spread over ~250ms like a real finger: an instant burst lets a
 * loaded VM coalesce or delay the events and miss the swipe window. */
async function touchSwipe(page, x0, y0, x1, y1) {
  const session = await page.context().newCDPSession(page);
  const pts = (x, y) => ({ x, y, id: 1 });
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pts(x0, y0)] });
  await page.waitForTimeout(50);
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [pts(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps)]
    });
    await page.waitForTimeout(50);
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
}

async function waitForTitleChange(page, prev) {
  await page.waitForFunction(
    p => document.querySelector(".modal-overlay .card-detail h2")?.textContent?.trim() !== p,
    prev,
    { timeout: 10000 }
  );
}

test("touch on the art tilts toward the finger", async ({ page }) => {
  await gotoSignedIn(page, SET);
  await openFirstTileModal(page);
  const { x, y } = await artCenter(page);

  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });

  const held = await page.evaluate(() => {
    const art = document.querySelector(".modal-overlay .card-detail .art");
    return {
      touching: art.classList.contains("touching"),
      tilted: art.classList.contains("tilt"),
      mx: art.style.getPropertyValue("--mx"),
      my: art.style.getPropertyValue("--my")
    };
  });
  expect(held.touching).toBe(true);
  expect(held.tilted).toBe(true);
  expect(held.mx).toBe("50.0");
  expect(held.my).toBe("50.0");

  // Drag toward the upper-left, mostly horizontal so the browser doesn't
  // claim the gesture for vertical scrolling (touch-action: pan-y): the
  // tilt variables follow the finger.
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: x - 70, y: y - 20, id: 1 }]
  });
  const dragged = await page.evaluate(() => {
    const art = document.querySelector(".modal-overlay .card-detail .art");
    return { mx: art.style.getPropertyValue("--mx"), my: art.style.getPropertyValue("--my") };
  });
  expect(parseFloat(dragged.mx)).toBeLessThan(50);
  expect(parseFloat(dragged.my)).toBeLessThan(50);

  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
  const released = await page.evaluate(() =>
    document.querySelector(".modal-overlay .card-detail .art").classList.contains("touching")
  );
  expect(released).toBe(false);
});

test("flicking the art left advances to the next card", async ({ page }) => {
  await gotoSignedIn(page, SET);
  await openFirstTileModal(page);
  const before = await modalTitle(page);
  const { x, y } = await artCenter(page);

  await touchSwipe(page, x, y, x - 140, y);

  // The outgoing content shimmers in place (dialog and backdrop never move)…
  await expect(page.locator(".modal-overlay .card-detail.card-swapping")).toBeAttached({ timeout: 3000 });
  // …then the modal reopens on the neighbor with its entrance animations suppressed.
  await waitForTitleChange(page, before);
  expect(await modalTitle(page)).not.toBe(before);
  await expect(page.locator(".modal-overlay.nav-swap")).toBeAttached();
  // Exactly one modal overlay is ever on screen (no backdrop flicker stack).
  expect(await page.locator(".modal-overlay").count()).toBe(1);
});

test("swiping right on the first card nudges instead of navigating", async ({ page }) => {
  await gotoSignedIn(page, SET);
  await openFirstTileModal(page);
  const before = await modalTitle(page);
  const { x, y } = await artCenter(page);

  await touchSwipe(page, x, y, x + 140, y);

  await expect(page.locator(".modal-overlay.edge-left")).toBeAttached({ timeout: 3000 });
  await page.waitForTimeout(600);
  expect(await modalTitle(page)).toBe(before);
  expect(await page.locator(".modal-overlay").count()).toBe(1);
});

test("arrow keys step through the set", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(String(e && e.message)));
  await gotoSignedIn(page, SET);
  await openFirstTileModal(page);
  const first = await modalTitle(page);

  await page.keyboard.press("ArrowRight");
  await waitForTitleChange(page, first);
  const second = await modalTitle(page);
  expect(second).not.toBe(first);

  await page.keyboard.press("ArrowLeft");
  await waitForTitleChange(page, second);
  expect(await modalTitle(page)).toBe(first);
  expect(errors).toEqual([]);
});
