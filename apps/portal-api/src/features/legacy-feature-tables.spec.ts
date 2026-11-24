// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { resetTenancyModeForTests } from '../common/tenancy.js';
import { IngestController } from '../ingest/ingest.controller.js';
import { ItemsService } from '../items/items.service.js';
import { makeAuthUser, makeItem } from '../testing/org-fixtures.js';
import { FeaturesController } from './features.controller.js';
import {
  LegacyFeatureTablesGuard,
  assertCurrentDataLayerVersion,
  dataLayerVersion,
} from './legacy-feature-tables.js';
import { RelationshipsController } from './relationships.controller.js';

/**
 * Per-item feature tables (data layer versions 1 and 2) are not used
 * when the install serves many organizations: their routes answer 404
 * and no data layer may be stored in a version other than 3. A
 * one-organization install keeps them as before.
 */
describe.each(['single', 'multi'] as const)('legacy feature tables (%s mode)', (mode) => {
  const saved = process.env.GRATIS_TENANCY;
  beforeEach(() => {
    if (mode === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = saved;
    resetTenancyModeForTests();
  });

  it('the guard answers 404 in multi mode and lets the request through in single mode', () => {
    const guard = new LegacyFeatureTablesGuard();
    if (mode === 'multi') expect(() => guard.canActivate()).toThrow(NotFoundException);
    else expect(guard.canActivate()).toBe(true);
  });

  function service() {
    const prisma = { item: { create: jest.fn(), findUnique: jest.fn() } };
    const svc = new ItemsService(
      prisma as never,
      {} as never,
      {} as never,
      { snapshot: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, prisma };
  }

  it('GET /items/:id/geojson on a version 2 layer: 404 in multi mode', async () => {
    const { svc } = service();
    const user = makeAuthUser();
    const legacy = makeItem({ data: { version: 2, storageType: 'postgis' } as never });
    jest.spyOn(svc, 'get').mockResolvedValue(legacy as never);
    if (mode === 'multi') {
      await expect(svc.getGeoJson(user, legacy.id)).rejects.toBeInstanceOf(NotFoundException);
    }
    // A version 3 layer keeps its answer in both modes.
    const current = makeItem({ data: { version: 3, layers: [] } as never });
    jest.spyOn(svc, 'get').mockResolvedValue(current as never);
    await expect(svc.getGeoJson(user, current.id)).resolves.toEqual({
      type: 'FeatureCollection',
      features: [],
    });
  });

  it('creating a version 2 data layer is refused before any write in multi mode', async () => {
    if (mode === 'single') return;
    const { svc, prisma } = service();
    await expect(
      svc.create(
        makeAuthUser({ orgRole: 'admin', capabilities: new Set(['can_publish_items']) } as never),
        {
          type: 'data_layer',
          title: 'Old',
          access: 'private',
          data: { version: 2, storageType: 'postgis', fields: [] },
        } as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.item.create).not.toHaveBeenCalled();
  });

  it('a data layer that is not version 3 is refused only in multi mode', () => {
    for (const data of [{ version: 2, storageType: 'postgis' }, { version: 1 }, {}, null]) {
      if (mode === 'multi') {
        expect(() => assertCurrentDataLayerVersion('data_layer', data)).toThrow(
          BadRequestException,
        );
      } else {
        expect(() => assertCurrentDataLayerVersion('data_layer', data)).not.toThrow();
      }
    }
    expect(() =>
      assertCurrentDataLayerVersion('data_layer', { version: 3, layers: [] }),
    ).not.toThrow();
    // Other item types carry their own versions.
    expect(() => assertCurrentDataLayerVersion('map', { version: 1 })).not.toThrow();
  });
});

describe('legacy feature table routes carry the guard', () => {
  const guards = (target: object): unknown[] =>
    (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];

  it('on /items/:id/features and /items/:id/relationships', () => {
    expect(guards(FeaturesController)).toContain(LegacyFeatureTablesGuard);
    expect(guards(RelationshipsController)).toContain(LegacyFeatureTablesGuard);
  });

  it('on POST /items/:id/ingest only, not on the other ingest routes', () => {
    const proto = IngestController.prototype as unknown as Record<string, object>;
    expect(guards(proto.ingestFile!)).toContain(LegacyFeatureTablesGuard);
    expect(guards(IngestController)).not.toContain(LegacyFeatureTablesGuard);
  });

  it('reads the stored version', () => {
    expect(dataLayerVersion({ version: 3 })).toBe(3);
    expect(dataLayerVersion({ version: '3' })).toBe(0);
    expect(dataLayerVersion(undefined)).toBe(0);
  });
});
