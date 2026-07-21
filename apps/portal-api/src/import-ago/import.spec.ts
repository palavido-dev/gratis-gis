// SPDX-License-Identifier: AGPL-3.0-or-later

// The importer reaches AGO through safeFetch, whose SSRF guard
// resolves the hostname via real DNS before the (mocked) fetch
// ever runs. On shared CI runners that lookup is occasionally
// slow enough to blow Jest's 5s test timeout, which had the CI
// red on and off with no code fault. Pin the lookup to a fixed
// public address: the guard still executes its full logic (so a
// regression that bypasses it still fails loudly), but the test
// no longer depends on live DNS.
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => ({ address: '151.101.1.1', family: 4 })),
}));

import { AgoImportService, normalizeAgoServiceUrl } from './import.js';
import type { DryRunReport } from './dry-run.js';
import { classifyAndRow } from './dry-run.js';
import type { AgoItem } from './ago-types.js';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { ItemsService } from '../items/items.service.js';
import type { WebMapJsonImportService } from '../items/web-map-json-import.service.js';

const PORTAL_URL = 'https://www.arcgis.com/sharing/rest';
const USER: AuthUser = {
  id: 'user-1',
  username: 'tester',
  orgId: 'org-1',
  roles: ['admin'],
  email: null,
} as unknown as AuthUser;

function sample(overrides: Partial<AgoItem>): AgoItem {
  return {
    id: 'sample',
    type: 'Web Map',
    title: 'Sample',
    owner: 'tester',
    access: 'private',
    ...overrides,
  };
}

function reportFrom(items: AgoItem[]): DryRunReport {
  return {
    portal: { url: PORTAL_URL, username: 'tester' },
    generatedAt: new Date().toISOString(),
    counts: {
      foldersTotal: 0,
      itemsTotal: items.length,
      itemsToImport: items.length,
      itemsToSkip: 0,
      byTargetType: {},
      byAgoType: {},
      byAccess: {},
    },
    folders: [],
    items: items.map((it) => classifyAndRow(it, '(root)')),
    warnings: [],
  };
}

function makeFakeItems(): ItemsService {
  let counter = 0;
  const created: Array<{
    id: string;
    type: string;
    title: string;
    data: unknown;
    access?: string;
  }> = [];
  const updated: Array<{ id: string; data: unknown }> = [];
  const fake = {
    create: jest.fn(async (_user: AuthUser, input: any) => {
      counter += 1;
      const id = `portal-item-${counter}`;
      created.push({
        id,
        type: input.type,
        title: input.title,
        data: input.data,
        access: input.access,
      });
      return { id };
    }),
    update: jest.fn(async (_user: AuthUser, id: string, input: any) => {
      updated.push({ id, data: input.data });
      return { id };
    }),
    __created: created,
    __updated: updated,
  };
  return fake as unknown as ItemsService;
}

function makeFakeWebMapImport(): WebMapJsonImportService {
  return {
    import: jest.fn(async (_args: any) => ({
      itemId: 'portal-map-1',
      warnings: [] as string[],
      layerCount: 1,
      skippedLayerCount: 0,
      remappedToDataLayerCount: 0,
    })),
  } as unknown as WebMapJsonImportService;
}

/** Fake hosted-FS importer for tests that don't exercise the
 *  hosted-FS dispatch path. Calls to `run` produce a stable
 *  "imported as data_layer" stub the assertions can inspect. */
function makeFakeHostedFs(): import('./hosted-fs.js').AgoHostedFsImportService {
  let counter = 0;
  return {
    run: jest.fn(async (_args: { title: string }) => {
      counter += 1;
      return {
        portalItemId: `portal-data-layer-${counter}`,
        layerCount: 1,
        featuresInserted: 10,
        attachmentsCopied: 0,
        warnings: [],
        // The Web Map remap path joins on this; the fake exposes a
        // single AGO layer 0 -> portal sublayer 'parcels' so the
        // spec can assert the resulting MapLayerSource shape.
        agoLayerIdToSublayerKey: { 0: 'parcels' },
      };
    }),
  } as unknown as import('./hosted-fs.js').AgoHostedFsImportService;
}

/** Fake storage service: file-import path uploadLocalFile call
 *  hands back stable storage-key + URL the assertions can inspect. */
function makeFakeStorage(): import('../storage/storage.service.js').StorageService {
  let counter = 0;
  return {
    uploadLocalFile: jest.fn(async (kind: string, _path: string) => {
      counter += 1;
      return {
        key: `${kind}/portal-file-${counter}`,
        publicUrl: `/api/portal/storage/private/${kind}/portal-file-${counter}`,
      };
    }),
  } as unknown as import('../storage/storage.service.js').StorageService;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Default to a no-network fetch mock so the importService
  // auto-probe path (which calls fetch on the AGO service URL)
  // doesn't hit DNS in tests that don't override fetch. Tests
  // that care about the probe response set their own jest.fn.
  globalThis.fetch = jest.fn(async () =>
    new Response('mock', { status: 404 }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('AgoImportService.run', () => {
  it('imports services + web maps + files in dependency order', async () => {
    const items = [
      sample({ id: 'wm-1', type: 'Web Map', title: 'Map' }),
      sample({
        id: 'svc-1',
        type: 'Feature Service',
        title: 'Parcels',
        url: 'https://server/arcgis/rest/services/Parcels/FeatureServer',
      }),
      sample({ id: 'file-1', type: 'PDF', title: 'Spec.pdf' }),
    ];
    // Web Map data fetch goes through fetch() and returns JSON;
    // file /data fetch goes through fetch() and returns binary
    // bytes the importer streams into MinIO via StorageService.
    globalThis.fetch = jest.fn(async (input: unknown) => {
      const url =
        typeof input === 'string'
          ? input
          : (input as { toString(): string }).toString();
      if (url.includes('/content/items/wm-1/data')) {
        return new Response(JSON.stringify({ version: '2.30', layers: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/content/items/file-1/data')) {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="Spec.pdf"',
          },
        });
      }
      return new Response('not-found', { status: 404 });
    }) as unknown as typeof fetch;
    const fakeItems = makeFakeItems();
    const fakeWebMap = makeFakeWebMapImport();
    const importer = new AgoImportService(fakeItems, fakeWebMap, makeFakeHostedFs(), makeFakeStorage());
    const report = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(report.total).toBe(3);
    expect(report.created).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);

    // The order in results MUST reflect the dependency order
    // (service before map before file), regardless of input
    // order.
    const order = report.results.map((r) => r.agoId);
    expect(order).toEqual(['svc-1', 'wm-1', 'file-1']);

    // The WebMap converter saw the right item.
    expect(fakeWebMap.import).toHaveBeenCalledTimes(1);
    expect((fakeWebMap.import as jest.Mock).mock.calls[0][0].title).toBe('Map');

    // ItemsService created the service + file items with the
    // right payload.
    const created = (fakeItems as any).__created;
    expect(created).toHaveLength(2);
    const service = created.find((c: any) => c.type === 'service');
    expect(service.data.url).toMatch(/FeatureServer$/);
    expect(service.data.protocol).toBe('arcgis_features');
    expect(service.data.agoItemId).toBe('svc-1');
    const file = created.find((c: any) => c.type === 'file');
    expect(file.data.fileName).toBe('Spec.pdf');
    expect(file.data.mimeType).toBe('application/pdf');
    expect(file.data.sizeBytes).toBe(4);
    expect(file.data.storageKey).toMatch(/^item-file\//);
    expect(file.data.storageUrl).toMatch(/^\/api\/portal\/storage\//);
  });

  it('records per-item failures without blocking the rest of the import', async () => {
    const items = [
      sample({
        id: 'svc-1',
        type: 'Feature Service',
        title: 'Will succeed',
        url: 'https://server/arcgis/rest/services/A/FeatureServer',
      }),
      sample({
        id: 'svc-2',
        type: 'Feature Service',
        title: 'Will fail',
        url: 'https://server/arcgis/rest/services/B/FeatureServer',
      }),
      sample({
        id: 'svc-3',
        type: 'Feature Service',
        title: 'Will also succeed',
        url: 'https://server/arcgis/rest/services/C/FeatureServer',
      }),
    ];
    const fakeItems = {
      create: jest.fn(async (_u: AuthUser, input: any) => {
        if (input.title === 'Will fail') {
          throw new Error('contrived ItemsService failure');
        }
        return { id: `portal-${input.title}` };
      }),
    } as unknown as ItemsService;
    const importer = new AgoImportService(fakeItems, makeFakeWebMapImport(), makeFakeHostedFs(), makeFakeStorage());
    const report = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(report.created).toBe(2);
    expect(report.failed).toBe(1);
    const failed = report.results.find((r) => r.status === 'failed');
    expect(failed?.agoId).toBe('svc-2');
    expect(failed?.error).toContain('contrived');
  });

  it('skips items the dry-run marked as not importable but records them in the report', async () => {
    const items = [
      sample({ id: 'wm', type: 'Web Map', title: 'OK' }),
      sample({ id: 'dash', type: 'Dashboard', title: 'Skipped dashboard' }),
      sample({ id: 'app', type: 'Web Mapping Application', title: 'Skipped app' }),
      sample({ id: 'form', type: 'Form', title: 'Skipped form' }),
    ];
    globalThis.fetch = jest.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // The dry-run report's `willImport` flag is what governs.
    // Construct a synthetic report matching what the dry-run
    // service would have produced.
    const report = reportFrom(items);
    // Mutate willImport to match the type-mapping classifier.
    for (const row of report.items) {
      if (
        row.agoType === 'Dashboard' ||
        row.agoType === 'Web Mapping Application' ||
        row.agoType === 'Form'
      ) {
        row.willImport = false;
        row.targetType = null;
        row.reason = 'Skipped by classifier';
      }
    }
    const importer = new AgoImportService(makeFakeItems(), makeFakeWebMapImport(), makeFakeHostedFs(), makeFakeStorage());
    const result = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report,
    });
    expect(result.created).toBe(1); // Just the Web Map
    expect(result.skipped).toBe(3);
    const skipped = result.results.filter((r) => r.status === 'skipped');
    expect(skipped.map((r) => r.agoId).sort()).toEqual([
      'app',
      'dash',
      'form',
    ]);
    for (const s of skipped) {
      expect(s.warnings).toContain('Skipped by classifier');
    }
  });

  it('captures WebMap converter warnings on the result', async () => {
    const items = [
      sample({ id: 'wm-1', type: 'Web Map', title: 'Mixed Map' }),
    ];
    globalThis.fetch = jest.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const fakeWebMap = {
      import: jest.fn(async () => ({
        itemId: 'portal-map-1',
        warnings: ['Unresolvable layer XYZ skipped'],
      })),
    } as unknown as WebMapJsonImportService;
    const importer = new AgoImportService(makeFakeItems(), fakeWebMap, makeFakeHostedFs(), makeFakeStorage());
    const report = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(report.created).toBe(1);
    expect(report.results[0]!.warnings).toContain(
      'Unresolvable layer XYZ skipped',
    );
  });

  it('emits a per-item failure when the WebMap /data fetch errors', async () => {
    const items = [sample({ id: 'wm-1', type: 'Web Map', title: 'Map' })];
    globalThis.fetch = jest.fn(async () =>
      new Response('boom', { status: 500 }),
    );
    const importer = new AgoImportService(
      makeFakeItems(),
      makeFakeWebMapImport(),
      makeFakeHostedFs(),
      makeFakeStorage(),
    );
    const report = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(report.failed).toBe(1);
    expect(report.results[0]!.error).toMatch(/Fetching WebMap JSON failed/);
  });

  it('mirrors AGO sharing scope onto created portal items', async () => {
    const items = [
      sample({
        id: 'svc-priv',
        type: 'Feature Service',
        title: 'Private svc',
        access: 'private',
        url: 'https://server/arcgis/rest/services/Priv/FeatureServer',
      }),
      sample({
        id: 'svc-org',
        type: 'Feature Service',
        title: 'Org svc',
        access: 'org',
        url: 'https://server/arcgis/rest/services/Org/FeatureServer',
      }),
      sample({
        id: 'svc-pub',
        type: 'Feature Service',
        title: 'Public svc',
        access: 'public',
        url: 'https://server/arcgis/rest/services/Pub/FeatureServer',
      }),
      // AGO's `shared` (specific groups) value has no items-table
      // equivalent on the portal; the importer collapses it to `org`
      // and the operator can tighten via the per-share UI.
      sample({
        id: 'svc-shared',
        type: 'Feature Service',
        title: 'Shared svc',
        access: 'shared',
        url: 'https://server/arcgis/rest/services/Sh/FeatureServer',
      }),
    ];
    const fakeItems = makeFakeItems();
    const importer = new AgoImportService(fakeItems, makeFakeWebMapImport(), makeFakeHostedFs(), makeFakeStorage());
    await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    const created = (fakeItems as any).__created as Array<{
      title: string;
      access: string;
    }>;
    expect(created.find((c) => c.title === 'Private svc')!.access).toBe(
      'private',
    );
    expect(created.find((c) => c.title === 'Org svc')!.access).toBe('org');
    expect(created.find((c) => c.title === 'Public svc')!.access).toBe(
      'public',
    );
    expect(created.find((c) => c.title === 'Shared svc')!.access).toBe('org');
  });

  it('pre-creates portal folders and populates childItemIds after items land', async () => {
    const items = [
      sample({
        id: 'svc-1',
        type: 'Feature Service',
        title: 'In Field Data',
        ownerFolder: 'folder-1',
        url: 'https://server/arcgis/rest/services/A/FeatureServer',
      }),
      sample({
        id: 'svc-2',
        type: 'Feature Service',
        title: 'Also in Field Data',
        ownerFolder: 'folder-1',
        url: 'https://server/arcgis/rest/services/B/FeatureServer',
      }),
      sample({
        id: 'svc-3',
        type: 'Feature Service',
        title: 'At root',
        url: 'https://server/arcgis/rest/services/C/FeatureServer',
      }),
    ];
    const report = reportFrom(items);
    // Inject the folder + the per-row folder ids the dry-run would
    // have captured (classifyAndRow's input goes through the
    // AgoClient.walkUserContent path which passes the folder, but
    // the spec helper sample() lets us set ownerFolder directly).
    report.folders = [
      { id: 'folder-1', title: 'Field Data' },
    ];
    report.counts.foldersTotal = 1;
    const fakeItems = makeFakeItems();
    const importer = new AgoImportService(fakeItems, makeFakeWebMapImport(), makeFakeHostedFs(), makeFakeStorage());
    const result = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report,
    });
    expect(result.created).toBe(3);
    expect(result.folders).toHaveLength(1);
    const folder = result.folders[0]!;
    expect(folder.agoFolderId).toBe('folder-1');
    expect(folder.title).toBe('Field Data');
    expect(folder.childCount).toBe(2);

    // The folder item was created first (so child items can
    // reference its id) and then updated with childItemIds.
    const created = (fakeItems as any).__created as Array<{
      id: string;
      type: string;
      title: string;
    }>;
    const folderItem = created.find((c) => c.type === 'folder')!;
    expect(folderItem.title).toBe('Field Data');
    const updated = (fakeItems as any).__updated as Array<{
      id: string;
      data: { childItemIds: string[] };
    }>;
    const folderUpdate = updated.find((u) => u.id === folderItem.id)!;
    expect(folderUpdate.data.childItemIds).toHaveLength(2);

    // The item at the AGO root did NOT get pulled into the folder.
    const rootItem = created.find((c) => c.title === 'At root')!;
    expect(folderUpdate.data.childItemIds).not.toContain(rootItem.id);
  });

  it('does not create a portal folder when the AGO folder has no importable items', async () => {
    const items = [
      sample({
        id: 'dash',
        type: 'Dashboard', // skipped by classifier
        title: 'Dashboard in empty folder',
        ownerFolder: 'folder-empty',
      }),
    ];
    const report = reportFrom(items);
    // Mark the row as skipped (matches what dry-run does for
    // unsupported types).
    for (const row of report.items) {
      row.willImport = false;
      row.targetType = null;
      row.reason = 'Unsupported';
    }
    report.folders = [{ id: 'folder-empty', title: 'Just Dashboards' }];
    const fakeItems = makeFakeItems();
    const importer = new AgoImportService(fakeItems, makeFakeWebMapImport(), makeFakeHostedFs(), makeFakeStorage());
    const result = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report,
    });
    expect(result.folders).toHaveLength(0);
    const created = (fakeItems as any).__created as Array<{ type: string }>;
    expect(created.find((c) => c.type === 'folder')).toBeUndefined();
  });

  it('dispatches hosted feature services through the hosted-FS importer', async () => {
    const items = [
      sample({
        id: 'svc-hosted',
        type: 'Feature Service',
        title: 'Hosted Parcels',
        typeKeywords: ['Hosted Service', 'Feature Service'],
        url: 'https://palavido.maps.arcgis.com/arcgis/rest/services/Parcels/FeatureServer',
      }),
    ];
    const fakeItems = makeFakeItems();
    const fakeHosted = makeFakeHostedFs();
    const importer = new AgoImportService(
      fakeItems,
      makeFakeWebMapImport(),
      fakeHosted,
      makeFakeStorage(),
    );
    const result = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    // Hosted FS should NOT have created a service item; it should
    // have gone through the dedicated hosted-FS path which produces
    // a data_layer.
    expect(fakeHosted.run).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
    expect(result.results[0]!.portalItemType).toBe('data_layer');
    expect(result.results[0]!.warnings.join(' ')).toMatch(/Copied 10 feature/);
  });

  it('remaps Web Map layer URLs to the just-imported portal data_layers', async () => {
    const items = [
      sample({
        id: 'svc-hosted',
        type: 'Feature Service',
        title: 'Hosted Parcels',
        typeKeywords: ['Hosted Service', 'Feature Service'],
        url: 'https://palavido.maps.arcgis.com/arcgis/rest/services/Parcels/FeatureServer',
      }),
      sample({ id: 'wm-1', type: 'Web Map', title: 'Parcels Map' }),
    ];
    // The Web Map data fetch returns a WebMap that references the
    // same FeatureServer (sublayer 0) we just imported as a
    // data_layer.
    globalThis.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({
          version: '2.30',
          operationalLayers: [
            {
              id: 'parcels-layer',
              title: 'Parcels',
              url: 'https://palavido.maps.arcgis.com/arcgis/rest/services/Parcels/FeatureServer/0',
              layerType: 'ArcGISFeatureLayer',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    // Capture the agoDataLayerLookup the importer hands to
    // WebMapJsonImportService so the spec can verify the lookup
    // was populated with the hosted-FS we just imported.
    let capturedLookup: Map<
      string,
      { itemId: string; agoLayerIdToSublayerKey: Record<number, string> }
    > | null = null;
    const fakeWebMap = {
      import: jest.fn(async (args: any) => {
        capturedLookup = args.agoDataLayerLookup ?? null;
        return {
          itemId: 'portal-map-1',
          warnings: [],
          layerCount: 1,
          skippedLayerCount: 0,
          // Pretend the converter found the lookup-rerouted layer
          // and emitted a `data-layer` source. The AgoImportService
          // surfaces this count in the import-result warnings.
          remappedToDataLayerCount: 1,
        };
      }),
    } as unknown as WebMapJsonImportService;
    const importer = new AgoImportService(
      makeFakeItems(),
      fakeWebMap,
      makeFakeHostedFs(),
      makeFakeStorage(),
    );
    const result = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(result.created).toBe(2);
    const mapResult = result.results.find((r) => r.agoId === 'wm-1');
    // The remap warning should fire on the map import result.
    expect(
      mapResult?.warnings.some((w) => /Remapped 1 layer reference/.test(w)),
    ).toBe(true);
    // The lookup the AgoImportService threaded to the WebMap
    // converter should carry an entry for the canonicalized AGO
    // service URL, mapping to the just-imported portal data_layer
    // + per-AGO-layer-id sublayer map.
    expect(capturedLookup).not.toBeNull();
    const lookup = capturedLookup as unknown as Map<
      string,
      { itemId: string; agoLayerIdToSublayerKey: Record<number, string> }
    >;
    const entry = lookup.get(
      'https://palavido.maps.arcgis.com/arcgis/rest/services/parcels/featureserver',
    );
    expect(entry).toBeDefined();
    expect(entry?.itemId).toBe('portal-data-layer-1');
    expect(entry?.agoLayerIdToSublayerKey[0]).toBe('parcels');
  });
  it('auto-probes a connected Map Service and writes layers onto the new item', async () => {
    const items = [
      sample({
        id: 'svc-ms',
        type: 'Map Service',
        title: 'County Map',
        url: 'https://server/arcgis/rest/services/County/MapServer',
      }),
    ];
    // The probe fetch hits /MapServer?f=json&token=tok and returns
    // a layer + table list. The auto-probe should populate the
    // service item's layers + selectedLayerIds + probedAt.
    globalThis.fetch = jest.fn(async (input: unknown) => {
      const url =
        typeof input === 'string'
          ? input
          : (input as { toString(): string }).toString();
      if (/mapserver/i.test(url) && url.includes('f=json')) {
        return new Response(
          JSON.stringify({
            layers: [
              { id: 0, name: 'Parcels', geometryType: 'esriGeometryPolygon' },
              { id: 1, name: 'Roads', geometryType: 'esriGeometryPolyline' },
            ],
            tables: [{ id: 2, name: 'OwnersTable' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return new Response('not-found', { status: 404 });
    }) as unknown as typeof fetch;
    const fakeItems = makeFakeItems();
    const importer = new AgoImportService(
      fakeItems,
      makeFakeWebMapImport(),
      makeFakeHostedFs(),
      makeFakeStorage(),
    );
    const report = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(report.created).toBe(1);
    // The probe should have triggered an items.update call with
    // the layers array populated.
    const updated = (fakeItems as any).__updated as Array<{
      id: string;
      data: any;
    }>;
    expect(updated).toHaveLength(1);
    const updatedData = updated[0]!.data;
    expect(updatedData.layers).toHaveLength(3); // 2 layers + 1 table
    expect(updatedData.layers[0]).toMatchObject({
      name: '0',
      title: 'Parcels',
      geometryType: 'polygon',
    });
    expect(updatedData.layers[1]).toMatchObject({
      name: '1',
      title: 'Roads',
      geometryType: 'line',
    });
    expect(updatedData.layers[2]).toMatchObject({
      name: '2',
      title: 'OwnersTable',
    });
    expect(updatedData.selectedLayerIds).toEqual([0, 1, 2]);
    expect(typeof updatedData.probedAt).toBe('string');
    // No warning should be emitted on the happy path.
    const svc = report.results.find((r) => r.agoId === 'svc-ms');
    expect(svc?.warnings).toEqual([]);
  });

  it('records a warning when auto-probe cannot reach the service', async () => {
    const items = [
      sample({
        id: 'svc-blocked',
        type: 'Feature Service',
        title: 'Blocked svc',
        url: 'https://server/arcgis/rest/services/Blocked/FeatureServer',
      }),
    ];
    // Probe gets a 403: item still gets created, warning is emitted.
    globalThis.fetch = jest.fn(async () =>
      new Response('forbidden', { status: 403 }),
    ) as unknown as typeof fetch;
    const fakeItems = makeFakeItems();
    const importer = new AgoImportService(
      fakeItems,
      makeFakeWebMapImport(),
      makeFakeHostedFs(),
      makeFakeStorage(),
    );
    const report = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(report.created).toBe(1);
    // No items.update fired because probe failed.
    const updated = (fakeItems as any).__updated as Array<{ id: string }>;
    expect(updated).toHaveLength(0);
    const svc = report.results.find((r) => r.agoId === 'svc-blocked');
    expect(svc?.warnings.join(' ')).toMatch(/Auto-probe.*HTTP 403/);
  });
});

describe('normalizeAgoServiceUrl', () => {
  it('strips a trailing sublayer id', () => {
    expect(
      normalizeAgoServiceUrl(
        'https://palavido.maps.arcgis.com/arcgis/rest/services/Parcels/FeatureServer/0',
      ),
    ).toBe(
      'https://palavido.maps.arcgis.com/arcgis/rest/services/parcels/featureserver',
    );
  });

  it('strips a trailing slash + query string', () => {
    expect(
      normalizeAgoServiceUrl(
        'https://palavido.maps.arcgis.com/arcgis/rest/services/Parcels/FeatureServer/?token=abc',
      ),
    ).toBe(
      'https://palavido.maps.arcgis.com/arcgis/rest/services/parcels/featureserver',
    );
  });

  it('is idempotent on an already-canonical URL', () => {
    const url =
      'https://palavido.maps.arcgis.com/arcgis/rest/services/parcels/featureserver';
    expect(normalizeAgoServiceUrl(url)).toBe(url);
  });

  it('returns empty for empty input', () => {
    expect(normalizeAgoServiceUrl('')).toBe('');
    expect(normalizeAgoServiceUrl('   ')).toBe('');
  });
});
