import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'ui*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 940 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
