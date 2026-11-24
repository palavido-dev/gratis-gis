// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';

import { REPORT_LABEL_KEYS } from './report-request.js';
import { WhatsHereReportService } from './whats-here-report.service.js';

const AREA = 'b'.repeat(32);
const PUBLIC_ITEM = '11111111-2222-4333-8444-555555555555';
const PRIVATE_ITEM = '99999999-2222-4333-8444-555555555555';
const labels = Object.fromEntries(REPORT_LABEL_KEYS.map((k) => [k, k]));

const layerData = {
  version: 3,
  layers: [
    {
      id: 'parcels',
      geometryType: 'polygon',
      editingPolicy: 'own-rows-only',
      fields: [
        {
          name: 'zone',
          label: 'Zoning',
          domain: { type: 'coded-value', values: [{ code: 'R1', label: 'Residential' }] },
        },
      ],
    },
  ],
};

function setup() {
  const areas = { touch: jest.fn(async (id: string) => id) };
  const prisma = {
    areaOfInterest: { findUnique: jest.fn(async () => ({ squareMeters: 40_468.564224 })) },
    item: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; access?: string } }) =>
        where.id === PUBLIC_ITEM && where.access === 'public'
          ? { id: PUBLIC_ITEM, data: layerData, publicGeoBoundaryId: null }
          : null,
      ),
    },
  };
  const items = {
    get: jest.fn(async (_u: unknown, id: string) => {
      if (id !== PUBLIC_ITEM) throw new NotFoundException();
      return { id, type: 'data_layer', data: layerData, shares: [] };
    }),
  };
  const sharing = {
    featureScopeFor: jest.fn(async () => ({ geoLimit: { type: 'Polygon' }, rowScope: 'own', userId: 'u1' })),
  };
  const v3 = {
    aggregateFeatures: jest.fn(async (_i: string, _l: string, args: { groupBy?: string[] }) =>
      args.groupBy
        ? {
            truncated: false,
            groups: [
              { key: { zone: null }, values: { count: 1, measure: 100 } },
              { key: { zone: 'R1' }, values: { count: 2, measure: 900 } },
            ],
          }
        : { truncated: false, groups: [{ key: {}, values: { count: 3, measure: 1000 } }] },
    ),
  };
  const reports = { pdf: jest.fn(async (html: string) => Buffer.from(html)) };
  const svc = new WhatsHereReportService(
    areas as never,
    prisma as never,
    items as never,
    sharing as never,
    v3 as never,
    reports as never,
  );
  return { svc, v3, sharing, reports };
}

const body = (itemId: string) => ({
  areaId: AREA,
  layers: [{ itemId, layerKey: 'parcels', title: 'Parcels', breakdownField: 'zone' }],
  areaUnit: 'acres',
  lengthUnit: 'feet',
  labels,
});

describe('WhatsHereReportService (#796)', () => {
  it('reads a signed-in caller with their own geo limit and row scope', async () => {
    const { svc, v3, sharing } = setup();
    const user = { id: 'u1' } as never;
    const { pdf } = await svc.pdf(user, body(PUBLIC_ITEM));
    expect(sharing.featureScopeFor).toHaveBeenCalledWith(user, expect.anything(), [], {
      action: 'read',
      layerPolicy: 'own-rows-only',
    });
    expect(v3.aggregateFeatures).toHaveBeenCalledWith(PUBLIC_ITEM, 'parcels', {
      aggs: [
        { op: 'count', as: 'count' },
        { op: 'area', as: 'measure' },
      ],
      areaOfInterestId: AREA,
      geoLimit: { type: 'Polygon' },
      ownRowsOnly: { userId: 'u1' },
    });
    const html = pdf.toString();
    // Coded values print as their labels, largest share first.
    expect(html.indexOf('Residential')).toBeLessThan(html.indexOf('<em>noValue</em>'));
    expect(html).toContain('Parcels · breakdownBy Zoning');
  });

  it('names a layer the caller cannot read as unavailable and reads nothing from it', async () => {
    const { svc, v3 } = setup();
    const { pdf } = await svc.pdf({ id: 'u1' } as never, body(PRIVATE_ITEM));
    expect(v3.aggregateFeatures).not.toHaveBeenCalled();
    expect(pdf.toString()).toContain('unavailable Parcels');
  });

  it('lets an anonymous caller read public layers only', async () => {
    const { svc, v3 } = setup();
    await svc.pdf(null, body(PUBLIC_ITEM));
    expect(v3.aggregateFeatures).toHaveBeenCalled();
    v3.aggregateFeatures.mockClear();
    const { pdf } = await svc.pdf(null, body(PRIVATE_ITEM));
    expect(v3.aggregateFeatures).not.toHaveBeenCalled();
    expect(pdf.toString()).toContain('unavailable Parcels');
  });
});
