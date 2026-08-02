// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The anonymous public surfaces around the landing page. Cheap
 * coverage for routes nobody looks at until a visitor does.
 */
import { test, expect } from '@playwright/test';

for (const path of ['/why', '/credits', '/feedback']) {
  test(`${path} renders with a heading`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
}

test('robots.txt exists and disallows the private surfaces', async ({
  request,
}) => {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('/signin');
});

test('the icon set answers: favicon, apple touch, svg', async ({ request }) => {
  // Browsers and link previews guess these literal paths without
  // reading any markup; each one 404ing was a real-visitor wart the
  // analytics caught (v0.9.4).
  for (const path of [
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/icon.svg',
  ]) {
    const res = await request.get(path);
    expect(res.status(), `${path} should be served`).toBe(200);
  }
});

test('the field PWA manifest is valid and iconed', async ({ request }) => {
  const res = await request.get('/field/manifest.webmanifest');
  expect(res.status()).toBe(200);
  const manifest = (await res.json()) as {
    name?: string;
    icons?: Array<{ src: string }>;
  };
  expect(manifest.name).toBeTruthy();
  expect(manifest.icons?.length ?? 0).toBeGreaterThan(0);
});
