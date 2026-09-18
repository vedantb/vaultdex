/* VaultDex unit tests — js/util.js pure helpers.
 *
 * The app files are plain browser scripts that hang everything off the
 * shared `window.App` namespace; jsdom provides `window` so they load
 * unchanged. No app code is modified for testability except hoisting
 * matchRows into App.util (behavior-identical).
 */
import { describe, test, expect } from "vitest";
import "../js/util.js";

const { normNumber, matchRows } = window.App.util;

describe("normNumber", () => {
  test("strips leading zeros from padded TCGdex numbers", () => {
    expect(normNumber("001")).toBe("1");
    expect(normNumber("092")).toBe("92");
  });

  test("trims and lowercases", () => {
    expect(normNumber("  AB12 ")).toBe("ab12");
  });

  test("handles null/undefined/empty", () => {
    expect(normNumber(null)).toBe("");
    expect(normNumber(undefined)).toBe("");
    expect(normNumber("")).toBe("");
  });

  test("keeps a lone zero", () => {
    expect(normNumber("000")).toBe("0");
  });

  test("leaves non-padded numbers alone", () => {
    expect(normNumber("25")).toBe("25");
    expect(normNumber("TG03")).toBe("tg03");
  });
});

describe("matchRows (set-page checkbox fix, 2026-09-17)", () => {
  const holoBox = { vlabel: "holo" };
  const normalBox = { vlabel: "normal" };

  test("no rows -> empty", () => {
    expect(matchRows(undefined, holoBox, [holoBox])).toEqual([]);
    expect(matchRows([], holoBox, [holoBox])).toEqual([]);
  });

  test("single-printing card: any row counts, even with a mismatched variant", () => {
    // This is the exact checkbox bug: the row's variant didn't match the
    // box, so the box looked checked yet unchecking silently added a
    // duplicate row. Returning the row means toggle treats it as "was
    // checked" and removes it instead of duplicating.
    const rows = [{ id: 7, vlabel: "holo" }];
    const match = matchRows(rows, normalBox, [normalBox]);
    expect(match).toEqual(rows);
    expect(match[0]).toBe(rows[0]); // same refs: toggle removes by identity
  });

  test("unknown box (details not loaded yet): any row counts", () => {
    const rows = [{ id: 1, vlabel: "reverse" }];
    expect(matchRows(rows, { vlabel: "unknown" }, [normalBox, holoBox])).toEqual(rows);
  });

  test("no box: any row counts", () => {
    const rows = [{ id: 1, vlabel: "normal" }];
    expect(matchRows(rows, null, [normalBox])).toEqual(rows);
  });

  test("multi-printing card: only the box's own variant matches", () => {
    const rows = [
      { id: 1, vlabel: "normal" },
      { id: 2, vlabel: "holo" },
    ];
    const match = matchRows(rows, holoBox, [normalBox, holoBox]);
    expect(match).toEqual([{ id: 2, vlabel: "holo" }]);
    expect(match[0]).toBe(rows[1]); // same ref for identity-based removal
  });

  test("multi-printing card with no matching row -> empty", () => {
    const rows = [{ id: 1, vlabel: "normal" }];
    expect(matchRows(rows, holoBox, [normalBox, holoBox])).toEqual([]);
  });
});
