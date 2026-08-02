// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Playwright config for the portal smoke suite.
 *
 * One suite, two targets, chosen by E2E_BASE_URL:
 *
 *   (unset)                     -> http://localhost:3000, the dev
 *                                  stack (`pnpm dev` + `pnpm infra:up`)
 *   https://gratisgis.org       -> the deployed demo, which is what
 *                                  the scheduled prod-smoke workflow
 *                                  points at
 *
 * Every spec in smoke/ must hold against BOTH targets, which means
 * anonymous surfaces only and no assumptions about content beyond
 * what the golden demo guarantees. Signed-in flows live in
 * signed-in.spec.ts and skip themselves unless E2E_SIGNIN=1, because
 * they mutate state and the demo resets nightly; run those locally
 * or point them at a scratch deployment.
 *
 * This is phase 1 of the front-end testing plan (Playwright happy
 * paths first, component tests only for genuinely stateful widgets
 * later, no visual regression pre-v1).
 */
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  // Smoke tests are read-only and independent; parallel is safe.
  fullyParallel: true,
  // A prod smoke that fails deserves one honest retry before it
  // pages anyone: the demo box is small and a nightly-reset window
  // or a cold Next route can produce a one-off slow response.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
