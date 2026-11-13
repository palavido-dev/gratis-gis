// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * An offline basemap must be used when the deployment is opened with
 * no signal, which is when the area list cannot be read.
 */
import type { OfflineAreaWithPackage } from '@gratis-gis/shared-types';
import {
  chooseOfflineAreas,
  listStoredBasemapAreaIds,
  loadKnownAreas,
  saveKnownAreas,
} from './offline-basemap-areas';

/** Minimal in-memory Cache Storage; node has none. */
function installCaches(): Map<string, Response> {
  const store = new Map<string, Response>();
  const abs = (k: RequestInfo | URL) =>
    new URL(typeof k === 'string' ? k : k instanceof URL ? k.href : k.url, 'http://local').href;
  const cache = {
    async put(k: RequestInfo, r: Response) {
      store.set(abs(k), r);
    },
    async match(k: RequestInfo) {
      return store.get(abs(k))?.clone();
    },
    async delete(k: RequestInfo) {
      return store.delete(abs(k));
    },
    async keys() {
      return [...store.keys()].map((u) => new Request(u));
    },
  };
  (globalThis as unknown as { caches: unknown }).caches = {
    open: async () => cache,
  };
  return store;
}

function area(id: string): OfflineAreaWithPackage {
  return { area: { id, name: id } } as unknown as OfflineAreaWithPackage;
}

afterEach(() => {
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

describe('listStoredBasemapAreaIds', () => {
  it('lists the archives of one deployment only, not the saved list', async () => {
    const store = installCaches();
    store.set('http://local/offline-basemap/item1/a1', new Response('x'));
    store.set('http://local/offline-basemap/item1/a%202', new Response('x'));
    store.set('http://local/offline-basemap/item2/b1', new Response('x'));
    await saveKnownAreas('item1', [area('a1')]);
    expect((await listStoredBasemapAreaIds('item1')).sort()).toEqual(['a 2', 'a1']);
    expect(await loadKnownAreas('item1')).toEqual([area('a1')]);
  });
});

describe('chooseOfflineAreas', () => {
  it('adopts every stored archive when the server did not answer', () => {
    const out = chooseOfflineAreas({
      server: null,
      saved: [area('a1'), area('gone')],
      storedIds: ['a1', 'a2'],
    });
    expect(out.adoptIds).toEqual(['a1', 'a2']);
    expect(out.areas.map((a) => a.area.id)).toEqual(['a1']);
  });

  it('drops archives of areas the author deleted when the server answered', () => {
    const out = chooseOfflineAreas({
      server: [area('a1')],
      saved: null,
      storedIds: ['a1', 'a2'],
    });
    expect(out.adoptIds).toEqual(['a1']);
  });
});
