// SPDX-License-Identifier: AGPL-3.0-or-later
import { PublicController } from './public.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * GET /public/landing returned each public item's full `data`. For a
 * public map that included every markup set's anonymous author token
 * (which lets the holder edit or delete that set) and layers the map
 * hides from viewers; for a data layer, its sync conflicts. The
 * landing only needs the web_app template, so that is all it gets.
 */
describe('PublicController.landing item data', () => {
  const T = new Date('2026-11-01T00:00:00.000Z');
  const rows = [
    {
      id: 'map-1',
      title: 'Map',
      description: null,
      type: 'map',
      thumbnailUrl: null,
      thumbnailDesign: null,
      updatedAt: T,
      tags: [],
      license: null,
      data: {
        drawings: [{ id: 'set-1', anonymousAuthorToken: 'secret-token' }],
        layers: [{ id: 'hidden', access: 'custom' }],
      },
    },
    {
      id: 'dl-1',
      title: 'Layer',
      description: null,
      type: 'data_layer',
      thumbnailUrl: null,
      thumbnailDesign: null,
      updatedAt: T,
      tags: [],
      license: null,
      data: { layers: [{ id: 'a', syncConflicts: [{ id: 'c1' }] }] },
    },
    {
      id: 'app-1',
      title: 'Viewer',
      description: null,
      type: 'web_app',
      thumbnailUrl: null,
      thumbnailDesign: null,
      updatedAt: T,
      tags: [],
      license: null,
      data: { template: 'viewer', config: { template: 'viewer', viewer: { mapId: 'm' } } },
    },
  ];

  it('returns only the web_app template from each item data', async () => {
    const prisma = {
      organization: {
        findUnique: jest.fn(async () => ({
          id: 'org-1',
          slug: 'org',
          name: 'Org',
          landingTitle: null,
          landingSubtitle: null,
          landingHeroImageUrl: null,
          landingShowPublicItems: true,
          landingFeaturedItemIds: [],
        })),
      },
      item: { findMany: jest.fn(async () => rows) },
    };
    const controller = new PublicController(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
    );
    const out = await controller.landing('org');
    const body = JSON.stringify(out);
    expect(body).not.toContain('secret-token');
    expect(body).not.toContain('syncConflicts');
    expect(body).not.toContain('hidden');
    const byId = new Map(out.items.map((i) => [i.id, i.data]));
    expect(byId.get('app-1')).toEqual({ template: 'viewer' });
    expect(byId.get('map-1')).toBeNull();
  });
});
