// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import { exportBundle, sheetNames, type BundleSublayer } from './bundle-export';

// exportBundle ends in a browser download. Node has no document, so
// give it just enough of one for downloadBlob to run.
beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ click() {}, remove() {} }),
    body: { appendChild() {} },
  };
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
});

const ITEM = 'item-1';
const LAYERS: BundleSublayer[] = [
  { id: 'assets', label: 'Assets', name: 'assets' },
  { id: 'insp', label: 'Inspections', name: 'insp', parentLayerId: 'assets', parentFkColumn: 'asset_id' },
  { id: 'def', label: 'Deficiencies', name: 'def', parentLayerId: 'insp', parentFkColumn: 'insp_id' },
];

function feat(id: string, props: Record<string, unknown> = {}) {
  return { id, geometry: null, properties: props };
}

const FEATURES: Record<string, unknown[]> = {
  assets: [feat('a1'), feat('a2')],
  insp: [feat('i1', { asset_id: 'a1' }), feat('i2', { asset_id: 'a2' })],
  def: [feat('d1', { insp_id: 'i1' }), feat('d2', { insp_id: 'i2' }), feat('d3', { insp_id: 'i2' })],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(handler: (url: string) => Response | Promise<Response>) {
  const mock = jest.fn(async (input: RequestInfo | URL) => handler(String(input)));
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

function featurePages(url: string): Response | null {
  const m = /\/layers\/([^/]+)\/features\?/.exec(url);
  if (!m) return null;
  return json({ type: 'FeatureCollection', features: FEATURES[m[1]!] ?? [], nextCursor: null, asOf: '2026-11-13T00:00:00Z' });
}

describe('exportBundle', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('keeps every related row, at every depth, when nothing narrows the export', async () => {
    installFetch((url) => featurePages(url) ?? json({}, 404));
    const out = await exportBundle({
      itemId: ITEM,
      layerKey: 'assets',
      layers: LAYERS,
      filename: 'x',
      includeRelatedTables: true,
      includeAttachments: false,
    });
    expect(out).toMatchObject({ layerCount: 3, featureCount: 7 });
  });

  it('cascades a selection through each table to its own parent', async () => {
    installFetch((url) => featurePages(url) ?? json({}, 404));
    const out = await exportBundle({
      itemId: ITEM,
      layerKey: 'assets',
      layers: LAYERS,
      filename: 'x',
      includeRelatedTables: true,
      includeAttachments: false,
      featureIdsAllowlist: new Set(['a2']),
    });
    // a2, i2, d2, d3
    expect(out.featureCount).toBe(4);
  });

  it('pages the feature read and pins the snapshot', async () => {
    const urls: string[] = [];
    installFetch((url) => {
      urls.push(url);
      if (!url.includes('cursor=')) {
        return json({ type: 'FeatureCollection', features: [feat('a1')], nextCursor: 'c1', asOf: 'T0' });
      }
      return json({ type: 'FeatureCollection', features: [feat('a2')], nextCursor: null, asOf: 'T0' });
    });
    const out = await exportBundle({
      itemId: ITEM,
      layerKey: 'assets',
      layers: LAYERS,
      filename: 'x',
      includeRelatedTables: false,
      includeAttachments: false,
    });
    expect(out.featureCount).toBe(2);
    expect(urls[0]).toContain('limit=');
    expect(urls[1]).toContain('cursor=c1');
    expect(urls[1]).toContain('at=T0');
  });

  it('lists attachments once per layer and counts files it could not fetch', async () => {
    const mock = installFetch((url) => {
      const pages = featurePages(url);
      if (pages) return pages;
      if (url.endsWith('/layers/assets/attachments?all=1')) {
        return json([
          { featureId: 'a1', attachments: [{ id: 'att-1', fileName: 'one.jpg', mime: 'image/jpeg', sizeBytes: 1, storageUrl: '/files/1' }] },
          { featureId: 'a2', attachments: [{ id: 'att-2', fileName: 'two.jpg', mime: 'image/jpeg', sizeBytes: 1, storageUrl: '/files/2' }] },
        ]);
      }
      if (url === '/files/1') return new Response('x');
      if (url === '/files/2') return new Response('gone', { status: 403 });
      return json({}, 404);
    });
    const out = await exportBundle({
      itemId: ITEM,
      layerKey: 'assets',
      layers: LAYERS,
      filename: 'x',
      includeRelatedTables: false,
      includeAttachments: true,
    });
    expect(out.attachmentCount).toBe(1);
    expect(out.attachmentFailures).toBe(1);
    const perFeature = mock.mock.calls.filter(([u]) => /\/features\/[^/]+\/attachments/.test(String(u)));
    expect(perFeature).toHaveLength(0);
  });

  it('fails the export when the attachment list cannot be read', async () => {
    installFetch((url) => featurePages(url) ?? json({ message: 'Forbidden' }, 403));
    await expect(
      exportBundle({
        itemId: ITEM,
        layerKey: 'assets',
        layers: LAYERS,
        filename: 'x',
        includeRelatedTables: false,
        includeAttachments: true,
      }),
    ).rejects.toThrow();
  });
});

describe('sheetNames', () => {
  it('keeps names unique after truncation, ignoring case', () => {
    const names = sheetNames([
      { id: '1', label: 'Stormwater Inspection Deficiencies Photos', name: 'a' },
      { id: '2', label: 'Stormwater Inspection Deficiencies Notes', name: 'b' },
      { id: '3', label: 'stormwater inspection deficiencies', name: 'c' },
    ]);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(31);
    expect(names[1]).toMatch(/~2$/);
  });
});
