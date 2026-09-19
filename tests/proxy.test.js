/* VaultDex — unit tests for the PkmnPrices proxy's credit-burn guard.
 *
 * The proxy bills 1 PkmnPrices credit per item returned, so per_page must be
 * clamped per caller type: browsers get the page size the app uses (50),
 * script callers (shared-secret header) get headroom (200).
 */
import { describe, test, expect, afterEach } from "vitest";
import proxy from "../api/pkmnprices.js";
const { capPerPage, callerMode, MAX_PER_PAGE } = proxy;

describe("capPerPage", () => {
  test("browser callers are capped at 50", () => {
    expect(capPerPage("100", "browser")).toBe(50);
    expect(capPerPage("1000", "browser")).toBe(50);
  });

  test("script callers are capped at 200", () => {
    expect(capPerPage("500", "script")).toBe(200);
    expect(capPerPage("1000", "script")).toBe(200);
  });

  test("values under the cap pass through", () => {
    expect(capPerPage("25", "browser")).toBe(25);
    expect(capPerPage("50", "browser")).toBe(50);
    expect(capPerPage("150", "script")).toBe(150);
  });

  test("garbage input falls back to the cap, never upstream default", () => {
    expect(capPerPage("abc", "browser")).toBe(50);
    expect(capPerPage("", "browser")).toBe(50);
    expect(capPerPage("0", "browser")).toBe(50);
    expect(capPerPage("-5", "browser")).toBe(50);
    expect(capPerPage(undefined, "script")).toBe(200);
  });

  test("unknown mode defaults to the browser cap (fail closed)", () => {
    expect(capPerPage("1000", "nobody")).toBe(MAX_PER_PAGE.browser);
    expect(capPerPage("1000", null)).toBe(MAX_PER_PAGE.browser);
  });
});

describe("callerMode", () => {
  const OLD = process.env.PROXY_SHARED_SECRET;
  afterEach(() => {
    if (OLD === undefined) delete process.env.PROXY_SHARED_SECRET;
    else process.env.PROXY_SHARED_SECRET = OLD;
  });

  function req(headers) {
    return { headers };
  }

  test("valid shared secret wins over everything", () => {
    process.env.PROXY_SHARED_SECRET = "s3cret";
    expect(callerMode(req({ "x-vaultdex-key": "s3cret" }))).toBe("script");
    expect(
      callerMode(req({ "x-vaultdex-key": "s3cret", referer: "https://evil.example/" }))
    ).toBe("script");
  });

  test("wrong secret falls back to the Referer check", () => {
    process.env.PROXY_SHARED_SECRET = "s3cret";
    expect(
      callerMode(req({ "x-vaultdex-key": "wrong", referer: "https://vaultdex-three.vercel.app/" }))
    ).toBe("browser");
    expect(callerMode(req({ "x-vaultdex-key": "wrong" }))).toBe(null);
  });

  test("no secret configured: Referer decides", () => {
    delete process.env.PROXY_SHARED_SECRET;
    expect(callerMode(req({ referer: "https://vaultdex-three.vercel.app/set/me02" }))).toBe(
      "browser"
    );
    expect(callerMode(req({ origin: "http://localhost:8080" }))).toBe("browser");
    expect(callerMode(req({ referer: "https://evil.example/" }))).toBe(null);
    expect(callerMode(req({}))).toBe(null);
  });
});
