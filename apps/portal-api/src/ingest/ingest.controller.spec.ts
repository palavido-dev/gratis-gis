// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import { IngestController } from './ingest.controller.js';
import type { IngestService } from './ingest.service.js';
import type { IngestStagingService } from './ingest-staging.service.js';

/**
 * The wizard-facing ingest entry points (probe, stage) feed item
 * creation, so they carry the same `can_publish_items` gate as
 * ItemsService.create. Until 2026-09 they sat behind JwtAuthGuard
 * alone while their docblock claimed "admin-or-up", which let any
 * signed-in viewer hold 1 GB of staging disk for an hour per upload.
 *
 * to-geojson is asserted to stay open to every signed-in user on
 * purpose: its callers are the data-layer, geo-boundary and map
 * editors, which an edit share opens to a viewer-role user. Gating it
 * on the publish capability would break those without protecting
 * anything, since the write that follows is what checks `canEdit`.
 */
function userWithRole(role: 'viewer' | 'contributor' | 'admin'): AuthUser {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    orgId: '00000000-0000-0000-0000-0000000000bb',
    orgRole: role,
    capabilities: new Set<CapabilityKey>(ROLE_BASELINES[role]),
  } as unknown as AuthUser;
}

const PROBE = { driver: 'GeoJSON', layers: [] };

function makeController() {
  const ingest = {
    probeFileFromPath: jest.fn().mockResolvedValue(PROBE),
    fileToGeoJson: jest.fn().mockResolvedValue({
      geojson: { type: 'FeatureCollection', features: [] },
      fields: [],
      driver: 'GeoJSON',
      sourceSrs: 'EPSG:4326',
    }),
  } as unknown as IngestService;
  const staging = {
    stageFromPath: jest.fn().mockResolvedValue({
      stagingId: 'stg-1',
      filePath: '/staged/upload.gpkg',
    }),
    dropStaging: jest.fn().mockResolvedValue(undefined),
  } as unknown as IngestStagingService;
  // Only the two collaborators the gated handlers reach are real
  // mocks. The rest are placeholders: the gate must fire before any
  // of them is touched, and a TypeError here would say it did not.
  const controller = new IngestController(
    ingest,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    staging,
  );
  return { controller, ingest, staging };
}

/**
 * A multer disk upload as the handlers see it: the bytes already sit
 * in a per-request temp dir that the handler is responsible for
 * removing. Built for real so the refusal path can be checked to
 * clean up rather than leak the directory.
 */
function diskUpload(): Express.Multer.File {
  const destination = mkdtempSync(join(tmpdir(), 'gg-ingest-spec-'));
  const path = join(destination, 'upload.geojson');
  writeFileSync(path, '{"type":"FeatureCollection","features":[]}');
  return {
    fieldname: 'file',
    originalname: 'upload.geojson',
    encoding: '7bit',
    mimetype: 'application/geo+json',
    size: 40,
    destination,
    filename: 'upload.geojson',
    path,
    buffer: Buffer.alloc(0),
    stream: undefined as never,
  };
}

describe('IngestController publish gate', () => {
  describe('probe', () => {
    it('refuses a viewer and removes the upload it already received', async () => {
      const { controller, ingest } = makeController();
      const file = diskUpload();
      await expect(
        controller.probe(userWithRole('viewer'), file),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(ingest.probeFileFromPath).not.toHaveBeenCalled();
      expect(existsSync(file.destination)).toBe(false);
    });

    it('refuses a viewer even with no file, and says why', async () => {
      // The capability answer comes first so a viewer is told about
      // the role rather than about multipart field names.
      const { controller } = makeController();
      await expect(
        controller.probe(userWithRole('viewer'), undefined),
      ).rejects.toMatchObject({
        message: 'Importing files requires the contributor or admin role.',
      });
    });

    it('lets a contributor through to the probe', async () => {
      const { controller, ingest } = makeController();
      const file = diskUpload();
      await expect(
        controller.probe(userWithRole('contributor'), file),
      ).resolves.toEqual(PROBE);
      expect(ingest.probeFileFromPath).toHaveBeenCalledWith(file.path);
      expect(existsSync(file.destination)).toBe(false);
    });

    it('honours a per-user grant, not just the role', async () => {
      // The gate reads the effective capability set, so an admin who
      // grants a viewer `can_publish_items` in the Users screen gets
      // a viewer who can import, matching ItemsService.create.
      const { controller } = makeController();
      const granted = userWithRole('viewer');
      (granted.capabilities as Set<CapabilityKey>).add('can_publish_items');
      await expect(
        controller.probe(granted, diskUpload()),
      ).resolves.toEqual(PROBE);
    });
  });

  describe('stage', () => {
    it('refuses a viewer before anything reaches the staging area', async () => {
      const { controller, staging, ingest } = makeController();
      const file = diskUpload();
      await expect(
        controller.stage(userWithRole('viewer'), file),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(staging.stageFromPath).not.toHaveBeenCalled();
      expect(ingest.probeFileFromPath).not.toHaveBeenCalled();
      expect(existsSync(file.destination)).toBe(false);
    });

    it('lets a contributor stage and probe', async () => {
      const { controller, staging } = makeController();
      const file = diskUpload();
      await expect(
        controller.stage(userWithRole('contributor'), file),
      ).resolves.toEqual({ stagingId: 'stg-1', ...PROBE });
      expect(staging.stageFromPath).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: file.path }),
      );
    });
  });

  describe('to-geojson', () => {
    it('stays open to a viewer, whose edit rights live on the target item', async () => {
      const { controller, ingest } = makeController();
      await expect(
        controller.toGeoJson({
          ...diskUpload(),
          buffer: Buffer.from('{}'),
        }),
      ).resolves.toMatchObject({ driver: 'GeoJSON' });
      expect(ingest.fileToGeoJson).toHaveBeenCalled();
    });
  });
});
