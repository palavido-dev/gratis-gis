// SPDX-License-Identifier: AGPL-3.0-or-later
import { exportFilename, fetchAllFeaturesPaged } from './layer-export';

describe('exportFilename', () => {
  it('keeps letters from any script', () => {
    expect(exportFilename('道路')).toBe('道路');
    expect(exportFilename('Café sites')).toBe('Café_sites');
  });
  it('falls back only when nothing usable is left', () => {
    expect(exportFilename('***')).toBe('export');
    expect(exportFilename('  ')).toBe('export');
  });
  it('trims stray underscores', () => {
    expect(exportFilename('/Bridges/')).toBe('Bridges');
  });
});

describe('fetchAllFeaturesPaged', () => {
  function fakeFetch(pages: Array<{ features: unknown[]; nextCursor: string | null; asOf: string }>) {
    const urls: string[] = [];
    const fn = (async (url: string) => {
      urls.push(url);
      const page = pages[urls.length - 1]!;
      return { ok: true, status: 200, json: async () => page } as Response;
    }) as unknown as typeof fetch;
    return { fn, urls };
  }

  it('walks every page with the snapshot pinned', async () => {
    const { fn, urls } = fakeFetch([
      { features: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1', asOf: 'T0' },
      { features: [{ id: 'c' }], nextCursor: null, asOf: 'T1' },
    ]);
    const rows = await fetchAllFeaturesPaged('/x/features', fn, 2);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(urls[0]).toBe('/x/features?limit=2');
    expect(urls[1]).toBe('/x/features?limit=2&cursor=c1&at=T0');
  });

  it('surfaces the server message on failure', async () => {
    const fn = (async () =>
      ({
        ok: false,
        status: 400,
        json: async () => ({ message: 'nope' }),
      }) as Response) as unknown as typeof fetch;
    await expect(fetchAllFeaturesPaged('/x', fn)).rejects.toThrow('nope');
  });
});
