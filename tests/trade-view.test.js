/* VaultDex regression tests — trade binder "Browse by set" (js/views/trade-view.js).
 *
 * The set tiles used to key off the display NAME (data-trade-set="<name>")
 * and the grid filter matched rows by set_name. EN/JA sets can share a
 * display name — Japanese M6a's community English name is "30th Celebration",
 * identical to English set 30th — so opening the English tile mixed both
 * languages into one grid. Tiles are keyed by set appId now. */
import { describe, test, expect, beforeEach } from "vitest";
import "../js/util.js"; // real App.util: BUDGETS / langOf / topImage
import "../js/ui.js"; // real App.esc + App.ui

const App = window.App;
const tick = () => new Promise((r) => setTimeout(r, 0));

// EN 30th Celebration and JA M6a share the display name "30th Celebration".
const EN_ROW = {
  id: 1, card_id: "30th-001", card_name: "Pikachu EN",
  set_id: "30th", set_name: "30th Celebration",
  variant: "Normal", quantity: 3, trade_qty: 1, market_price: 5
};
const JA_ROW = {
  id: 2, card_id: "ja-m6a-001", card_name: "Pikachu JA",
  set_id: "ja-M6a", set_name: "30th Celebration",
  variant: "Normal", quantity: 3, trade_qty: 1, market_price: 5
};
const CATALOG = [
  { appId: "30th", lang: "en", name: "30th Celebration", series: "Other", images: {} },
  { appId: "ja-M6a", lang: "ja", name: "30th Celebration", series: "Other", images: {} }
];

App.isConfigured = () => true;
App.auth = { isOwner: () => false };
App.handleApiError = () => {};
App.trade = {
  listForTrade: async () => [EN_ROW, JA_ROW],
  effectiveQty: (r) => r.trade_qty || 0
};
App.tcg = { getSets: async () => CATALOG };
// Minimal tile stub so assertions can read card names out of the grid.
App.ui.tileHtml = (row) => '<div class="trade-tile">' + App.esc(row.card_name) + "</div>";
if (typeof window.scrollTo !== "function") window.scrollTo = () => {};

await import("../js/views/trade-view.js");

async function openSetGrid(root, lang) {
  await App.views.trade(root);
  root.querySelector('[data-trade-section="set"]').click();
  await tick();
  root.querySelector('[data-trade-setlang="' + lang + '"]').click();
  await tick();
  await tick();
}

describe("trade binder browse-by-set", () => {
  let root;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  test("set tiles are keyed by set id, not display name", async () => {
    await openSetGrid(root, "en");
    const tiles = root.querySelectorAll("[data-trade-set]");
    expect(tiles.length).toBe(1);
    expect(tiles[0].getAttribute("data-trade-set")).toBe("30th");
    expect(tiles[0].getAttribute("data-trade-set-title")).toBe("30th Celebration");
    root.remove();
  });

  test("English 30th Celebration tile shows only English listings", async () => {
    await openSetGrid(root, "en");
    root.querySelector("[data-trade-set]").click();
    await tick();
    const text = root.textContent;
    expect(text).toContain("Pikachu EN");
    expect(text).not.toContain("Pikachu JA");
    root.remove();
  });

  test("Japanese 30th Celebration tile shows only Japanese listings", async () => {
    await openSetGrid(root, "ja");
    const tiles = root.querySelectorAll("[data-trade-set]");
    expect(tiles.length).toBe(1);
    expect(tiles[0].getAttribute("data-trade-set")).toBe("ja-M6a");
    tiles[0].click();
    await tick();
    const text = root.textContent;
    expect(text).toContain("Pikachu JA");
    expect(text).not.toContain("Pikachu EN");
    root.remove();
  });
});
