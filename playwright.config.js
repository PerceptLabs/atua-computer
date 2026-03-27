import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  testMatch: '*.spec.js',
  timeout: 60000,
  use: {
    headless: true,
    browserName: 'chromium',
  },
});
