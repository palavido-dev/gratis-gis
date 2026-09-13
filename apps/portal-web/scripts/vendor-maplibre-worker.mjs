// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Copy MapLibre's worker and the chunk it imports into `public/`.
 *
 * MapLibre 6 ships an ESM worker that is NOT self-contained:
 *
 *   dist/maplibre-gl-worker.mjs  →  import … from './maplibre-gl-shared.mjs'
 *
 * Pointing `setWorkerUrl` at the package path via
 * `new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url)`
 * makes webpack treat the worker as a lone asset: it emits
 * `static/media/maplibre-gl-worker.<hash>.mjs` and nothing else. The
 * sibling import then resolves to `static/media/maplibre-gl-shared.mjs`,
 * which 404s, and the worker dies before it runs a line:
 *
 *   new Worker(url)                  SyntaxError: Cannot use import
 *                                    statement outside a module
 *   new Worker(url, {type:'module'}) failed to load the sibling
 *
 * MapLibre never reports that. The map still paints, still pans, still
 * zooms, because raster tiles decode on the main thread. Every vector
 * tile and every GeoJSON layer silently renders nothing. That shipped
 * on 2026-09-10 with the v6 upgrade and was not noticed for three days.
 *
 * So both files are copied side by side under a version directory,
 * which keeps the relative import intact and lets the browser cache
 * them forever without a stale copy surviving a MapLibre bump:
 *
 *   public/maplibre/<version>/maplibre-gl-worker.mjs
 *   public/maplibre/<version>/maplibre-gl-shared.mjs
 *
 * The runtime builds the same path from `getVersion()`, read out of the
 * same installed package this script copies from, so the two cannot
 * disagree about the version.
 *
 * Run explicitly from the `build` and `dev` scripts rather than as a
 * `prebuild` hook: pnpm 9 ships `enable-pre-post-scripts=false`, so a
 * `prebuild` would be skipped without a word, which is the same class
 * of silent gap this file exists to close.
 */
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require_ = createRequire(join(appRoot, 'package.json'));

const pkgPath = require_.resolve('maplibre-gl/package.json');
const { version } = JSON.parse(await readFile(pkgPath, 'utf8'));
if (!version) throw new Error('maplibre-gl package.json has no version');

const distDir = join(dirname(pkgPath), 'dist');
const outRoot = join(appRoot, 'public', 'maplibre');
const outDir = join(outRoot, version);

// Drop other versions so a MapLibre bump cannot leave a stale worker
// being served next to a mismatched shared chunk.
await mkdir(outRoot, { recursive: true });
for (const entry of await readdir(outRoot)) {
  if (entry !== version) await rm(join(outRoot, entry), { recursive: true, force: true });
}

await mkdir(outDir, { recursive: true });
for (const f of FILES) {
  const from = join(distDir, f);
  await cp(from, join(outDir, f));
}

// The worker is useless without the chunk it imports, so assert the
// relationship here rather than discovering it in a browser again.
const worker = await readFile(join(outDir, 'maplibre-gl-worker.mjs'), 'utf8');
const imports = [...worker.matchAll(/from\s*["'](\.[^"']+)["']/g)].map((m) => m[1]);
const missing = imports.filter(
  (spec) => !FILES.includes(spec.replace(/^\.\//, '')),
);
if (missing.length > 0) {
  throw new Error(
    `maplibre-gl-worker.mjs imports ${missing.join(', ')}, which this script does not copy. ` +
      `Add them to FILES in ${'scripts/vendor-maplibre-worker.mjs'}.`,
  );
}

// eslint-disable-next-line no-console
console.log(
  `[maplibre] vendored ${FILES.join(' + ')} for v${version} → public/maplibre/${version}/`,
);
