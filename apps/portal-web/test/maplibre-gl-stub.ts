// SPDX-License-Identifier: AGPL-3.0-or-later
// Stands in for maplibre-gl under Jest.
//
// MapLibre 6 publishes ESM only: its `exports` map offers an `import`
// condition and no `require` one, so the CommonJS resolver Jest uses
// cannot load it at all and any suite that reaches the package fails
// to run. `src/lib/offline-download.spec.ts` reaches it transitively,
// through offline-basemap to custom-basemap, purely because the
// pmtiles archive registration lives beside the style builders.
//
// Nothing in these suites means to exercise MapLibre. They run in the
// node environment against fake-indexeddb, and the one MapLibre call
// in that import chain (`ensureRasterProtocols`) returns early when
// `window` is undefined, which it always is here. So this file only
// has to satisfy the import.
//
// It therefore throws rather than returning a no-op. A silent stub
// would let a suite that genuinely started depending on MapLibre pass
// while testing nothing; this way that mistake announces itself. If a
// suite ever legitimately needs MapLibre behaviour it needs the real
// module under an ESM-capable runner, not a richer fake here.
function unavailable(name: string): never {
  throw new Error(
    `maplibre-gl is stubbed under Jest and ${name}() was called for real. ` +
      'These suites cover src/lib storage and sync in the node ' +
      'environment; see test/maplibre-gl-stub.ts.',
  );
}

export function addProtocol(): never {
  return unavailable('addProtocol');
}

export function removeProtocol(): never {
  return unavailable('removeProtocol');
}

export function setWorkerUrl(): never {
  return unavailable('setWorkerUrl');
}
