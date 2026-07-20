// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PointCloudData, ISODateString } from '@gratis-gis/shared-types';
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
  ) {}

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
