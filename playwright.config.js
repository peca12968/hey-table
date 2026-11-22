import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  projects: ["chromium", "firefox"].map(browserName => ({ name: browserName, use: { browserName } }))
});
