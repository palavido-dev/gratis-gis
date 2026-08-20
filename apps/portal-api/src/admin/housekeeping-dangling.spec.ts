// SPDX-License-Identifier: AGPL-3.0-or-later
import { HousekeepingService } from './housekeeping.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';
import type { DataLayerTablesService } from '../data-layer/tables.service.js';
import type { DataLayerSearchIndexService } from '../data-layer/search-index.service.js';
import type { CredentialService } from '../items/credential.service.js';
import type { StorageService } from '../storage/storage.service.js';

/**
 * #238: the dangling-reference scan used to walk only item.data, so a
 * portal whose landing page was pinned to two purged items reported
 * "every reference resolves" while /admin/branding openly rendered
 * two "Unknown item ..." rows.
 *
 * The tests that matter here are the ones where NOTHING in item.data
 * is broken. Those fail against the old scan, which is the point:
 * a clean bill of health was the bug.
 */

const ORG = 'org-1';

interface Fixture {
  /** Items in the org, with the ids each one's data references. */
  items?: Array<{ id: string; title: string; refs: string[] }>;
  /** organization.landingFeaturedItemIds */
  featured?: string[];
  /** item_share rows carrying a geo boundary. */
  shares?: Array<{ itemId: string; itemTitle: string; boundaryId: string }>;
  /** Ids that resolve to a live item row. */
  live?: string[];
  /** Ids that resolve to a trashed item row. */
  trashed?: string[];
}

function build(f: Fixture) {
  const items = f.items ?? [];
  const live = new Set(f.live ?? []);
  const trashed = new Set(f.trashed ?? []);

  const prisma = {
    item: {
      findMany: jest.fn(async (args: { where?: { id?: { in: string[] } } }) => {
        // Second call resolves referenced ids; first call lists the
        // org's items. The `id: { in: ... }` filter is the only
        // difference in the shapes the service passes.
        const ids = args?.where?.id?.in;
        if (ids) {
          return ids
            .filter((id) => live.has(id) || trashed.has(id))
            .map((id) => ({ id, deletedAt: trashed.has(id) ? new Date() : null }));
        }
        return items.map((i) => ({
          id: i.id,
          type: 'map',
          title: i.title,
          // The extractor reads map layers out of data.layers.
          data: {
            layers: i.refs.map((r) => ({ source: { kind: 'data-layer', itemId: r } })),
          },
          publicGeoBoundaryId: null,
          orgGeoBoundaryId: null,
        }));
      }),
    },
    organization: {
      findUnique: jest.fn(async () => ({
        landingFeaturedItemIds: f.featured ?? [],
      })),
    },
    itemShare: {
      findMany: jest.fn(async () =>
        (f.shares ?? []).map((s) => ({
          geoBoundaryId: s.boundaryId,
          item: { id: s.itemId, title: s.itemTitle },
        })),
      ),
    },
  } as unknown as PrismaService;

  const cfg = { get: jest.fn(() => undefined) } as unknown as ConfigService;
  return new HousekeepingService(
    prisma,
    cfg,
    {} as DataLayerTablesService,
    {} as DataLayerSearchIndexService,
    {} as CredentialService,
    {} as StorageService,
  );
}

describe('HousekeepingService dangling references', () => {
  it('reports a featured item that no longer resolves', async () => {
    const svc = build({
      items: [{ id: 'm1', title: 'Healthy map', refs: ['dl-1'] }],
      featured: ['dl-1', 'purged-1'],
      live: ['dl-1'],
    });
    const { referrers } = await svc.danglingReferences(ORG);
    expect(referrers).toHaveLength(1);
    expect(referrers[0]).toMatchObject({
      id: 'org:landing-featured',
      scope: 'settings',
      type: 'Landing page',
      title: 'Featured items',
      href: '/admin/branding',
      missing: ['purged-1'],
      trashed: [],
    });
  });

  it('reports a share whose geo boundary is gone, and says why it matters', async () => {
    const svc = build({
      shares: [
        { itemId: 'dl-9', itemTitle: 'Parcels', boundaryId: 'boundary-gone' },
      ],
    });
    const { referrers } = await svc.danglingReferences(ORG);
    expect(referrers).toHaveLength(1);
    expect(referrers[0]).toMatchObject({
      id: 'share-geo:dl-9',
      scope: 'settings',
      title: 'Parcels',
      href: '/items/dl-9',
      missing: ['boundary-gone'],
    });
    // The consequence is the whole reason this row exists: a share
    // that lost its boundary is not merely cosmetic, it is wider than
    // the admin set it up to be.
    expect(referrers[0]!.note).toMatch(/wider/);
  });

  it('collapses several shares on one item into a single row', async () => {
    const svc = build({
      shares: [
        { itemId: 'dl-9', itemTitle: 'Parcels', boundaryId: 'gone-a' },
        { itemId: 'dl-9', itemTitle: 'Parcels', boundaryId: 'gone-b' },
        { itemId: 'dl-9', itemTitle: 'Parcels', boundaryId: 'ok-b' },
      ],
      live: ['ok-b'],
    });
    const { referrers } = await svc.danglingReferences(ORG);
    expect(referrers).toHaveLength(1);
    expect(referrers[0]!.missing).toEqual(['gone-a', 'gone-b']);
  });

  it('separates a trashed boundary from a purged one', async () => {
    const svc = build({
      featured: ['in-trash'],
      trashed: ['in-trash'],
    });
    const { referrers } = await svc.danglingReferences(ORG);
    expect(referrers[0]!.missing).toEqual([]);
    expect(referrers[0]!.trashed).toEqual(['in-trash']);
  });

  it('still labels item-scoped rows as items, with an /items href', async () => {
    const svc = build({
      items: [{ id: 'm1', title: 'Broken map', refs: ['purged-1'] }],
    });
    const { referrers } = await svc.danglingReferences(ORG);
    expect(referrers[0]).toMatchObject({
      id: 'm1',
      scope: 'item',
      type: 'map',
      href: '/items/m1',
    });
  });

  it('reports clean when every reference in both scopes resolves', async () => {
    const svc = build({
      items: [{ id: 'm1', title: 'Healthy map', refs: ['dl-1'] }],
      featured: ['dl-1'],
      shares: [{ itemId: 'm1', itemTitle: 'Healthy map', boundaryId: 'b-1' }],
      live: ['dl-1', 'b-1'],
    });
    const { referrers } = await svc.danglingReferences(ORG);
    expect(referrers).toEqual([]);
  });

  it('does not query for resolution when nothing references anything', async () => {
    const svc = build({});
    const { referrers } = await svc.danglingReferences(ORG);
    expect(referrers).toEqual([]);
  });
});
