// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type {
  PointCloudData,
  PointCloudSource,
  ISODateString,
} from '@gratis-gis/shared-types';
import { isPointCloudData } from '@gratis-gis/shared-types';

import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { StorageService } from '../storage/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  COPC_PROBE_BYTES,
  CopcParseError,
  parseCopcHeader,
} from './copc-header.js';
import { boundsToWgs84 } from './bbox-wgs84.js';

/**
 * Service for the point_cloud item type (#179, 3D-as-layers
 * phase A). Same lifecycle as the tile_layer service it mirrors:
 *
 *   1. The browser PUTs the COPC bytes straight to MinIO via a
 *      presigned URL, then calls finalizeUpload(). We ranged-read
 *      the first 64 KB, validate it really is COPC (LAS 1.4 +
 *      copc info VLR first), lift header metadata (point count,
 *      bounds, CRS WKT) onto item.data, and compose the dataUrl
 *      viewers will range-read.
 *
 *   2. resolveStorageKey() backs the range proxy endpoint. The
 *      authed path runs the normal item ACL via items.get; the
 *      anonymous path resolves only access='public' items, which
 *      is what lets a public map with a point cloud layer render
 *      for signed-out visitors (the public-mirror rule).
 *
 * Validation happens against the bytes in MinIO, not a client-
 * supplied header blob, so a tampered finalize call cannot stamp
 * fake metadata onto a non-COPC file.
 */
@Injectable()
export class PointCloudService {
  private readonly log = new Logger(PointCloudService.name);

  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
  ) {}

  /**
   * Merging tiles needs the point cloud worker, which only runs
   * where the server-heavy analysis tier is enabled. Refuse with a
   * plain-language 503 rather than queue a job nothing will pick up.
   * Same gate the analysis jobs use.
   */
  private assertServerTier(): void {
    const tiers = (this.cfg.get<string>('ANALYSIS_TIERS') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tiers.includes('server-heavy')) {
      throw new ServiceUnavailableException(
        'Merging lidar tiles is not enabled on this portal. The administrator can enable it by deploying the analysis worker (see infra docs).',
      );
    }
  }

  /**
   * Validate a batch of uploaded source tiles from a finalize-style
   * body: each key must sit under our own prefix (the body is
   * client-supplied), and the count/sizes must be sane. Returns the
   * normalized PointCloudSource records.
   */
  private validateSources(
    sources: Array<{ storageKey: string; fileName: string; sizeBytes: number }>,
  ): PointCloudSource[] {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new BadRequestException('Add at least one lidar file.');
    }
    if (sources.length > 500) {
      throw new BadRequestException(
        'That is more than 500 tiles in one go. Split it into smaller batches.',
      );
    }
    const now = new Date().toISOString() as ISODateString;
    const seen = new Set<string>();
    return sources.map((s) => {
      if (typeof s.storageKey !== 'string' || s.storageKey.length === 0) {
        throw new BadRequestException('A source tile is missing its storageKey.');
      }
      if (!s.storageKey.startsWith('item-point-cloud/')) {
        throw new BadRequestException(
          'A source tile is not a point-cloud upload.',
        );
      }
      if (seen.has(s.storageKey)) {
        throw new BadRequestException('The same tile was added twice.');
      }
      seen.add(s.storageKey);
      if (typeof s.fileName !== 'string' || s.fileName.length === 0) {
        throw new BadRequestException('A source tile is missing its fileName.');
      }
      if (
        typeof s.sizeBytes !== 'number' ||
        !Number.isFinite(s.sizeBytes) ||
        s.sizeBytes <= 0
      ) {
        throw new BadRequestException('A source tile has an invalid size.');
      }
      return {
        storageKey: s.storageKey,
        fileName: s.fileName,
        sizeBytes: s.sizeBytes,
        addedAt: now,
      };
    });
  }

  /**
   * Queue a merge of the given source tiles into this point cloud's
   * COPC (#200). Records the sources on the item, flips it to
   * 'building', and enqueues a copc-build job the worker runs with
   * untwine. The item's currently-served file (if any) is left in
   * place so a rebuild never blanks a live layer.
   */
  async buildFromSources(
    user: AuthUser,
    itemId: string,
    body: {
      sources: Array<{ storageKey: string; fileName: string; sizeBytes: number }>;
    },
  ): Promise<{ jobId: string; itemId: string }> {
    this.assertServerTier();
    const item = await this.items.get(user, itemId);
    if (item.type !== 'point_cloud') {
      throw new BadRequestException(`Item ${itemId} is not a point_cloud.`);
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        'Only the owner or an org admin can build this point cloud.',
      );
    }
    const sources = this.validateSources(body.sources);
    return this.enqueueBuild(user, item, sources);
  }

  /**
   * Append more source tiles to an existing point cloud and rebuild
   * the merged COPC over the full set (#200). Re-merge from retained
   * sources rather than appending to the octree, which COPC does not
   * support cleanly.
   */
  async addSources(
    user: AuthUser,
    itemId: string,
    body: {
      sources: Array<{ storageKey: string; fileName: string; sizeBytes: number }>;
    },
  ): Promise<{ jobId: string; itemId: string }> {
    this.assertServerTier();
    const item = await this.items.get(user, itemId);
    if (item.type !== 'point_cloud') {
      throw new BadRequestException(`Item ${itemId} is not a point_cloud.`);
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        'Only the owner or an org admin can add tiles to this point cloud.',
      );
    }
    const added = this.validateSources(body.sources);
    const prev = isPointCloudData(item.data) ? item.data : null;
    const existingSources = [...(prev?.sources ?? [])];
    // Adding tiles to a cloud that was a single-file upload: the
    // original file is not yet in sources[], so seed it as the first
    // source. untwine reads a COPC as happily as a raw LAZ, so the
    // re-merge folds the original in rather than dropping it.
    if (
      existingSources.length === 0 &&
      prev?.storageKey &&
      prev.storageKey.startsWith('item-point-cloud/')
    ) {
      existingSources.push({
        storageKey: prev.storageKey,
        fileName: prev.fileName || 'original.copc.laz',
        sizeBytes: prev.sizeBytes || 0,
        addedAt: prev.uploadedAt ?? (new Date().toISOString() as ISODateString),
      });
    }
    const existingKeys = new Set(existingSources.map((s) => s.storageKey));
    for (const s of added) {
      if (existingKeys.has(s.storageKey)) {
        throw new BadRequestException(
          'One of those tiles is already part of this point cloud.',
        );
      }
    }
    const merged = [...existingSources, ...added];
    return this.enqueueBuild(user, item, merged);
  }

  /**
   * Shared tail of build + add: write the source list and 'building'
   * state onto the item, then create the copc-build job. Keeps the
   * existing served file and metadata untouched so the layer stays
   * live until the worker swaps in the freshly merged COPC.
   */
  private async enqueueBuild(
    user: AuthUser,
    item: { id: string; data: unknown },
    sources: PointCloudSource[],
  ): Promise<{ jobId: string; itemId: string }> {
    const prev = isPointCloudData(item.data) ? item.data : null;
    const data: PointCloudData = {
      // Preserve the currently-served file + metadata during a
      // rebuild; a fresh build starts from an empty served file.
      ...(prev ?? {
        version: 1,
        format: 'copc',
        storageKey: '',
        storageUrl: '',
        fileName: '',
        sizeBytes: 0,
        uploadedAt: new Date(0).toISOString() as ISODateString,
      }),
      version: 1,
      format: 'copc',
      sources,
      processingState: 'building',
    };
    delete data.processingError;

    await this.items.update(user, item.id, {
      data: data as unknown as Prisma.JsonObject,
    });

    const job = await this.prisma.analysisJob.create({
      data: {
        orgId: user.orgId,
        userId: user.id,
        kind: 'copc-build',
        params: { sourceKeys: sources.map((s) => s.storageKey) },
        sourceItemId: item.id,
        targetItemId: item.id,
      },
    });
    this.log.log(
      `point_cloud ${item.id}: queued copc-build over ${sources.length} tile(s) (job ${job.id})`,
    );
    return { jobId: job.id, itemId: item.id };
  }

  async finalizeUpload(
    user: AuthUser,
    itemId: string,
    input: {
      storageKey: string;
      storageUrl: string;
      fileName: string;
      sizeBytes: number;
    },
  ): Promise<PointCloudData> {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'point_cloud') {
      throw new BadRequestException(`Item ${itemId} is not a point_cloud.`);
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        'Only the owner or an org admin can attach a point cloud file to this item.',
      );
    }
    if (typeof input.storageKey !== 'string' || input.storageKey.length === 0) {
      throw new BadRequestException('storageKey is required');
    }
    // Only accept keys under our own prefix: the finalize body is
    // client-supplied, and a key pointing into another prefix
    // (thumbnails, attachments) must not become readable through
    // the point-cloud proxy.
    if (!input.storageKey.startsWith('item-point-cloud/')) {
      throw new BadRequestException('storageKey is not a point-cloud upload');
    }
    if (typeof input.fileName !== 'string' || input.fileName.length === 0) {
      throw new BadRequestException('fileName is required');
    }
    if (
      typeof input.sizeBytes !== 'number' ||
      !Number.isFinite(input.sizeBytes) ||
      input.sizeBytes <= 0
    ) {
      throw new BadRequestException('sizeBytes must be a positive number');
    }

    // Validate the actual bytes in MinIO. Ranged read: COPC files
    // run to gigabytes but everything we need sits in the first
    // 64 KB.
    let head: Buffer;
    try {
      const upstream = await this.storage.streamObject(
        input.storageKey,
        `bytes=0-${COPC_PROBE_BYTES - 1}`,
      );
      head = await collectStream(upstream.body, COPC_PROBE_BYTES);
    } catch (err) {
      throw new BadRequestException(
        `Could not read the uploaded file from storage: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsed;
    try {
      parsed = parseCopcHeader(head);
    } catch (err) {
      if (err instanceof CopcParseError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    const data: PointCloudData = {
      version: 1,
      format: 'copc',
      storageKey: input.storageKey,
      // Persist the API-mediated URL the storage service minted
      // (item-point-cloud is a private kind; there is no anonymous
      // MinIO URL to leak).
      storageUrl: input.storageUrl,
      fileName: input.fileName,
      sizeBytes: input.sizeBytes,
      uploadedAt: new Date().toISOString() as ISODateString,
      pointCount: parsed.pointCount,
      bounds: parsed.bounds,
      lasVersion: parsed.lasVersion,
      pointFormat: parsed.pointFormat,
      hasRgb: parsed.hasRgb,
      // The .copc.laz suffix is load-bearing: COPC readers sniff
      // the URL for ".copc." to enable viewport streaming.
      dataUrl: `/api/portal/point-cloud/${itemId}/file.copc.laz`,
    };
    if (parsed.crsWkt) data.crsWkt = parsed.crsWkt;
    const bboxWgs84 = boundsToWgs84(parsed.bounds, parsed.crsWkt);
    if (bboxWgs84) data.bboxWgs84 = bboxWgs84;

    // Replacing an existing upload: delete the old object so a
    // re-upload doesn't leak gigabytes in MinIO.
    const previous: unknown = item.data;
    if (
      isPointCloudData(previous) &&
      previous.storageKey &&
      previous.storageKey !== input.storageKey
    ) {
      await this.storage.deleteObject(previous.storageKey);
    }

    await this.items.update(user, itemId, {
      data: data as unknown as Prisma.JsonObject,
    });
    this.log.log(
      `point_cloud ${itemId}: finalized ${input.fileName} (${parsed.pointCount} pts, LAS ${parsed.lasVersion}, pdrf ${parsed.pointFormat})`,
    );
    return data;
  }

  /**
   * Resolve the MinIO key for the serve endpoint. `user` is null
   * for anonymous requests, which resolve only when the item is
   * shared publicly.
   */
  async resolveStorageKey(
    user: AuthUser | null,
    itemId: string,
  ): Promise<string> {
    let data: unknown;
    if (user) {
      const item = await this.items.get(user, itemId);
      if (item.type !== 'point_cloud') {
        throw new BadRequestException(`Item ${itemId} is not a point_cloud.`);
      }
      data = item.data;
    } else {
      const item = await this.prisma.item.findFirst({
        where: {
          id: itemId,
          type: 'point_cloud',
          access: 'public',
          deletedAt: null,
        },
        select: { data: true },
      });
      if (!item) {
        throw new NotFoundException('Point cloud not found.');
      }
      data = item.data;
    }
    if (!isPointCloudData(data) || !data.storageKey) {
      throw new NotFoundException(
        'Point cloud has not been uploaded yet (or the upload finalize step did not run).',
      );
    }
    return data.storageKey;
  }
}

/**
 * Collect a readable stream into a Buffer, hard-capped. The cap is
 * belt and braces: the Range header already bounds the response,
 * but a misbehaving upstream must not buffer unbounded bytes into
 * the api heap.
 */
function collectStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Ranged read returned more bytes than requested'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
