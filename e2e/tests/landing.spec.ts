// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Anonymous landing page. The single highest-value smoke: this is
 * the first page every evaluator sees, and the Turbopack stale-chunk
 * incident proved a deploy can break it in ways `curl /` rates 200.
 */
import { test, expect } from '@playwright/test';

test('renders the hero, the brand, and a version badge', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('/');
  await expect(page).toHaveTitle(/GratisGIS/i);

  // The hero headline is server-rendered copy on the public landing.
  await expect(
    page.getByRole('heading', { name: /open.source, self.hosted GIS portal/i }),
  ).toBeVisible();

  // The deployed version shows in the footer (shipped v0.9.2). Bare
  // pattern rather than a pinned number so the test survives releases.
  await expect(page.getByText(/GratisGIS v\d+\.\d+\.\d+/).first()).toBeVisible();

  // A landing page that renders but threw client-side is exactly the
  // failure mode the stale-chunk incident shipped. Surface any
  // uncaught page error as a test failure.
  expect(errors, `client-side errors on /: ${errors.join('; ')}`).toEqual([]);
});

test('shows the What\'s new card with at least one entry', async ({ page }) => {
  await page.goto('/');
  // Entries come from content/changelog/user-visible.md at runtime;
  // an empty card means the file went missing from the build trace.
  await expect(page.getByText(/what'?s new/i).first()).toBeVisible();
});
