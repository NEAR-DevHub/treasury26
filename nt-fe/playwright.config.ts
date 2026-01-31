import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for Treasury26 Frontend E2E Tests
 * 
 * Uses the published sandbox Docker image as the backend.
 * Run with: npx playwright test
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  
  use: {
    baseURL: "http://localhost:3000",
    video: process.env.CI ? "retry-with-video": "on",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /* Run local dev server before starting the tests */
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    env: {
      NEXT_PUBLIC_BACKEND_API_BASE: process.env.BACKEND_URL || "http://localhost:8080",
    },
  },
});
