// SPDX-License-Identifier: AGPL-3.0-or-later
import { HousekeepingService } from './housekeeping.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';
import type { DataLayerTablesService } from '../data-layer/tables.service.js';
import type { DataLayerSearchIndexService } from '../data-layer/search-index.service.js';
import type { CredentialService } from '../items/credential.service.js';
import type { StorageService } from '../storage/storage.service.js';

/**
 * Orphaned-upload sweep behavior pins.
 *
 * The invariants that keep this feature safe to ship:
 *   - only objects past the age floor are candidates
 *   - a key referenced ANYWHERE (attachment row, map icon row,
 *     item.storage_ref, or the JSON text scan) is never an orphan
 *   - the purge recomputes the orphan set itself and reports
 *     per-object success honestly
 *   - a listing failure yields "unavailable", never an empty
 *     orphan list that reads as "all clean"
 */

const HOURS = 60 * 60 * 1000;

interface FakeObject {
  key: string;
  sizeBytes: number;
  lastModified: Date | null;
}

function build(opts: {
  objectsByPrefix?: Record<string, FakeObject[]>;
  attachmentKeys?: string[];
  iconKeys?: string[];
  storageRefs?: string[];
  jsonKeys?: string[];
  offlinePackageKeys?: string[];
  listThrows?: boolean;
  deleteFails?: Set<string>;
}) {
  const prisma = {
    featureAttachment: {
      findMany: jest.fn(async () =>
        (opts.attachmentKeys ?? []).map((k) => ({ storageKey: k })),
      ),
    },
    mapIconUpload: {
      findMany: jest.fn(async () =>
        (opts.iconKeys ?? []).map((k) => ({ storageKey: k })),
      ),
    },
    item: {
      findMany: jest.fn(async () =>
        (opts.storageRefs ?? []).map((k) => ({ storageRef: k })),
      ),
    },
    offlinePackage: {
      findMany: jest.fn(async () =>
        (opts.offlinePackageKeys ?? []).map((k) => ({ storageKey: k })),
      ),
    },
    $queryRaw: jest.fn(async () =>
      (opts.jsonKeys ?? []).map((k) => ({ k })),
    ),
  } as unknown as PrismaService;

  const listObjectsUnder = jest.fn(async (prefix: string) => {
    if (opts.listThrows) throw new Error('minio down');
    // The service passes "kind/" (with the trailing slash).
    return opts.objectsByPrefix?.[prefix.replace(/\/$/, '')] ?? [];
  });
  const deleteObject = jest.fn(
    async (key: string) => !(opts.deleteFails?.has(key) ?? false),
  );
  const storage = {
    listObjectsUnder,
    deleteObject,
  } as unknown as StorageService;

  const cfg = { get: jest.fn(() => undefined) } as unknown as ConfigService;

  const svc = new HousekeepingService(
    prisma,
    cfg,
    {} as DataLayerTablesService,
    {} as DataLayerSearchIndexService,
    {} as CredentialService,
    storage,
  );
  return { svc, listObjectsUnder, deleteObject };
}

const OLD = new Date(Date.now() - 72 * HOURS);
const FRESH = new Date(Date.now() - 1 * HOURS);

describe('HousekeepingService orphaned uploads', () => {
  it('reports only unreferenced objects past the 48h age floor', async () => {
    const { svc } = build({
      objectsByPrefix: {
        'feature-attachment': [
          // referenced by an attachment row: keep
          { key: 'feature-attachment/ref-1', sizeBytes: 10, lastModified: OLD },
          // orphan: old and unreferenced
          { key: 'feature-attachment/orp-1', sizeBytes: 25, lastModified: OLD },
          // too fresh to judge: keep
          { key: 'feature-attachment/new-1', sizeBytes: 5, lastModified: FRESH },
          // no LastModified: keep (cannot prove age)
          { key: 'feature-attachment/unk-1', sizeBytes: 7, lastModified: null },
        ],
        'item-file': [
          // referenced via item.storage_ref: keep
          { key: 'item-file/ref-2', sizeBytes: 11, lastModified: OLD },
          // referenced via the JSON text scan: keep
          { key: 'item-file/ref-3', sizeBytes: 12, lastModified: OLD },
          // orphan
          { key: 'item-file/orp-2', sizeBytes: 100, lastModified: OLD },
        ],
      },
      attachmentKeys: ['feature-attachment/ref-1'],
      storageRefs: ['item-file/ref-2'],
      jsonKeys: ['item-file/ref-3'],
    });

    const report = await svc.orphanedUploadsReport();

    expect(report.unavailable).toBe(false);
    expect(report.minAgeHours).toBe(48);
    expect(report.orphanCount).toBe(2);
    expect(report.orphanBytes).toBe(125);
    expect(report.sample.map((s) => s.key).sort()).toEqual([
      'feature-attachment/orp-1',
      'item-file/orp-2',
    ]);
    const att = report.perPrefix.find(
      (p) => p.prefix === 'feature-attachment',
    )!;
    expect(att.objectCount).toBe(4);
    expect(att.orphanCount).toBe(1);
    expect(att.orphanBytes).toBe(25);
  });

  it('walks every managed prefix and never a public one', async () => {
    const { svc, listObjectsUnder } = build({ objectsByPrefix: {} });
    await svc.orphanedUploadsReport();
    const prefixes = listObjectsUnder.mock.calls.map((c) => c[0]).sort();
    expect(prefixes).toEqual([
      'feature-attachment/',
      'item-file/',
      'item-point-cloud/',
      'item-tile-layer/',
      'map-icon/',
      'offline-package/',
    ]);
    // Public image prefixes are out of scope by design: their
    // references live in loose URL fields, not rows.
    expect(prefixes).not.toContain('item-thumb/');
    expect(prefixes).not.toContain('user-avatar/');
  });

  it('purge recomputes, deletes each orphan, and reports failures honestly', async () => {
    const { svc, deleteObject } = build({
      objectsByPrefix: {
        'map-icon': [
          { key: 'map-icon/orp-a', sizeBytes: 30, lastModified: OLD },
          { key: 'map-icon/orp-b', sizeBytes: 40, lastModified: OLD },
          { key: 'map-icon/keep-fresh', sizeBytes: 50, lastModified: FRESH },
        ],
      },
      deleteFails: new Set(['map-icon/orp-b']),
    });

    const result = await svc.purgeOrphanedUploads();

    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenCalledWith('map-icon/orp-a');
    expect(deleteObject).toHaveBeenCalledWith('map-icon/orp-b');
    expect(deleteObject).not.toHaveBeenCalledWith('map-icon/keep-fresh');
    expect(result.deletedCount).toBe(1);
    expect(result.freedBytes).toBe(30);
    expect(result.failedCount).toBe(1);
  });

  it('never treats a live offline package as an orphan', async () => {
    // The archive is referenced by offline_package.storage_key, a
    // real column rather than JSON, so it needs its own source in
    // the reference scan. Miss it and the sweep deletes the basemap
    // out from under every deployment that has one, 48 hours after
    // it was built. The superseded row's archive is kept too:
    // collectors may still be carrying it.
    const { svc } = build({
      objectsByPrefix: {
        'offline-package': [
          { key: 'offline-package/live', sizeBytes: 900, lastModified: OLD },
          { key: 'offline-package/prev', sizeBytes: 800, lastModified: OLD },
          { key: 'offline-package/gone', sizeBytes: 700, lastModified: OLD },
        ],
      },
      offlinePackageKeys: ['offline-package/live', 'offline-package/prev'],
    });

    const report = await svc.orphanedUploadsReport();
    expect(report.sample.map((o) => o.key)).toEqual(['offline-package/gone']);
    expect(report.orphanCount).toBe(1);
  });

  it('reports unavailable (and deletes nothing) when listing fails', async () => {
    const { svc, deleteObject } = build({ listThrows: true });

    const report = await svc.orphanedUploadsReport();
    expect(report.unavailable).toBe(true);
    expect(report.orphanCount).toBe(0);

    const purge = await svc.purgeOrphanedUploads();
    expect(purge.unavailable).toBe(true);
    expect(purge.deletedCount).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
