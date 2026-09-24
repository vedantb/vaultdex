/* VaultDex unit tests — set_id-scoped pricing degrades safely.
 *
 * data/pkmn-set-ids.json is a baked static file, but if it ever fails to
 * load the app must keep working exactly like before (name-normalized
 * match + legacy fallback), never throw. This file runs in its own
 * module graph so the map-promise cache starts empty.
 */
import { describe, test, expect, afterEach } from "vitest";
import "../js/util.js";
import "../js/tcg-api.js";
import "../js/pkmn.js";

const P = window.App.pkmn;

function stubFailingMap(handler) {
  window.App.util.fetchWithTimeout = async (url) => {
    const u = new URL(url, "https://x.test");
    const path = u.searchParams.get("path");
    if (!path) return { ok: false, status: 404, json: async () => ({}) };
    const payload = handler(path, Object.fromEntries(u.searchParams));
    return { ok: true, status: 200, json: async () => payload };
  };
}
const realFetchWithTimeout = window.App.util.fetchWithTimeout;
afterEach(() => {
  window.App.util.fetchWithTimeout = realFetchWithTimeout;
});

describe("missing set-id map degrades to the legacy path", () => {
  test("ppSetEntry returns null when the map fails to load", async () => {
    stubFailingMap(() => ({ data: [] }));
    expect(await P.ppSetEntry("sv01")).toBe(null);
  });

  test("findCardId with a setId still works via the legacy name match", async () => {
    let seenParams = null;
    stubFailingMap((path, params) => {
      seenParams = params;
      if (path === "/v1/cards") {
        return {
          data: [
            { id: "10699", set: { name: "Fossil" }, number: "12" },
          ],
        };
      }
      return { data: [] };
    });
    const id = await P.findCardId({
      name: "Moltres",
      setName: "Fossil",
      number: "12",
      lang: "en",
      setId: "fo",
    });
    expect(seenParams.set_id).toBe(undefined);
    expect(id).toBe("10699");
  });
});
