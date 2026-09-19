// VaultDex Playwright config — full QA suite (chromium).
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
    // Local runs use the QA rig's Chromium (Playwright's bundled browser
    // isn't installed on the dev VM): QA_CHROME=/path/to/chrome.
    // CI leaves this unset and uses the installed bundle.
    // QA_CHROME_ARGS adds launch flags, e.g. the relay proxy this VM needs
    // for external hosts:
    //   --proxy-server=http://127.0.0.1:8888 --proxy-bypass-list=127.0.0.1,localhost --ignore-certificate-errors
    launchOptions: process.env.QA_CHROME
      ? {
          executablePath: process.env.QA_CHROME,
          args: ["--no-sandbox"].concat(
            (process.env.QA_CHROME_ARGS || "").split(" ").filter(Boolean)
          )
        }
      : {},
  },
  projects: [{ name: "chromium" }],
});
