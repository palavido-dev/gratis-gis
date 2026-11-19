// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Capture the UI screenshots the help pages embed.
 *
 * Every image is one entry in SHOTS below: the file it writes, the
 * tester account it signs in as, and the steps that bring the screen
 * up. Each entry runs on its own, so one broken step is reported and
 * the rest still run. When the UI changes, fix the entry that broke
 * and rerun only it with HELP_SHOT_ONLY.
 *
 *   node e2e/scripts/capture-help-screenshots.mjs
 *   HELP_SHOT_ONLY=analysis/ node e2e/scripts/capture-help-screenshots.mjs
 *
 * Targets the public demo by default. The item ids below are the
 * demo's sample content, which the nightly reset restores with the
 * same ids. Against another install, set E2E_BASE_URL and the
 * GG_SHOT_* ids, or the item shots fail with "not found".
 *
 * Accounts are the demo's published testers. Override with
 * E2E_CONTRIBUTOR / E2E_CONTRIBUTOR_PASSWORD and E2E_ADMIN /
 * E2E_ADMIN_PASSWORD.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'apps/portal-web/public/help');

const BASE = process.env.E2E_BASE_URL ?? 'https://demo.gratisgis.org';
const ONLY = process.env.HELP_SHOT_ONLY ? new RegExp(process.env.HELP_SHOT_ONLY) : null;
const VIEWPORT = { width: 1440, height: 900 };

const ACCOUNTS = {
  contributor: {
    user: process.env.E2E_CONTRIBUTOR ?? 'tester-contributor',
    password: process.env.E2E_CONTRIBUTOR_PASSWORD ?? 'Contributor123!',
  },
  admin: {
    user: process.env.E2E_ADMIN ?? 'tester-admin',
    password: process.env.E2E_ADMIN_PASSWORD ?? 'Admin123!',
  },
};

// Demo sample content.
const ID = {
  explorerMap: process.env.GG_SHOT_MAP ?? 'cae7177d-4bd9-49c3-b654-45632eafb6be',
  facilities: process.env.GG_SHOT_POINTS ?? '0700bca4-cc41-46dd-a79f-22d566801156',
  parks: process.env.GG_SHOT_POLYGONS ?? 'ee8f5610-e54d-4966-8c62-d95671798df2',
  ownLayer: process.env.GG_SHOT_OWN_LAYER ?? 'f8359e30-cf93-402f-945a-3c0b35d62037',
  viewerApp: process.env.GG_SHOT_VIEWER ?? '9e235fd1-930c-4dfb-876e-64ee089990e6',
  customApp: process.env.GG_SHOT_CUSTOM_APP ?? '0575ebe7-3e52-40bc-aebb-688aa5379840',
  form: process.env.GG_SHOT_FORM ?? '1607ca7f-0c3a-485f-abbf-e52dc0aa2320',
};

// ---------------------------------------------------------------- helpers

async function go(page, url, settleMs = 2500) {
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
}

/** Scroll so `locator` sits just below the top bar, in whatever container scrolls. */
async function scrollToTop(locator, offset = 80) {
  await locator.first().waitFor({ state: 'visible' });
  await locator.first().evaluate((el, off) => {
    el.scrollIntoView({ block: 'start' });
    let node = el.parentElement;
    while (node && node !== document.body) {
      const s = getComputedStyle(node);
      if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight) {
        node.scrollBy(0, -off);
        return;
      }
      node = node.parentElement;
    }
    window.scrollBy(0, -off);
  }, offset);
  await locator.page().waitForTimeout(500);
}

async function hideFloating(page) {
  // The feedback button sits over the bottom right of every page. The
  // page's CSP refuses an injected <style>, so hide it in place.
  await page
    .evaluate(() => {
      for (const el of document.querySelectorAll('.fixed.bottom-4.right-4')) {
        if (/feedback/i.test(el.textContent ?? '')) el.style.display = 'none';
      }
    })
    .catch(() => {});
}

/** One derived-layer recipe with `tool` as its only step. */
function recipeShot(file, tool, source = ID.parks) {
  return {
    file,
    as: 'contributor',
    async run(page) {
      await go(page, `/items/new?type=derived_layer&source=${source}`);
      if (tool !== 'Buffer') {
        await page.getByRole('button', { name: 'Remove step 1' }).click();
        await page.getByRole('button', { name: 'Add a step' }).first().click();
        const dialog = page.getByRole('dialog');
        await dialog.getByText(tool, { exact: true }).click();
        await page.waitForTimeout(800);
      }
      await scrollToTop(page.getByRole('heading', { name: 'Recipe' }));
    },
  };
}

// ---------------------------------------------------------------- shots

const SHOTS = [
  // Getting started
  {
    file: 'getting-started/what-is-gratisgis-items-grid.png',
    as: 'contributor',
    async run(page) {
      await go(page, '/items?scope=all', 3000);
    },
  },
  {
    file: 'getting-started/creating-your-first-map-new-item.png',
    as: 'contributor',
    async run(page) {
      await go(page, '/items/new?type=map');
      await page.getByPlaceholder(/My layer, report/).fill('Trail conditions map');
      await page.getByPlaceholder(/What is this/).fill('Trails and parks for the weekend crew.');
    },
  },
  {
    file: 'getting-started/creating-your-first-map-builder.png',
    as: 'contributor',
    async run(page) {
      await go(page, `/items/${ID.explorerMap}?view=configure`, 6000);
    },
  },
  {
    file: 'getting-started/sharing-an-item-access.png',
    as: 'contributor',
    async run(page) {
      await go(page, `/items/${ID.ownLayer}`);
      await page.getByRole('tab', { name: 'Share' }).click();
      await page.waitForTimeout(1500);
      await scrollToTop(page.getByText('Visibility', { exact: true }), 120);
    },
  },
  {
    file: 'getting-started/uploading-csv-import.png',
    as: 'contributor',
    async run(page) {
      await go(page, '/items/new?type=data_layer');
      await scrollToTop(page.getByRole('heading', { name: 'Layers & tables' }));
    },
  },

  // Item pages
  {
    file: 'items/data-layer-detail.png',
    as: 'contributor',
    async run(page) {
      // The preview map zooms to the layer once its extent loads.
      await go(page, `/items/${ID.facilities}`, 10_000);
    },
  },
  {
    file: 'items/map-detail.png',
    as: 'contributor',
    async run(page) {
      await go(page, `/items/${ID.explorerMap}`);
    },
  },
  {
    file: 'items/web-app-detail.png',
    as: 'contributor',
    async run(page) {
      await go(page, `/items/${ID.viewerApp}`, 4000);
    },
  },
  {
    file: 'web-apps/custom-app-builder.png',
    as: 'contributor',
    async run(page) {
      await go(page, `/items/${ID.customApp}`, 4000);
    },
  },
  {
    file: 'forms/form-designer-canvas.png',
    as: 'contributor',
    async run(page) {
      await go(page, `/items/${ID.form}`, 4000);
      await scrollToTop(page.getByRole('heading', { name: 'Form designer' }));
    },
  },

  // Map editing
  {
    file: 'map-editing/map-builder-overview.png',
    as: 'contributor',
    async run(page) {
      await go(page, `/items/${ID.explorerMap}?view=configure`, 6000);
    },
  },
  {
    file: 'map-editing/markup-panel.png',
    as: 'contributor',
    async run(page) {
      await go(page, `/items/${ID.explorerMap}?view=configure`, 6000);
      await page.getByRole('button', { name: 'Markup' }).click();
      await page.waitForTimeout(1500);
    },
  },
  {
    file: 'map-editing/comments-panel.png',
    as: 'contributor',
    async run(page) {
      await go(page, `/items/${ID.explorerMap}?view=configure`, 6000);
      await page.getByRole('button', { name: 'Comments' }).click();
      await page.waitForTimeout(1500);
    },
  },
  {
    file: 'map-editing/symbology/simple-symbology-panel.png',
    // An admin can edit the map, so the style controls show.
    as: 'admin',
    async run(page) {
      await go(page, `/items/${ID.explorerMap}?view=configure`, 6000);
      await page.getByText('Trails', { exact: true }).first().click();
      await page.waitForTimeout(1500);
    },
  },

  // Analysis: the wizard, then one recipe per tool.
  {
    file: 'analysis/derived-layer-new-item.png',
    as: 'contributor',
    async run(page) {
      await go(page, `/items/new?type=derived_layer&source=${ID.parks}`);
    },
  },
  recipeShot('analysis/buffer-analyze-guide.png', 'Buffer'),
  recipeShot('analysis/simplify-analyze-guide.png', 'Simplify'),
  recipeShot('analysis/densify-analyze-guide.png', 'Densify'),
  recipeShot('analysis/convex-hull-analyze-guide.png', 'Convex hull'),
  recipeShot('analysis/bbox-analyze-guide.png', 'Bounding box'),
  recipeShot('analysis/centroid-analyze-guide.png', 'Centroid'),
  recipeShot('analysis/vertices-analyze-guide.png', 'Vertices'),
  recipeShot('analysis/dissolve-analyze-guide.png', 'Dissolve'),
  recipeShot('analysis/calculate-analyze-guide.png', 'Calculate geometry'),
  recipeShot('analysis/nearest-neighbor-analyze-guide.png', 'Nearest-neighbor distance', ID.facilities),
  recipeShot('analysis/top-n-analyze-guide.png', 'Top N by attribute'),
  recipeShot('analysis/random-sample-analyze-guide.png', 'Random sample'),
  recipeShot('analysis/fishnet-analyze-guide.png', 'Fishnet'),
  recipeShot('analysis/group-by-analyze-guide.png', 'Group by + aggregate'),
  recipeShot('analysis/spatial-join-analyze-guide.png', 'Spatial join (from another layer)'),
  recipeShot('analysis/spatial-filter-analyze-guide.png', 'Spatial filter (by another layer)'),
  recipeShot('analysis/clip-analyze-guide.png', 'Clip by another layer'),
  recipeShot('analysis/erase-analyze-guide.png', 'Erase by another layer'),
  recipeShot('analysis/contour-analyze-guide.png', 'Contour from points', ID.facilities),

  // Admin
  { file: 'admin/admin-home.png', as: 'admin', run: (page) => go(page, '/admin', 3000) },
  { file: 'admin/users.png', as: 'admin', run: (page) => go(page, '/admin/users', 3000) },
  { file: 'admin/branding.png', as: 'admin', run: (page) => go(page, '/admin/branding', 3000) },
  { file: 'admin/backup.png', as: 'admin', run: (page) => go(page, '/admin/backup', 3000) },
  { file: 'admin/housekeeping.png', as: 'admin', run: (page) => go(page, '/admin/housekeeping', 4000) },
];

// ---------------------------------------------------------------- runner

async function signIn(browser, who) {
  const { user, password } = ACCOUNTS[who];
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(BASE + '/items', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#username', { timeout: 45_000 });
  await page.fill('#username', user);
  await page.fill('#password', password);
  await page.click('input[type="submit"], button[type="submit"]');
  await page.waitForURL(/\/items/, { timeout: 60_000 });
  console.log(`signed in as ${user}`);
  return page;
}

async function main() {
  const shots = SHOTS.filter((s) => !ONLY || ONLY.test(s.file));
  console.log(`BASE ${BASE}  shots ${shots.length}`);
  const browser = await chromium.launch({ headless: true });
  const pages = {};
  const failed = [];
  try {
    for (const shot of shots) {
      pages[shot.as] ??= await signIn(browser, shot.as);
      const page = pages[shot.as];
      try {
        await shot.run(page);
        await hideFloating(page);
        const dest = path.join(OUT, shot.file);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await page.screenshot({ path: dest, animations: 'disabled' });
        console.log(`  ok    ${shot.file} (${Math.round(fs.statSync(dest).size / 1024)} KiB)`);
      } catch (err) {
        failed.push(shot.file);
        console.log(`  FAIL  ${shot.file}: ${String(err.message ?? err).split('\n')[0]}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(failed.length ? `done, ${failed.length} failed` : 'done');
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
