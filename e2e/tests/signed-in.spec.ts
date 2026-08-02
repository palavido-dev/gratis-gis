// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signed-in happy path through the real Keycloak form. Skipped
 * unless E2E_SIGNIN=1 because it depends on the tester accounts
 * (seeded on the demo and on dev via seed-test-users.sh) and the
 * demo resets nightly; run it deliberately, not in the anonymous
 * prod smoke.
 *
 *   E2E_SIGNIN=1 pnpm -C e2e e2e -- signed-in
 *
 * Credentials default to the public demo testers; override with
 * E2E_USER / E2E_PASSWORD for a private deployment.
 */
import { test, expect } from '@playwright/test';

const RUN = process.env.E2E_SIGNIN === '1';
const USER = process.env.E2E_USER ?? 'tester-viewer';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Viewer123!';

test.skip(!RUN, 'set E2E_SIGNIN=1 to run the signed-in flow');

test('tester signs in and lands on the items grid', async ({ page }) => {
  await page.goto('/items');
  // Keycloak's login form. The demo theme adds a credential panel,
  // but the underlying form fields are the parent theme's.
  await page.waitForSelector('#username', { timeout: 20_000 });
  await page.fill('#username', USER);
  await page.fill('#password', PASSWORD);
  await page.click('input[type="submit"], button[type="submit"]');

  // Back on the portal, signed in: the app shell chrome renders the
  // user menu with the account's display name.
  await page.waitForURL(/\/items/, { timeout: 20_000 });
  await expect(
    page.getByRole('button', { name: /tester/i }).first(),
  ).toBeVisible({ timeout: 15_000 });

  // The signed-in identity is usable, not just painted: /users/me
  // through the BFF answers 200 with this account (the dead-session
  // incident is exactly the state where the header lies about this).
  const me = await page.request.get('/api/portal/users/me');
  expect(me.status()).toBe(200);
});
