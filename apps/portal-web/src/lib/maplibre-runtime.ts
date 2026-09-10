// SPDX-License-Identifier: AGPL-3.0-or-later
import { setWorkerUrl } from 'maplibre-gl';

/**
 * Point MapLibre at its tile-parsing worker.
 *
 * MapLibre 6 dropped the UMD bundles and ships ESM only, which changed
 * how the worker is loaded: 5.x inlined it, 6.x fetches it from a real
 * URL. Inside a bundler's module graph `import.meta.url` does not point
 * at the shipped worker file, so MapLibre cannot locate it on its own
 * and no source ever finishes parsing. The failure is quiet and easy to
 * misread: the basemap paints, the map is interactive, and not one
 * vector tile or GeoJSON feature appears.
 *
 * `new URL(<literal>, import.meta.url)` is the form both of our
 * bundlers treat as an asset reference (webpack for the production
 * build, Turbopack in dev). Each emits its own copy of the worker and
 * rewrites this expression to the emitted path, so one call covers
 * both. Building it inside the function keeps it off the server, where
 * there is no worker to point at and the specifier would not resolve.
 *
 * Every map surface calls this before constructing its Map rather than
 * relying on a module load side effect, for the reason recorded in
 * custom-basemap: a Next chunk split once left exactly that kind of
 * side effect unrun until after the map had already requested its
 * sources (#209). Re-asserting is a string assignment, so this stays
 * cheap enough to call unconditionally and needs no "already done"
 * flag of the kind that masked #209 for so long.
 */
export function ensureMapLibreWorker(): void {
  if (typeof window === 'undefined') return;
  setWorkerUrl(
    new URL(
      'maplibre-gl/dist/maplibre-gl-worker.mjs',
      import.meta.url,
    ).toString(),
  );
}
