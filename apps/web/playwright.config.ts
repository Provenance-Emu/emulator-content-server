import { defineConfig } from '@playwright/test';

// Playwright forces color for workers; inherit one color policy without contradictory flags.
delete process.env.NO_COLOR;
export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 4_000 },
  reporter: 'list',
  use: {
    actionTimeout: 4_000,
    browserName: 'chromium',
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
