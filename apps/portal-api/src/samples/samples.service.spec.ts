// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { effectiveCapabilities } from '../auth/capabilities.js';
import { SAMPLE_KINDS, SamplesService } from './samples.service.js';
import {
  __resetSampleAssetsCacheForTests,
  loadSampleAssets,
} from './sample-assets.js';
import { deterministicSampleUuid } from './sample-uuid.js';

/**
 * Unit tests for the "Load sample data" seeder (#147 Phase 1):
 *
 *   (a) seedKind dedupe: fully seeded orgs skip everything without a
 *       single create, and partially seeded orgs create only the
 *       missing entries while REUSING existing item ids in every
 *       cross-reference (the folder's childItemIds is the strongest
 *       such reference: it names all fourteen manifest items).
 *   (b) the real bundled assets on disk parse with the counts the
 *       manifest promises, so a packaging regression fails here
 *       rather than at first click in a fresh org.
 */

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: effectiveCapabilities('contributor', []),
    ...overrides,
  } as AuthUser;
}

const PAIRED_LAYER_ID = 'paired-layer-id';

/** A paired submissions layer that has ALREADY been schema-synced:
 *  typed question columns present, point geometry promoted, and the
 *  respondent isolation policy set. With this shape the sync pass
 *  must be a no-op (no items.update call). */
function syncedPairedLayerData(): Record<string, unknown> {
  return {
    version: 3,
    storageType: 'postgis',
    layers: [
      {
        id: 'submissions',
        label: 'Submissions',
        name: 'submissions',
        geometryType: 'point',
        editingPolicy: 'own-rows-only',
        fields: [
          { name: 'submitted_at', type: 'date', label: 'Submitted at' },
          { name: 'submitted_by', type: 'string', label: 'Submitted by' },
          { name: 'schema_version', type: 'number', label: 'Schema version' },
          { name: 'issue_type', type: 'string', label: 'Issue type' },
          { name: 'severity', type: 'string', label: 'Severity' },
          { name: 'description', type: 'string', label: 'Description' },
          { name: 'reporter', type: 'string', label: 'Reporter name' },
        ],
        editingEnabled: false,
        attachmentsEnabled: true,
      },
    ],
  };
}

interface FakeRow {
  id: string;
  type: string;
  data: unknown;
  access: 'private' | 'org' | 'public';
  seedKind: string;
}

/** One existing row per manifest slug, at the post-seed access tiers
 *  so the access pass has nothing to change. */
function allExistingRows(): FakeRow[] {
  const rows: Array<[string, string, unknown, FakeRow['access']]> = [
    [SAMPLE_KINDS.pickFacility, 'pick_list', { version: 3, entries: [] }, 'private'],
    [SAMPLE_KINDS.pickTrail, 'pick_list', { version: 3, entries: [] }, 'private'],
    [
      SAMPLE_KINDS.layerFacilities,
      'data_layer',
      { version: 3, storageType: 'postgis', layers: [] },
      'public',
    ],
    [
      SAMPLE_KINDS.layerTrails,
      'data_layer',
      { version: 3, storageType: 'postgis', layers: [] },
      'org',
    ],
    [
      SAMPLE_KINDS.layerParks,
      'data_layer',
      { version: 3, storageType: 'postgis', layers: [] },
      'org',
    ],
    [SAMPLE_KINDS.boundary, 'geo_boundary', { version: 1, geometry: null }, 'private'],
    [SAMPLE_KINDS.mapExplorer, 'map', { version: 1, layers: [] }, 'public'],
    [SAMPLE_KINDS.derivedEmergency, 'derived_layer', { version: 1 }, 'private'],
    [
      SAMPLE_KINDS.form,
      'form',
      {
        schemaVersion: 1,
        id: 'id:sample:form-issue-report',
        questions: [],
        linkedLayerId: PAIRED_LAYER_ID,
        linkedLayerKey: 'submissions',
      },
      'private',
    ],
    [SAMPLE_KINDS.mapField, 'map', { version: 1, layers: [] }, 'private'],
    [SAMPLE_KINDS.collection, 'data_collection', { version: 1, mapId: 'x' }, 'private'],
    [SAMPLE_KINDS.appViewer, 'web_app', { version: 1 }, 'public'],
    [SAMPLE_KINDS.appExplorer, 'web_app', { version: 1 }, 'private'],
    [SAMPLE_KINDS.tool, 'tool', { schemaVersion: 1 }, 'private'],
    [SAMPLE_KINDS.folder, 'folder', { version: 1, childItemIds: [] }, 'private'],
  ];
  return rows.map(([seedKind, type, data, access]) => ({
    id: `id:${seedKind}`,
    type,
    data,
    access,
    seedKind,
  }));
}

interface FakeDeps {
  prisma: {
    item: { findMany: jest.Mock; findUnique: jest.Mock };
  };
  items: { create: jest.Mock; update: jest.Mock };
  features: { listFeatures: jest.Mock; insertFeatures: jest.Mock };
  forms: { submit: jest.Mock };
}

function makeDeps(existing: FakeRow[]): FakeDeps {
  return {
    prisma: {
      item: {
        findMany: jest.fn().mockResolvedValue(existing),
        findUnique: jest
          .fn()
          .mockResolvedValue({ data: syncedPairedLayerData() }),
      },
    },
    items: {
      create: jest.fn().mockImplementation(
        async (
          _user: AuthUser,
          input: { type: string; data: unknown; seedKind?: string },
        ) => ({
          id: `id:${input.seedKind}`,
          type: input.type,
          data: input.data,
          access: 'private',
        }),
      ),
      update: jest.fn().mockImplementation(
        async (_user: AuthUser, id: string, input: { data?: unknown }) => ({
          id,
          data: input.data ?? {},
          access: 'private',
        }),
      ),
    },
    features: {
      // Non-empty by default: "this layer already has rows", so the
      // seeder must not insert.
      listFeatures: jest
        .fn()
        .mockResolvedValue({ type: 'FeatureCollection', features: [{}] }),
      insertFeatures: jest.fn().mockResolvedValue({ inserted: 0 }),
    },
    forms: {
      submit: jest.fn().mockResolvedValue({ id: 'sub-row', created: false }),
    },
  };
}

function makeService(deps: FakeDeps): SamplesService {
  return new SamplesService(
    deps.prisma as never,
    deps.items as never,
    deps.features as never,
    deps.forms as never,
  );
}

describe('SamplesService.seedSampleData', () => {
  beforeEach(() => {
    __resetSampleAssetsCacheForTests();
  });

  it('rejects users without the publish capability', async () => {
    const deps = makeDeps([]);
    const svc = makeService(deps);
    const viewer = makeUser({
      orgRole: 'viewer',
      capabilities: effectiveCapabilities('viewer', []),
    });
    await expect(svc.seedSampleData(viewer)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(deps.prisma.item.findMany).not.toHaveBeenCalled();
  });

  it('skips every slug on a fully seeded org without creating or updating anything', async () => {
    const deps = makeDeps(allExistingRows());
    const svc = makeService(deps);
    const result = await svc.seedSampleData(makeUser());

    expect(result.created).toEqual([]);
    expect([...result.skipped].sort()).toEqual(
      Object.values(SAMPLE_KINDS).sort(),
    );
    expect(deps.items.create).not.toHaveBeenCalled();
    // Paired layer already synced + access tiers already applied, so
    // the run must be entirely read-only on the items table.
    expect(deps.items.update).not.toHaveBeenCalled();
    expect(deps.features.insertFeatures).not.toHaveBeenCalled();
    // Submissions always replay: FormsService.submit upserts on
    // (formId, clientId), so re-running them is the idempotent path.
    expect(deps.forms.submit).toHaveBeenCalledTimes(4);
    const clientIds = deps.forms.submit.mock.calls.map(
      (c) => (c[2] as { clientId: string }).clientId,
    );
    expect(clientIds).toEqual([
      'sample-sub-1',
      'sample-sub-2',
      'sample-sub-3',
      'sample-sub-4',
    ]);
  });

  it('creates only the missing folder and reuses existing item ids in its children', async () => {
    const existing = allExistingRows().filter(
      (r) => r.seedKind !== SAMPLE_KINDS.folder,
    );
    const deps = makeDeps(existing);
    const svc = makeService(deps);
    const result = await svc.seedSampleData(makeUser());

    expect(result.created).toEqual([SAMPLE_KINDS.folder]);
    expect(result.skipped).toHaveLength(14);
    expect(deps.items.create).toHaveBeenCalledTimes(1);

    const [, createInput] = deps.items.create.mock.calls[0] as [
      AuthUser,
      { type: string; seedKind: string; data: { childItemIds: string[] } },
    ];
    expect(createInput.type).toBe('folder');
    expect(createInput.seedKind).toBe(SAMPLE_KINDS.folder);
    // Manifest order, minus the skipped PDF guide, using the ids of
    // the ALREADY EXISTING items (the id-reuse requirement).
    expect(createInput.data.childItemIds).toEqual([
      `id:${SAMPLE_KINDS.pickFacility}`,
      `id:${SAMPLE_KINDS.pickTrail}`,
      `id:${SAMPLE_KINDS.layerFacilities}`,
      `id:${SAMPLE_KINDS.layerTrails}`,
      `id:${SAMPLE_KINDS.layerParks}`,
      `id:${SAMPLE_KINDS.boundary}`,
      `id:${SAMPLE_KINDS.mapExplorer}`,
      `id:${SAMPLE_KINDS.derivedEmergency}`,
      `id:${SAMPLE_KINDS.form}`,
      `id:${SAMPLE_KINDS.mapField}`,
      `id:${SAMPLE_KINDS.collection}`,
      `id:${SAMPLE_KINDS.appViewer}`,
      `id:${SAMPLE_KINDS.appExplorer}`,
      `id:${SAMPLE_KINDS.tool}`,
    ]);
    // The freshly created folder stays private; every access-tier
    // target already sits at its tier, so no update fires.
    expect(deps.items.update).not.toHaveBeenCalled();
  });

  it('inserts features with deterministic entity UUIDs when a layer is empty', async () => {
    const deps = makeDeps(allExistingRows());
    // Facilities layer reports empty; trails / parks report populated.
    deps.features.listFeatures.mockImplementation(
      async (itemId: string) =>
        itemId === `id:${SAMPLE_KINDS.layerFacilities}`
          ? { type: 'FeatureCollection', features: [] }
          : { type: 'FeatureCollection', features: [{}] },
    );
    const svc = makeService(deps);
    await svc.seedSampleData(makeUser());

    expect(deps.features.insertFeatures).toHaveBeenCalledTimes(1);
    const [itemId, layerId, inputs] = deps.features.insertFeatures.mock
      .calls[0] as [
      string,
      string,
      Array<{ globalId: string; properties: Record<string, unknown> }>,
    ];
    expect(itemId).toBe(`id:${SAMPLE_KINDS.layerFacilities}`);
    expect(layerId).toBe('facilities');
    expect(inputs).toHaveLength(12);
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const input of inputs) {
      expect(input.globalId).toMatch(uuidRe);
    }
    // Deterministic: the same (layer item id, feature slug) pair maps
    // to the same entity UUID on every run.
    expect(inputs[0]!.globalId).toBe(
      deterministicSampleUuid(
        `id:${SAMPLE_KINDS.layerFacilities}:sample-fac-01`,
      ),
    );
  });
});

describe('bundled sample assets', () => {
  beforeEach(() => {
    __resetSampleAssetsCacheForTests();
  });

  it('parses the real files with the manifest counts', async () => {
    const assets = await loadSampleAssets();
    expect(assets.facilities).toHaveLength(12);
    expect(assets.trails).toHaveLength(5);
    expect(assets.parks).toHaveLength(5);
    expect(assets.boundary).toHaveLength(1);
    expect(assets.submissions).toHaveLength(4);

    expect((assets.boundary[0]!.geometry as { type: string }).type).toBe(
      'Polygon',
    );
    for (const f of assets.facilities) {
      expect(typeof f.properties.name).toBe('string');
      expect(typeof f.properties.type).toBe('string');
    }
    expect(assets.submissions.map((s) => s.clientId)).toEqual([
      'sample-sub-1',
      'sample-sub-2',
      'sample-sub-3',
      'sample-sub-4',
    ]);
    // Geopoint answers must be in the runtime's { lat, lng } shape;
    // the paired-layer mirror silently drops anything else.
    for (const s of assets.submissions) {
      const loc = s.response.location as { lat: unknown; lng: unknown };
      expect(typeof loc.lat).toBe('number');
      expect(typeof loc.lng).toBe('number');
    }
  });
});

describe('deterministicSampleUuid', () => {
  it('is stable, UUID-shaped, and distinct per name', () => {
    const a1 = deterministicSampleUuid('layer-1:sample-fac-01');
    const a2 = deterministicSampleUuid('layer-1:sample-fac-01');
    const b = deterministicSampleUuid('layer-1:sample-fac-02');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
