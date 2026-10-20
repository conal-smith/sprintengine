// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // `.multi-code/` and the agent CLIs' skill dirs are local state SprintEngine
    // Studio and the agents write into any folder they open (gitignored). They
    // are not app source: `.multi-code/` can hold worktree copies of the app,
    // which would double-report every finding, and the skill dirs hold
    // vendored third-party packs written as plain CommonJS Node scripts.
    // `*.generated.ts` is written by a script from vendored bundles (the
    // renderer page is four megabytes of minified Mermaid and KaTeX); the
    // script and its inputs are what is linted.
    ignores: [
      "dist/*",
      "src/**/*.generated.ts",
      ".multi-code/**",
      ".claude/skills/**",
      ".codex/skills/**",
      ".grok/skills/**",
      ".opencode/skills/**",
    ],
  }
]);
