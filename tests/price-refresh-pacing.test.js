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

  test("rapid calls are spaced at least ~1200ms apart (50 req/min, under the provider's 60/min)", async () => {
    const starts = [];
    window.App.util.fetchWithTimeout = okFetch(starts);
    await Promise.all([
      P.api("/v1/cards", {}),
      P.api("/v1/cards", {}),
      P.api("/v1/cards", {}),
    ]);
    expect(starts.length).toBe(3);
    // 1200ms minus timer slop (timers never fire early, only late).
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1000);
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
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
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

describe("cross-tab pacer (shared via localStorage)", () => {
  const KEY = "vaultdex_pkmn_pacer_last";
  afterEach(() => { try { window.localStorage.removeItem(KEY); } catch { /* ignore */ } });

  test("a tab respects another tab's recent start", async () => {
    const starts = [];
    window.App.util.fetchWithTimeout = okFetch(starts);
    // Simulate another tab starting a call right now.
    window.localStorage.setItem(KEY, String(Date.now()));
    const t0 = Date.now();
    await P.api("/v1/cards", {});
    // Must wait ~1200ms for the other tab's slot (plus jitter).
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(starts.length).toBe(1);
  });

  test("stale localStorage timestamps don't block", async () => {
    const starts = [];
    window.App.util.fetchWithTimeout = okFetch(starts);
    // Let the in-memory pacer from prior tests expire.
    await new Promise(function (r) { setTimeout(r, 1300); });
    window.localStorage.setItem(KEY, String(Date.now() - 10000));
    const t0 = Date.now();
    await P.api("/v1/cards", {});
    expect(Date.now() - t0).toBeLessThan(500);
    expect(starts.length).toBe(1);
  });
});

describe("leader election (one tab runs the bulk pass)", () => {
  const KEY = "vaultdex_price_refresh_leader";
  afterEach(() => { try { window.localStorage.removeItem(KEY); } catch { /* ignore */ } });

  test("first tab becomes leader", () => {
    const id = C.tryBecomeLeader();
    expect(typeof id).toBe("string");
    C.releaseLeader(id);
  });

  test("second tab defers while the leader's heartbeat is fresh", () => {
    const id1 = C.tryBecomeLeader();
    expect(id1).toBeTruthy();
    const id2 = C.tryBecomeLeader();
    expect(id2).toBeNull();
    C.releaseLeader(id1);
  });

  test("a stale leader is superseded", () => {
    const id1 = C.tryBecomeLeader();
    expect(id1).toBeTruthy();
    // Age the heartbeat past the 30s TTL.
    window.localStorage.setItem(KEY, JSON.stringify({ id: id1, at: Date.now() - 31000 }));
    const id2 = C.tryBecomeLeader();
    expect(typeof id2).toBe("string");
    expect(id2).not.toBe(id1);
    C.releaseLeader(id2);
  });

  test("release only removes our own claim", () => {
    const id1 = C.tryBecomeLeader();
    C.releaseLeader("someone-else");
    // Our claim survives a foreign release.
    expect(C.tryBecomeLeader()).toBeNull();
    C.releaseLeader(id1);
    // Now it's free.
    const id2 = C.tryBecomeLeader();
    expect(typeof id2).toBe("string");
    C.releaseLeader(id2);
  });
});
