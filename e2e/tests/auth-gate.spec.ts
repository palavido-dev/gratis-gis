// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The auth boundary, from the outside. These assert the shape of the
 * gate rather than its internals: anonymous visitors get routed
 * toward sign-in, and the API answers anonymous requests with 401
 * JSON rather than an HTML error page (#197 made every API error
 * HTML once; this keeps that class of regression visible).
 */
import { test, expect } from '@playwright/test';

test('anonymous /items routes to sign-in', async ({ page }) => {
  await page.goto('/items');
  // Middleware sends anonymous traffic to /signin, which immediately
  // forwards to Keycloak on a different host (auth subdomain in prod,
  // localhost:8081 in dev). Accept either resting place; the point is
  // we did NOT land on the items grid.
  await page.waitForURL(/signin|auth\.|:8081|openid-connect/i, {
    timeout: 15_000,
  });
  expect(page.url()).not.toContain('/items');
});

test('anonymous portal API answers 401 JSON, not HTML', async ({ request }) => {
  const res = await request.get('/api/portal/users/me');
  expect(res.status()).toBe(401);
  const type = res.headers()['content-type'] ?? '';
  expect(type).toContain('application/json');
  const body = (await res.json()) as { message?: string };
  expect(body.message).toBeTruthy();
});

test('a nonexistent item detail does not leak a stack trace', async ({
  page,
}) => {
  const res = await page.goto('/items/00000000-0000-4000-8000-000000000000');
  // Anonymous hit on a private/unknown item: any of redirect to
  // sign-in, 404, or a friendly error page is acceptable. A raw
  // stack trace or Next's dev overlay is not.
  expect(res?.status()).toBeLessThan(500);
  const text = await page.content();
  expect(text).not.toMatch(/at async|__webpack|Unhandled Runtime Error/);
});
