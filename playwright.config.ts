import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts', // Keep Playwright files out of bun test discovery.
  workers: 1,
  timeout: 90_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:14320',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bun server.ts',
    url: 'http://127.0.0.1:14320',
    env: { PORT: '14320', DBM_DATA_FILE: '.e2e/app.sqlite' },
    reuseExistingServer: false,
  },
});
