// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Capture real UI screenshots for portal help docs.
 *
 * Writes PNGs under apps/portal-web/public/help/ mirroring help slugs.
 * Default target is the public demo; override with E2E_* env vars.
 *
 *   E2E_BASE_URL=https://gratisgis.org \
 *   E2E_USER=tester-contributor E2E_PASSWORD='Contributor123!' \
 *   node e2e/scripts/capture-help-screenshots.mjs
 *
 * Optional: HELP_SHOT_WAVE=1|2|3|all (default all for implemented shots)
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'apps/portal-web/public/help');

const BASE = process.env.E2E_BASE_URL ?? 'https://gratisgis.org';
const USER = process.env.E2E_USER ?? 'tester-contributor';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Contributor123!';
const WAVE = process.env.HELP_SHOT_WAVE ?? '1';

const VIEWPORT = { width: 1440, height: 900 };

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function shot(page, rel, opts = {}) {
  const dest = path.join(OUT, rel);
  ensureDir(dest);
  await page.screenshot({
    path: dest,
    fullPage: false,
    animations: 'disabled',
    ...opts,
  });
  const st = fs.statSync(dest);
  console.log(`  wrote ${rel} (${Math.round(st.size / 1024)} KiB)`);
  return dest;
}

async function signIn(page) {
  await page.goto(BASE + '/items', { waitUntil: 'domcontentloaded' });
  // Already signed in?
  if (!page.url().includes('auth') && !page.url().includes('signin')) {
    const userBtn = page.getByRole('button', { name: /tester/i }).first();
    if (await userBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('already signed in');
      return;
    }
  }
  await page.waitForSelector('#username', { timeout: 45_000 });
  await page.fill('#username', USER);
  await page.fill('#password', PASSWORD);
  await page.click('input[type="submit"], button[type="submit"]');
  await page.waitForURL(/\/(items|maps|field)/, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  console.log('signed in as', USER, '→', page.url());
}

async function dismissToasts(page) {
  // Best-effort: close common dismissibles so they don't cover chrome.
  for (const sel of [
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
    '[data-testid="toast-close"]',
  ]) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
      await loc.click().catch(() => {});
    }
  }
}

/** Prefer type from URL or card badge; fall back to text heuristics. */
async function findItemHref(page, typeHint) {
  await page.goto(BASE + '/items', { waitUntil: 'networkidle' }).catch(() =>
    page.goto(BASE + '/items'),
  );
  await page.waitForTimeout(2000);
  await dismissToasts(page);

  // Try filter chips / type filter if present
  const typeFilter = page.getByRole('button', {
    name: new RegExp(typeHint, 'i'),
  });
  if (await typeFilter.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await typeFilter.first().click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  const href = await page.evaluate((hint) => {
    const links = [...document.querySelectorAll('a[href*="/items/"]')];
    const hintLower = hint.toLowerCase();
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (!/\/items\/[a-z0-9-]+/i.test(href)) continue;
      if (href.includes('/new') || href.includes('/edit')) continue;
      const text = (a.textContent || '').toLowerCase();
      const card = a.closest('[class*="card"], article, li, tr') || a.parentElement;
      const around = ((card && card.textContent) || text).toLowerCase();
      if (
        around.includes(hintLower) ||
        text.includes(hintLower) ||
        // common demo titles
        (hintLower === 'data layer' &&
          /layer|points|roads|parcels|hydrants|buildings/.test(around)) ||
        (hintLower === 'map' && /map|viewer|basemap/.test(around)) ||
        (hintLower === 'form' && /form|survey|inspection/.test(around)) ||
        (hintLower === 'web app' && /app|dashboard|experience/.test(around))
      ) {
        return href;
      }
    }
    // Fallback: first non-new item link
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (/\/items\/[a-z0-9-]+\/?$/i.test(href) || /\/items\/[a-z0-9-]+\?/i.test(href)) {
        return href.split('?')[0];
      }
    }
    return null;
  }, typeHint);

  return href;
}

async function openNewItemWizard(page) {
  await page.goto(BASE + '/items', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const newBtn = page
    .getByRole('button', { name: /\+?\s*new item/i })
    .or(page.getByRole('link', { name: /\+?\s*new item/i }))
    .first();
  if (!(await newBtn.isVisible({ timeout: 8000 }).catch(() => false))) {
    // Try floating / header affordance
    const alt = page.locator('text=/new item/i').first();
    await alt.click({ timeout: 8000 });
  } else {
    await newBtn.click();
  }
  await page.waitForTimeout(1500);
  // Wait for wizard chrome
  await page
    .getByText(/pick what|new item|what are you creating/i)
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => {});
}

async function wave1(page) {
  console.log('=== wave 1: getting-started + share + analyze Buffer/Clip ===');

  // Items grid (orientation)
  await page.goto(BASE + '/items', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await dismissToasts(page);
  await shot(page, 'getting-started/what-is-gratisgis-items-grid.png');

  // New item wizard
  await openNewItemWizard(page);
  // Prefer Map card selected if clickable
  const mapCard = page
    .getByRole('button', { name: /^map$/i })
    .or(page.locator('[data-type="map"], [data-item-type="map"]'))
    .or(page.getByText(/^Map$/).first());
  if (await mapCard.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await mapCard.first().click().catch(() => {});
    await page.waitForTimeout(400);
  }
  await shot(page, 'getting-started/creating-your-first-map-new-item.png');

  // Also capture Derived layer card area for analysis docs
  const derived = page.getByText(/derived layer/i).first();
  if (await derived.isVisible({ timeout: 2000 }).catch(() => false)) {
    await derived.click().catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, 'analysis/derived-layer-new-item.png');
  }
  // Close wizard via Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Data layer → Analyze → Buffer / Clip
  const layerHref = await findItemHref(page, 'data layer');
  console.log('  data layer href', layerHref);
  if (layerHref) {
    const url = layerHref.startsWith('http') ? layerHref : BASE + layerHref;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await dismissToasts(page);
    await shot(page, 'items/data-layer-detail.png');

    // Access / Sharing tab
    const access = page
      .getByRole('tab', { name: /access|sharing/i })
      .or(page.getByRole('link', { name: /access|sharing/i }))
      .or(page.getByText(/^Access$/i));
    if (await access.first().isVisible({ timeout: 4000 }).catch(() => false)) {
      await access.first().click();
      await page.waitForTimeout(1200);
      await shot(page, 'getting-started/sharing-an-item-access.png');
    }

    // Analyze tab
    const analyze = page
      .getByRole('tab', { name: /analyze/i })
      .or(page.getByRole('link', { name: /analyze/i }))
      .or(page.getByText(/^Analyze$/i));
    if (await analyze.first().isVisible({ timeout: 4000 }).catch(() => false)) {
      await analyze.first().click();
      await page.waitForTimeout(1500);
      await shot(page, 'analysis/analyze-tab.png');

      // Buffer guide
      const bufferBtn = page.getByRole('button', { name: /buffer this layer/i });
      if (await bufferBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await bufferBtn.click();
        await page.waitForTimeout(1000);
        await shot(page, 'analysis/buffer-analyze-guide.png');
        await page.keyboard.press('Escape').catch(() => {});
        // close guide if it has a back/cancel
        const cancel = page.getByRole('button', { name: /cancel|back|close/i }).first();
        if (await cancel.isVisible({ timeout: 1000 }).catch(() => false)) {
          await cancel.click().catch(() => {});
        }
        await page.waitForTimeout(500);
      }

      // Clip guide
      const clipBtn = page.getByRole('button', { name: /clip this layer/i });
      if (await clipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await clipBtn.click();
        await page.waitForTimeout(1000);
        await shot(page, 'analysis/clip-analyze-guide.png');
        await page.keyboard.press('Escape').catch(() => {});
        const cancel = page.getByRole('button', { name: /cancel|back|close/i }).first();
        if (await cancel.isVisible({ timeout: 1000 }).catch(() => false)) {
          await cancel.click().catch(() => {});
        }
      }
    }

    // Map tab / overview of layer for CSV-adjacent
    const overview = page.getByRole('tab', { name: /overview|map|data/i }).first();
    if (await overview.isVisible({ timeout: 2000 }).catch(() => false)) {
      await overview.click().catch(() => {});
      await page.waitForTimeout(800);
    }
  }

  // Map → builder
  const mapHref = await findItemHref(page, 'map');
  console.log('  map href', mapHref);
  if (mapHref) {
    const url = mapHref.startsWith('http') ? mapHref : BASE + mapHref;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await shot(page, 'items/map-detail.png');
    const openBuilder = page
      .getByRole('button', { name: /open builder|edit map|builder/i })
      .or(page.getByRole('link', { name: /open builder|edit map|builder/i }))
      .first();
    if (await openBuilder.isVisible({ timeout: 5000 }).catch(() => false)) {
      await openBuilder.click();
      await page.waitForTimeout(4000);
      await shot(page, 'getting-started/creating-your-first-map-builder.png');
      // Add layer affordance if visible
      const addLayer = page.getByRole('button', { name: /\+?\s*add layer/i }).first();
      if (await addLayer.isVisible({ timeout: 3000 }).catch(() => false)) {
        await addLayer.click();
        await page.waitForTimeout(1000);
        await shot(page, 'getting-started/creating-your-first-map-add-layer.png');
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
  }

  // New data layer / CSV upload surface
  await openNewItemWizard(page);
  const dataLayerCard = page.getByText(/^Data layer$/i).first();
  if (await dataLayerCard.isVisible({ timeout: 3000 }).catch(() => false)) {
    await dataLayerCard.click();
    await page.waitForTimeout(400);
    const create = page.getByRole('button', { name: /create|next|continue/i }).first();
    if (await create.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Fill a temp title if needed
      const title = page.getByLabel(/title/i).or(page.locator('input[name="title"]')).first();
      if (await title.isVisible({ timeout: 1500 }).catch(() => false)) {
        await title.fill('Help screenshot scratch (delete)');
      }
      await create.click().catch(() => {});
      await page.waitForTimeout(2500);
      // Look for Import tab
      const importTab = page
        .getByRole('tab', { name: /import/i })
        .or(page.getByRole('button', { name: /import/i }))
        .or(page.getByText(/^Import$/i));
      if (await importTab.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await importTab.first().click().catch(() => {});
        await page.waitForTimeout(800);
      }
      await shot(page, 'getting-started/uploading-csv-import.png');
      // Don't leave scratch if we created one — navigate away; nightly reset cleans demo
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
}

async function wave2(page) {
  console.log('=== wave 2: forms + more analyze shortcuts ===');

  const formHref = await findItemHref(page, 'form');
  console.log('  form href', formHref);
  if (formHref) {
    const url = formHref.startsWith('http') ? formHref : BASE + formHref;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await shot(page, 'items/form-detail.png');
    const designer = page
      .getByRole('button', { name: /open designer|designer|edit form/i })
      .or(page.getByRole('link', { name: /open designer|designer|edit form/i }))
      .first();
    if (await designer.isVisible({ timeout: 5000 }).catch(() => false)) {
      await designer.click();
      await page.waitForTimeout(3500);
      await shot(page, 'forms/form-designer-canvas.png');
    }
  }

  // Analyze shortcuts from a data layer
  const layerHref = await findItemHref(page, 'data layer');
  if (!layerHref) return;
  const url = layerHref.startsWith('http') ? layerHref : BASE + layerHref;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const analyze = page.getByRole('tab', { name: /analyze/i }).first();
  if (!(await analyze.isVisible({ timeout: 4000 }).catch(() => false))) return;
  await analyze.click();
  await page.waitForTimeout(1200);

  const guides = [
    ['buffer this layer', 'analysis/buffer-analyze-guide.png'],
    ['clip this layer', 'analysis/clip-analyze-guide.png'],
    ['erase', 'analysis/erase-analyze-guide.png'],
    ['centroid', 'analysis/centroid-analyze-guide.png'],
    ['dissolve', 'analysis/dissolve-analyze-guide.png'],
    ['simplify', 'analysis/simplify-analyze-guide.png'],
    ['convex hull', 'analysis/convex-hull-analyze-guide.png'],
    ['densify', 'analysis/densify-analyze-guide.png'],
    ['vertices', 'analysis/vertices-analyze-guide.png'],
    ['bounding box', 'analysis/bbox-analyze-guide.png'],
    ['bbox', 'analysis/bbox-analyze-guide.png'],
    ['group by', 'analysis/group-by-analyze-guide.png'],
    ['contour', 'analysis/contour-analyze-guide.png'],
    ['fishnet', 'analysis/fishnet-analyze-guide.png'],
    ['nearest', 'analysis/nearest-neighbor-analyze-guide.png'],
    ['random sample', 'analysis/random-sample-analyze-guide.png'],
    ['top n', 'analysis/top-n-analyze-guide.png'],
    ['calculate', 'analysis/calculate-analyze-guide.png'],
    ['filter', 'analysis/filter-analyze-guide.png'],
    ['spatial filter', 'analysis/spatial-filter-analyze-guide.png'],
    ['spatial join', 'analysis/spatial-join-analyze-guide.png'],
  ];

  for (const [label, rel] of guides) {
    // Re-open analyze if we navigated into a guide
    if (!(await page.getByRole('button', { name: new RegExp(label, 'i') }).first().isVisible({ timeout: 800 }).catch(() => false))) {
      // Maybe need to go back
      const back = page.getByRole('button', { name: /back|cancel|close/i }).first();
      if (await back.isVisible({ timeout: 500 }).catch(() => false)) {
        await back.click().catch(() => {});
        await page.waitForTimeout(400);
      }
      if (!(await page.getByRole('tab', { name: /analyze/i }).first().isVisible({ timeout: 500 }).catch(() => false))) {
        await page.goto(url + (url.includes('?') ? '&' : '?') + 'tab=analyze').catch(() => page.goto(url));
        await page.waitForTimeout(1500);
        const tab = page.getByRole('tab', { name: /analyze/i }).first();
        if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) await tab.click();
        await page.waitForTimeout(800);
      }
    }
    const btn = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
    if (!(await btn.isVisible({ timeout: 1500 }).catch(() => false))) {
      console.log('  skip missing guide:', label);
      continue;
    }
    await btn.click();
    await page.waitForTimeout(900);
    await shot(page, rel);
    const back = page.getByRole('button', { name: /back|cancel|close/i }).first();
    if (await back.isVisible({ timeout: 800 }).catch(() => false)) {
      await back.click().catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
    await page.waitForTimeout(400);
  }
}

async function wave3(page) {
  console.log('=== wave 3: map editing + widgets + admin ===');

  const mapHref = await findItemHref(page, 'map');
  if (mapHref) {
    const url = mapHref.startsWith('http') ? mapHref : BASE + mapHref;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const openBuilder = page
      .getByRole('button', { name: /open builder|edit map|builder/i })
      .or(page.getByRole('link', { name: /open builder|edit map|builder/i }))
      .first();
    if (await openBuilder.isVisible({ timeout: 5000 }).catch(() => false)) {
      await openBuilder.click();
      await page.waitForTimeout(3500);
      // Style / symbology
      for (const name of [/style/i, /symbology/i, /labels/i, /popup/i, /filter/i]) {
        const btn = page.getByRole('button', { name }).or(page.getByRole('tab', { name })).first();
        if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(800);
          const slug =
            name.source.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '') || 'panel';
          await shot(page, `map-editing/${slug}-panel.png`);
        }
      }
      // Markup / comments if in chrome
      for (const name of [/markup/i, /comment/i, /draw/i]) {
        const btn = page.getByRole('button', { name }).first();
        if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(700);
          await shot(
            page,
            `map-editing/${name.source.replace(/[^a-z]+/gi, '')}-panel.png`,
          );
        }
      }
    }
  }

  // Admin (re-auth as admin if needed)
  if (!USER.includes('admin')) {
    console.log('  admin shots need tester-admin; skipping signed-in admin wave');
    // Still try /admin — may redirect
  }
  await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);
  if (page.url().includes('/admin')) {
    await shot(page, 'admin/organization-settings.png');
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('BASE', BASE, 'USER', USER, 'WAVE', WAVE, 'OUT', OUT);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);

  try {
    await signIn(page);
    if (WAVE === '1' || WAVE === 'all') await wave1(page);
    if (WAVE === '2' || WAVE === 'all') await wave2(page);
    if (WAVE === '3' || WAVE === 'all') await wave3(page);
  } finally {
    await browser.close();
  }
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
