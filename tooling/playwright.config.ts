import { defineConfig, devices } from '@playwright/test'

const runId = process.env.JB_TEST_RUN_ID
const artifactDir = runId ? `../test-results/playwright/${runId}` : '../test-results/playwright'
const reportDir = runId ? `../test-results/playwright-report/${runId}` : '../test-results/playwright-report'
const port = Number(process.env.JB_TEST_PORT || 4173)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: '../tests/e2e',
  outputDir: artifactDir,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ['line'],
    ['html', { outputFolder: reportDir, open: 'never' }],
  ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
