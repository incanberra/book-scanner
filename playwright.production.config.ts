import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/production',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4174/book-scanner/',
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4174',
    env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'incanberra/book-scanner' },
    url: 'http://127.0.0.1:4174/book-scanner/',
    reuseExistingServer: false
  }
});
