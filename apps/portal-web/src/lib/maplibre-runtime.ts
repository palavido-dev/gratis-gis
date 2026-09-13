// SPDX-License-Identifier: AGPL-3.0-or-later
import { getVersion, setWorkerUrl } from 'maplibre-gl';

/**
 * Point MapLibre at its tile-parsing worker.
 *
 * MapLibre 6 dropped the UMD bundles and ships ESM only, which changed
 * how the worker is loaded: 5.x inlined it, 6.x fetches it from a real
 * URL. It is also not self-contained — `maplibre-gl-worker.mjs` does
 * `import … from './maplibre-gl-shared.mjs'` — so it only runs when
 * that sibling sits next to it and is reachable.
 *
 * This used to read
 *
 *   new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url)
 *
 * which webpack treats as a lone asset reference: it emitted the worker
 * to `static/media/maplibre-gl-worker.<hash>.mjs` and left the sibling
 * behind. The worker then 404'd on its own import and died before
 * running a line, and MapLibre says nothing when that happens. The
 * basemap paints, the map is interactive, and every vector tile and
 * GeoJSON layer renders nothing. It shipped that way on 2026-09-10 and
 * took three days and a report of "the 3D buildings are not rendering"
 * to find.
 *
 * So the worker is served from `public/` instead, both files together,
 * under a version directory that `scripts/vendor-maplibre-worker.mjs`
 * populates at build and dev time. The version here comes from
 * `getVersion()`, read from the same installed package that script
 * copies from, so the path cannot drift from what was vendored.
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
  const url = `/maplibre/${getVersion()}/maplibre-gl-worker.mjs`;
  setWorkerUrl(url);
  verifyWorkerReachable(url);
}

let verified = false;

/**
 * A missing worker is invisible at runtime: no exception, no MapLibre
 * error event, just a map that never renders vector data. One HEAD per
 * page load turns that back into something a developer or an error
 * report can see. Deliberately not awaited — it must never delay or
 * block map construction.
 */
function verifyWorkerReachable(url: string): void {
  if (verified) return;
  verified = true;
  void fetch(url, { method: 'HEAD' })
    .then((res) => {
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(
          `[maplibre] worker is not reachable at ${url} (HTTP ${res.status}). ` +
            'Vector tiles and GeoJSON layers will silently render nothing. ' +
            'Run scripts/vendor-maplibre-worker.mjs (it runs from the build ' +
            'and dev scripts) and confirm public/maplibre/ was populated.',
        );
      }
    })
    .catch(() => {
      // eslint-disable-next-line no-console
      console.error(`[maplibre] worker request to ${url} failed outright.`);
    });
}
