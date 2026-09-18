/* VaultDex — vitest config (CI Phase 2).
 *
 * Dev-only test runner config. The app itself stays zero-build vanilla JS:
 * no build scripts, no buildCommand changes. Tests import the plain
 * browser script files directly under jsdom so the App.* namespace works
 * exactly as it does in the browser.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.js"],
  },
});
