/* VaultDex unit tests — App.ui.money / timeAgo (js/ui.js). */
import { describe, test, expect } from "vitest";
import "../js/util.js"; // loaded first, matching the browser script order
import "../js/ui.js";

const { money, timeAgo } = window.App.ui;

describe("money", () => {
  test("formats USD with two decimals", () => {
    expect(money(12.5)).toBe("$12.50");
    expect(money(0)).toBe("$0.00");
    expect(money(959.68)).toBe("$959.68");
  });

  test("rounds to two decimals", () => {
    expect(money(1234.567)).toBe("$1234.57");
  });

  test("formats EUR with the euro symbol", () => {
    expect(money(5, "EUR")).toBe("€5.00");
    expect(money(0.15, "EUR")).toBe("€0.15");
  });

  test("null/undefined/NaN render as an em dash", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(NaN)).toBe("—");
    expect(money("abc")).toBe("—");
  });

  test("numeric strings are accepted", () => {
    expect(money("12.5")).toBe("$12.50");
  });
});

describe("timeAgo", () => {
  const MIN = 60 * 1000, HOUR = 3600 * 1000, DAY = 24 * HOUR;

  test("falsy timestamps -> never", () => {
    expect(timeAgo(null)).toBe("never");
    expect(timeAgo(undefined)).toBe("never");
    expect(timeAgo(0)).toBe("never");
    expect(timeAgo("")).toBe("never");
  });

  test("under a minute -> just now", () => {
    expect(timeAgo(Date.now())).toBe("just now");
    expect(timeAgo(Date.now() - 59 * 1000)).toBe("just now");
  });

  test("minutes", () => {
    expect(timeAgo(Date.now() - 60 * 1000)).toBe("1m ago");
    expect(timeAgo(Date.now() - 5 * MIN)).toBe("5m ago");
    expect(timeAgo(Date.now() - 59 * MIN)).toBe("59m ago");
  });

  test("hours", () => {
    expect(timeAgo(Date.now() - HOUR)).toBe("1h ago");
    expect(timeAgo(Date.now() - 3 * HOUR)).toBe("3h ago");
    expect(timeAgo(Date.now() - 23 * HOUR)).toBe("23h ago");
  });

  test("days", () => {
    expect(timeAgo(Date.now() - DAY)).toBe("1d ago");
    expect(timeAgo(Date.now() - 2 * DAY)).toBe("2d ago");
  });
});
