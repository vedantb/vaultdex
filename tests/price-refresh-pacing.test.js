/* VaultDex unit tests — 2026-10-07 view-scoped refresh + global pacing.
 *
 * Two changes pin down here:
 *  1. App.pkmn.api() paces every proxy call (>=600ms apart), capping the
 *     whole app at ~100 req/min no matter how many features fire at once.
 *  2. scopeRefreshQueue() restricts a refresh pass to an explicit id
 *     allow-list (the Refresh button's visible stale rows).
 */
import { describe, test, expect, afterEach } from "vitest";
import "../js/util.js";
import "../js/pkmn.js";
import "../js/tcg-api.js"; // real normVLabel for collection.js's pure seams
import "../js/collection.js";

const P = window.App.pkmn;
const C = window.App.collection;

const realFetchWithTimeout = window.App.util.fetchWithTimeout;
afterEach(() => { window.App.util.fetchWithTimeout = realFetchWithTimeout; });

function okFetch(starts) {
  return async () => {
    starts.push(Date.now());
    return { status: 200, ok: true, json: async () => ({ data: [] }) };
  };
}

describe("pkmn api() global pacer", () => {
  /* NOTE: these run in order — the isolated-call test must come first,
   * while the pacer has never been used in this module instance. */
  test("an isolated call is not delayed", async () => {
    const starts = [];
    window.App.util.fetchWithTimeout = okFetch(starts);
    const t0 = Date.now();
    await P.api("/v1/cards", { per_page: 1 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(starts.length).toBe(1);
  });

  test("rapid calls are spaced at least ~600ms apart", async () => {
    const starts = [];
    window.App.util.fetchWithTimeout = okFetch(starts);
    await Promise.all([
      P.api("/v1/cards", {}),
      P.api("/v1/cards", {}),
      P.api("/v1/cards", {}),
    ]);
    expect(starts.length).toBe(3);
    // 600ms minus timer slop (timers never fire early, only late).
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(500);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(500);
  });

  test("a failed call does not wedge the queue", async () => {
    const starts = [];
    let calls = 0;
    window.App.util.fetchWithTimeout = async () => {
      starts.push(Date.now());
      calls++;
      if (calls === 1) throw new Error("boom");
      return { status: 200, ok: true, json: async () => ({}) };
    };
    await expect(P.api("/v1/cards", {})).rejects.toThrow("boom");
    await P.api("/v1/cards", {});
    expect(starts.length).toBe(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(500);
  });
});

describe("scopeRefreshQueue (view-scoped refresh)", () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  test("null allow-list keeps the whole queue", () => {
    expect(C.scopeRefreshQueue(rows, null)).toEqual(rows);
    expect(C.scopeRefreshQueue(rows, undefined)).toEqual(rows);
  });
  test("restricts to the listed ids", () => {
    expect(C.scopeRefreshQueue(rows, [3, 1]).map((r) => r.id)).toEqual([1, 3]);
  });
  test("an empty allow-list restricts to nothing (never a full pass)", () => {
    expect(C.scopeRefreshQueue(rows, [])).toEqual([]);
  });
  test("unknown ids match nothing", () => {
    expect(C.scopeRefreshQueue(rows, [99])).toEqual([]);
  });
});
