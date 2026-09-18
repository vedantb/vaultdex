/* VaultDex ESLint config — Phase 1 CI gate.
 *
 * Zero-build vanilla JS, so there is no bundler to catch mistakes: this config
 * is the deploy gate. It uses the `recommended` rule set only — no stylistic
 * rules, no reformatting. The goal is to catch syntax-adjacent and egregious
 * errors (undefined variables, unused vars, bad regex, unreachable code), not
 * to enforce a code style.
 *
 * Scope: js/ (browser app), api/ (Vercel serverless function), and this file.
 * Explicitly NOT linted:
 *   - data/          huge generated JSON catalog files
 *   - scripts/       Python pipeline (gated by compileall in CI instead)
 *   - js/vendor/     vendored supabase-js bundle — third-party code
 *   - node_modules, .vercel   tool output
 */
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      ".vercel/**",
      "data/**",
      "scripts/**",
      "js/vendor/**",
    ],
  },

  // Browser app code. Plain <script> files (no modules, no bundler):
  // everything hangs off the shared `App` namespace on window.
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        App: "writable",
      },
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },

  // Vercel serverless function: Node, CommonJS (module.exports).
  {
    files: ["api/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },

  // This config file itself (Node ESM).
  {
    files: ["eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },
];
