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

/**
 * The published dashboards, rendered as an anonymous visitor sees
 * them.
 *
 * This exists because of a specific outage: a `useMemo` closed over a
 * `const` declared below it, which reads that const before
 * initialization and throws. TypeScript considers the reference in
 * scope, because block scoping is a runtime property, so it
 * typechecked, built, passed 1,418 unit tests, and took every custom
 * app down on load. ESLint cannot catch it either: `no-use-before-
 * define` does not flag a reference inside a nested function, and a
 * memo callback is a nested function.
 *
 * Nothing static catches this class. Loading the page does. So the
 * check is simply: does the app runtime render, and is the error
 * boundary absent.
 */
for (const [name, id] of [
  ['storm events', '3f05dd23-0c6f-4e08-89f4-98d095970629'],
  ['bridges', '5f2884a4-9668-4a84-9de8-040bf28844ee'],
  ['facilities', '0575ebe7-3e52-40bc-aebb-688aa5379840'],
] as const) {
  test(`the ${name} dashboard renders for an anonymous visitor`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    const res = await page.goto(`/items/${id}/custom/run`);
    expect(res?.status()).toBe(200);

    // The runtime's error boundary. Asserting on its ABSENCE is the
    // point: a crashed app still returns 200 and still has a title,
    // so the status code says nothing.
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    // Something the app actually rendered, so an empty page cannot
    // pass by having no error on it either.
    await expect(page.locator('canvas.maplibregl-canvas').first()).toBeVisible({
      timeout: 30_000,
    });

    expect(errors, `uncaught errors on the ${name} dashboard`).toEqual([]);
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
