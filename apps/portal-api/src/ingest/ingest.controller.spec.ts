// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { resetIngestSlotsForTests } from './ingest-slots.js';
import { pinDiskUpload } from './ingest-disk-path.js';
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
    fileToGeoJsonFromPath: jest.fn().mockResolvedValue({
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
function diskUpload(): { file: Express.Multer.File; req: object; filePath: string } {
  const req = { id: 'ingest-spec' };
  const destination = mkdtempSync(join(tmpdir(), 'gg-ingest-'));
  const path = join(destination, 'payload.geojson');
  writeFileSync(path, '{"type":"FeatureCollection","features":[]}');
  pinDiskUpload(req, destination, path);
  return {
    req,
    filePath: realpathSync(path),
    file: {
      fieldname: 'file',
      originalname: 'upload.geojson',
      encoding: '7bit',
      mimetype: 'application/geo+json',
      size: 40,
      destination,
      filename: 'payload.geojson',
      path,
      buffer: Buffer.alloc(0),
      stream: undefined as never,
    },
  };
}

describe('IngestController publish gate', () => {
  afterEach(() => {
    resetIngestSlotsForTests();
  });

  describe('probe', () => {
    it('refuses a viewer and removes the upload it already received', async () => {
      const { controller, ingest } = makeController();
      const { file, req } = diskUpload();
      await expect(
        controller.probe(userWithRole('viewer'), file, req),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(ingest.probeFileFromPath).not.toHaveBeenCalled();
      expect(existsSync(file.destination)).toBe(false);
    });

    it('refuses a viewer even with no file, and says why', async () => {
      // The capability answer comes first so a viewer is told about
      // the role rather than about multipart field names.
      const { controller } = makeController();
      await expect(
        controller.probe(userWithRole('viewer'), undefined, {}),
      ).rejects.toMatchObject({
        message: 'Importing files requires the contributor or admin role.',
      });
    });

    it('lets a contributor through to the probe', async () => {
      const { controller, ingest } = makeController();
      const { file, req, filePath } = diskUpload();
      await expect(
        controller.probe(userWithRole('contributor'), file, req),
      ).resolves.toEqual(PROBE);
      expect(ingest.probeFileFromPath).toHaveBeenCalledWith(filePath);
      expect(existsSync(file.destination)).toBe(false);
    });

    it('honours a per-user grant, not just the role', async () => {
      // The gate reads the effective capability set, so an admin who
      // grants a viewer `can_publish_items` in the Users screen gets
      // a viewer who can import, matching ItemsService.create.
      const { controller } = makeController();
      const granted = userWithRole('viewer');
      (granted.capabilities as Set<CapabilityKey>).add('can_publish_items');
      const { file, req } = diskUpload();
      await expect(
        controller.probe(granted, file, req),
      ).resolves.toEqual(PROBE);
    });
  });

  describe('stage', () => {
    it('refuses a viewer before anything reaches the staging area', async () => {
      const { controller, staging, ingest } = makeController();
      const { file, req } = diskUpload();
      await expect(
        controller.stage(userWithRole('viewer'), file, req),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(staging.stageFromPath).not.toHaveBeenCalled();
      expect(ingest.probeFileFromPath).not.toHaveBeenCalled();
      expect(existsSync(file.destination)).toBe(false);
    });

    it('lets a contributor stage and probe', async () => {
      const { controller, staging } = makeController();
      const { file, req, filePath } = diskUpload();
      await expect(
        controller.stage(userWithRole('contributor'), file, req),
      ).resolves.toEqual({ stagingId: 'stg-1', ...PROBE });
      expect(staging.stageFromPath).toHaveBeenCalledWith(
        expect.objectContaining({ filePath }),
      );
    });
  });

  describe('to-geojson', () => {
    it('stays open to a viewer and parses from disk, then deletes the temp dir', async () => {
      const { controller, ingest } = makeController();
      const { file, req, filePath } = diskUpload();
      await expect(
        controller.toGeoJson(userWithRole('viewer'), file, req),
      ).resolves.toMatchObject({ driver: 'GeoJSON' });
      expect(ingest.fileToGeoJsonFromPath).toHaveBeenCalledWith(
        filePath,
        file.originalname,
      );
      expect(ingest.fileToGeoJson).not.toHaveBeenCalled();
      expect(existsSync(file.destination)).toBe(false);
    });

    it('does not let the same user start a second parse', async () => {
      const { controller } = makeController();
      const { acquireIngestSlot } = await import('./ingest-slots.js');
      const release = acquireIngestSlot(userWithRole('viewer').id);
      const { file, req } = diskUpload();
      await expect(
        controller.toGeoJson(userWithRole('viewer'), file, req),
      ).rejects.toMatchObject({ status: 429 });
      release();
      expect(existsSync(file.destination)).toBe(false);
    });
  });
});

describe('IngestController v3 layer import', () => {
  function fakeRes() {
    const res = {
      statusCode: 200,
      headersSent: false,
      body: '',
      setHeader: jest.fn(),
      flushHeaders: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn((code: number) => {
        res.statusCode = code;
        return res;
      }),
      write: jest.fn((chunk: string) => {
        res.headersSent = true;
        res.body += chunk;
      }),
      end: jest.fn(),
    };
    return res;
  }

  afterEach(() => resetIngestSlotsForTests());

  it('removes the upload when stagingId is malformed', async () => {
    const { controller } = makeController();
    const upload = diskUpload();
    await expect(
      controller.ingestV3Layer(
        fakeRes() as never,
        userWithRole('contributor'),
        'item',
        'layer',
        upload.file,
        upload.req,
        undefined,
        undefined,
        ['a', 'b'],
      ),
    ).rejects.toThrow(/stagingId/);
    expect(existsSync(upload.file.destination)).toBe(false);
  });

  it('answers a refused import with its real status, not 200', async () => {
    const items = {
      get: jest.fn(async () => {
        throw new ForbiddenException('no');
      }),
    };
    const controller = new IngestController(
      {} as never,
      items as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      {} as never,
    );
    const upload = diskUpload();
    const res = fakeRes();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.ingestV3Layer(
      res as never,
      userWithRole('contributor'),
      'item',
      'layer',
      upload.file,
      upload.req,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.flushHeaders).not.toHaveBeenCalled();
    expect(JSON.parse(res.body.trim())).toMatchObject({ event: 'error' });
  });
});
