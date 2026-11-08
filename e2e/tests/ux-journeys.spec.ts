// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Product journeys against a locally run portal-web. The wizard,
 * search, and notifications link render on /dev/ux-fixture, which
 * exists only when the server is started with GRATIS_UX_FIXTURE=1.
 * The public landing is the real page.
 */
import { test, expect } from '@playwright/test';

test('public landing stays public and sign-in continues into items', async ({
  page,
}) => {
  const response = await page.goto('/');
  expect(response?.status()).toBeLessThan(500);
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toHaveAttribute(
    'href',
    '/signin?callbackUrl=%2Fitems',
  );
});

test('new item wizard leads with upload, map, and form', async ({ page }) => {
  await page.goto('/dev/ux-fixture');
  await expect(page.getByRole('button', { name: 'Data layer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Map' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Form' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Point cloud' })).toHaveCount(0);
  await page.getByRole('button', { name: 'More item types' }).click();
  await expect(page.getByRole('button', { name: 'Point cloud' })).toBeVisible();
  await page.getByRole('button', { name: 'Point cloud' }).focus();
  await expect(page.getByRole('button', { name: 'Point cloud' })).toBeFocused();
  await page.getByRole('button', { name: 'Fewer item types' }).click();
  await expect(page.getByRole('button', { name: 'Point cloud' })).toHaveCount(0);
});

test('a type deep link still opens that item', async ({ page }) => {
  await page.goto('/dev/ux-fixture?type=point_cloud');
  await expect(page.getByRole('button', { name: 'More item types' })).toHaveCount(0);
  await expect(page.getByText('Point cloud').first()).toBeVisible();
});

test('search scope and the notifications link are explicit', async ({ page }) => {
  await page.goto('/dev/ux-fixture');
  const search = page.getByRole('searchbox', { name: 'Search items' });
  await expect(search).toHaveAttribute('placeholder', 'Search items only');
  await expect(search).toHaveAttribute('aria-describedby', 'top-search-scope');
  await expect(page.locator('#top-search-scope')).toContainText('People and groups');
  const bell = page.getByRole('link', { name: 'Notifications' });
  await expect(bell).toHaveAttribute('href', '/settings/notifications');
  await bell.click();
  await expect(page).toHaveURL(/signin/);
  await expect(page).toHaveURL(/settings%2Fnotifications|settings\/notifications/);
});

test('the wizard fits a phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dev/ux-fixture');
  const form = page.getByRole('button', { name: 'Form' });
  await expect(form).toBeVisible();
  const box = await form.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(100);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
});
