import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3100);

// Keyboard-only tests of the billing flow against a seeded shop server.
// Build the screens first: pnpm --filter @aruna/web build
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1366, height: 800 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: './e2e/start-server.sh',
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
