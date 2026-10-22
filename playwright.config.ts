import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    channel: process.env.CI ? undefined : "chrome",
    ...devices["Desktop Chrome"],
    viewport: { width: 390, height: 844 },
    trace: "on-first-retry"
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    // Never silently test a different app already listening on this port.
    reuseExistingServer: false,
    timeout: 120_000
  }
});
