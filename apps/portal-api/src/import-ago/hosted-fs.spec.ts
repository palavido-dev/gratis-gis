// SPDX-License-Identifier: AGPL-3.0-or-later
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => ({ address: '151.101.1.1', family: 4 })),
}));

import type { AuthUser } from '../auth/auth-sync.service.js';
import { AgoHostedFsImportService, redactToken } from './hosted-fs.js';

/**
 * Hosted feature service copy: date values, attachment linkage,
 * sublayer ids, and tokens in error text. AGO is a mocked fetch.
 */
const SVC = 'https://services1.arcgis.com/Org1/arcgis/rest/services/Parcels/FeatureServer';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(opts: { queryStatus?: number } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/Org1/arcgis/rest/services/Parcels/FeatureServer', '');
    if (path === '') {
      return json({
        layers: [
          { id: 0, name: 'Parcels (2020)' },
          { id: 1, name: 'Parcels 2020' },
        ],
      });
    }
    if (path === '/0' || path === '/1') {
      return json({
        id: Number(path.slice(1)),
        name: path === '/0' ? 'Parcels (2020)' : 'Parcels 2020',
        geometryType: 'esriGeometryPoint',
        objectIdField: 'OBJECTID',
        hasAttachments: path === '/0',
        fields: [
          { name: 'OBJECTID', type: 'esriFieldTypeOID' },
          { name: 'InspectionDate', type: 'esriFieldTypeDate' },
        ],
      });
    }
    if (path === '/0/query' && url.searchParams.get('returnIdsOnly') === 'true') {
      return json({ objectIds: [7] });
    }
    if (path === '/0/query' || path === '/1/query') {
      if (opts.queryStatus) return json({}, opts.queryStatus);
      const features =
        path === '/0/query' && url.searchParams.get('resultOffset') === '0'
          ? [
              {
                type: 'Feature',
                id: 7,
                geometry: { type: 'Point', coordinates: [0, 0] },
                properties: { OBJECTID: 7, InspectionDate: Date.UTC(2024, 0, 2) },
              },
            ]
          : [];
      return json({ type: 'FeatureCollection', features });
    }
    if (path === '/0/7/attachments') {
      return json({
        attachmentInfos: [{ id: 1, name: 'a.jpg', contentType: 'image/jpeg', size: 999 }],
      });
    }
    if (path === '/0/7/attachments/1') {
      return new Response('abc', { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const inserted: Array<{ layer: string; properties: Record<string, unknown> }> = [];
  const attachments: Array<Record<string, unknown>> = [];
  let created: { data: { layers: Array<{ id: string }> } } | undefined;
  const svc = new AgoHostedFsImportService(
    {
      create: jest.fn(async (_u: unknown, input: { data: { layers: Array<{ id: string }> } }) => {
        created = input;
        return { id: '00000000-0000-4000-8000-000000000001' };
      }),
    } as never,
    {
      insertFeatures: jest.fn(
        async (_item: string, layer: string, rows: Array<{ properties: Record<string, unknown> }>) => {
          for (const r of rows) inserted.push({ layer, properties: r.properties });
          return {
            inserted: rows.length,
            deduplicated: 0,
            globalIds: rows.map(() => '00000000-0000-4000-8000-0000000000f7'),
          };
        },
      ),
    } as never,
    {
      uploadBuffer: jest.fn(async () => ({ key: 'feature-attachment/k', publicUrl: 'u' })),
    } as never,
    {
      featureAttachment: {
        create: jest.fn(async (a: { data: Record<string, unknown> }) => {
          attachments.push(a.data);
          return {};
        }),
      },
    } as never,
  );
  return {
    svc,
    inserted,
    attachments,
    layers: () => created?.data.layers.map((l) => l.id),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const user = { id: 'u1', orgId: 'o1' } as AuthUser;

describe('AgoHostedFsImportService.run', () => {
  it('writes ArcGIS epoch dates as ISO text', async () => {
    const t = setup();
    try {
      await t.svc.run({ user, serviceUrl: SVC, agoItemId: 'a', title: 'T', access: 'private' });
      expect(t.inserted[0]!.properties.InspectionDate).toBe('2024-01-02T00:00:00.000Z');
    } finally {
      t.restore();
    }
  });

  it('copies attachments onto the feature they belong to', async () => {
    const t = setup();
    try {
      const out = await t.svc.run({
        user,
        serviceUrl: SVC,
        agoItemId: 'a',
        title: 'T',
        access: 'private',
        copyAttachments: true,
      });
      expect(out.attachmentsCopied).toBe(1);
      expect(t.attachments[0]).toMatchObject({
        featureId: '00000000-0000-4000-8000-0000000000f7',
        sizeBytes: 3,
      });
    } finally {
      t.restore();
    }
  });

  it('keeps layers whose names sanitize alike in their own sublayers', async () => {
    const t = setup();
    try {
      const out = await t.svc.run({ user, serviceUrl: SVC, agoItemId: 'a', title: 'T', access: 'private' });
      const ids = t.layers()!;
      expect(new Set(ids).size).toBe(2);
      expect(out.agoLayerIdToSublayerKey[0]).not.toBe(out.agoLayerIdToSublayerKey[1]);
    } finally {
      t.restore();
    }
  });

  it('leaves the token out of the warning when a page fails', async () => {
    const t = setup({ queryStatus: 503 });
    try {
      const out = await t.svc.run({
        user,
        serviceUrl: SVC,
        agoItemId: 'a',
        title: 'T',
        access: 'private',
        token: 'SECRET-TOKEN',
      });
      expect(out.warnings.join(' ')).toContain('HTTP 503');
      expect(out.warnings.join(' ')).not.toContain('SECRET-TOKEN');
    } finally {
      t.restore();
    }
  });
});

describe('redactToken', () => {
  it('hides the token value in a quoted URL', () => {
    expect(redactToken('too many redirects fetching https://h/x?f=json&token=abc.def&y=1')).toBe(
      'too many redirects fetching https://h/x?f=json&token=[redacted]&y=1',
    );
  });
});
