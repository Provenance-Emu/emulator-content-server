import { defineConfig, devices } from '@playwright/test';

delete process.env.NO_COLOR;
const executablePath = process.env.ECS_WEBKIT_EXECUTABLE;
export default defineConfig({
  testDir: './test/browser',
  testMatch: [
    'player-capture-real.spec.ts',
    'player-sandbox.spec.ts',
    'player-capture-controls.spec.ts',
    'player-settings.spec.ts',
    'player-input.spec.ts',
  ],
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: 'list',
  use: { headless: false, actionTimeout: 5000, trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'webkit',
      use: { browserName: 'webkit', launchOptions: executablePath ? { executablePath } : {} },
    },
    {
      name: 'iphone-webkit',
      use: {
        ...devices['iPhone 13'],
        browserName: 'webkit',
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
});
