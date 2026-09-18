// VaultDex Playwright config — smoke tests only (chromium, signed-out).
// Runs against BASE_URL (default: local static server on :8080); the daily
// scheduled workflow points BASE_URL at production instead. No secrets.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "qa",
  testMatch: "**/*.spec.js",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL || "http://127.0.0.1:8080",
    viewport: { width: 390, height: 844 }, // iPhone-class mobile viewport
    trace: "off",
  },
  projects: [{ name: "chromium" }],
});
