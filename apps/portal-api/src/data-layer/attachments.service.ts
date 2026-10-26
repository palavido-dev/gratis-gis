// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  FeatureAttachment,
  FeatureAttachmentGroup,
  RegisterFeatureAttachmentInput,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  FEATURE_ATTACHMENT_MAX_BYTES,
  StorageService,
} from '../storage/storage.service.js';
import { DataLayerEngine } from '../engine/data-layer.js';

/**
 * Storage-key prefix the presign path mints for attachment uploads
 * (StorageService composes keys as `<kind>/<uuid>`). register()
 * takes the key from the client, so it must be pinned here: an
 * arbitrary key would later be deleted verbatim by remove(),
 * turning attachment delete into arbitrary-MinIO-object delete,
 * and served through the private-asset route under the wrong ACL.
 */
const ATTACHMENT_KEY_PREFIX = 'feature-attachment/';

/** Columns exposed on every public attachment record (#226). */
const ATTACHMENT_PUBLIC_SELECT = {
  id: true,
  fileName: true,
  mime: true,
  sizeBytes: true,
  storageUrl: true,
  createdAt: true,
  createdBy: true,
} as const;

type AttachmentRow = {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  storageUrl: string;
  createdAt: Date;
  createdBy: string;
};

/** Prisma returns Date; the wire contract is an ISO string. */
function toPublicAttachment(row: AttachmentRow): FeatureAttachment {
  return {
    id: row.id,
    fileName: row.fileName,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    storageUrl: row.storageUrl,
    createdAt: row.createdAt.toISOString() as FeatureAttachment['createdAt'],
    createdBy: row.createdBy,
  };
}

/** Cap on `?featureIds=` entries so a typo cannot explode the IN list. */
export const ATTACHMENT_BULK_FEATURE_ID_CAP = 500;

@Injectable()
export class DataLayerAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly dataLayer: DataLayerEngine,
  ) {}

  async list(
    itemId: string,
    layerId: string,
    featureId: string,
  ): Promise<FeatureAttachment[]> {
    const rows = await this.prisma.featureAttachment.findMany({
      where: { itemId, layerId, featureId },
      orderBy: { createdAt: 'asc' },
      select: ATTACHMENT_PUBLIC_SELECT,
    });
    return rows.map(toPublicAttachment);
  }

  /**
   * Layer-wide attachment inventory (#226). Pass `featureIds` to
   * scope the query, or `all: true` for every attachment on the
   * layer. Returns groups keyed by featureId so callers don't have
   * to re-bucket a flat list.
   */
  async listForLayer(
    itemId: string,
    layerId: string,
    opts: { featureIds?: string[]; all?: boolean },
  ): Promise<FeatureAttachmentGroup[]> {
    const featureIds = opts.featureIds ?? [];
    if (!opts.all && featureIds.length === 0) {
      throw new BadRequestException(
        'Pass ?featureIds=id1,id2 or ?all=1',
      );
    }
    if (featureIds.length > ATTACHMENT_BULK_FEATURE_ID_CAP) {
      throw new BadRequestException(
        `At most ${ATTACHMENT_BULK_FEATURE_ID_CAP} featureIds per request`,
      );
    }

    const rows = await this.prisma.featureAttachment.findMany({
      where: {
        itemId,
        layerId,
        ...(opts.all ? {} : { featureId: { in: featureIds } }),
      },
      orderBy: [{ featureId: 'asc' }, { createdAt: 'asc' }],
      select: {
        ...ATTACHMENT_PUBLIC_SELECT,
        featureId: true,
      },
    });

    const byFeature = new Map<string, FeatureAttachment[]>();
    // Preserve the caller's featureId order when scoped; for all=1
    // fall through insertion order from the query.
    if (!opts.all) {
      for (const fid of featureIds) byFeature.set(fid, []);
    }
    for (const row of rows) {
      const { featureId, ...att } = row;
      const pub = toPublicAttachment(att);
      const list = byFeature.get(featureId);
      if (list) list.push(pub);
      else byFeature.set(featureId, [pub]);
    }
    return Array.from(byFeature.entries()).map(
      ([featureId, attachments]) => ({ featureId, attachments }),
    );
  }

  async register(
    itemId: string,
    layerId: string,
    featureId: string,
    input: RegisterFeatureAttachmentInput,
    userId: string,
  ): Promise<FeatureAttachment> {
    if (
      typeof input.storageKey !== 'string' ||
      !input.storageKey.startsWith(ATTACHMENT_KEY_PREFIX)
    ) {
      throw new BadRequestException(
        'storageKey is not an attachment upload',
      );
    }

    // #224: refuse to parent an attachment to a feature that does
    // not exist (orphans were invisible and never cleaned up).
    const current = await this.dataLayer.listFeatures({
      itemId,
      layerId,
      entity: featureId,
    });
    if (current.features.length === 0) {
      throw new NotFoundException('Feature not found');
    }

    // #224: HeadObject for the real size; reject missing / over-cap
    // objects so register cannot invent sizeBytes or point at a key
    // that was never uploaded.
    const realSize = await this.storage.headObjectSize(input.storageKey);
    if (realSize === null) {
      throw new BadRequestException(
        'Uploaded object was not found; complete the presigned PUT before registering',
      );
    }
    if (realSize > FEATURE_ATTACHMENT_MAX_BYTES) {
      await this.storage.deleteObject(input.storageKey);
      throw new BadRequestException(
        `Attachment exceeds the ${FEATURE_ATTACHMENT_MAX_BYTES} byte limit`,
      );
    }

    const row = await this.prisma.featureAttachment.create({
      data: {
        itemId,
        layerId,
        featureId,
        fileName: input.fileName,
        mime: input.mime,
        sizeBytes: realSize,
        storageKey: input.storageKey,
        storageUrl: input.storageUrl,
        createdBy: userId,
      },
      select: ATTACHMENT_PUBLIC_SELECT,
    });
    return toPublicAttachment(row);
  }

  /**
   * Resolve an attachment for streaming (#226). Returns the stored
   * key + display name; the controller streams via StorageService.
   */
  async getForDownload(
    itemId: string,
    layerId: string,
    featureId: string,
    attachmentId: string,
  ): Promise<{ storageKey: string; fileName: string }> {
    const row = await this.prisma.featureAttachment.findFirst({
      where: { id: attachmentId, itemId, layerId, featureId },
      select: { storageKey: true, fileName: true },
    });
    if (!row) throw new NotFoundException('Attachment not found');
    if (!row.storageKey.startsWith(ATTACHMENT_KEY_PREFIX)) {
      // Pre-guard rows with arbitrary keys must not be streamed —
      // same failure mode as remove().
      throw new NotFoundException('Attachment not found');
    }
    return row;
  }

  /**
   * Delete an attachment row AND its MinIO object. Object delete is
   * best-effort; a stuck metadata row is worse than a leaked 25 MB
   * object, so we don't rollback the DB on storage failure (the
   * storage service logs and swallows).
   */
  async remove(
    itemId: string,
    layerId: string,
    featureId: string,
    attachmentId: string,
  ): Promise<void> {
    const row = await this.prisma.featureAttachment.findFirst({
      where: { id: attachmentId, itemId, layerId, featureId },
      select: { id: true, storageKey: true },
    });
    if (!row) throw new NotFoundException('Attachment not found');
    await this.prisma.featureAttachment.delete({ where: { id: row.id } });
    // Re-check the prefix before touching storage: rows registered
    // before the guard above landed could carry an arbitrary key,
    // and deleting one verbatim is exactly the primitive we are
    // closing. A leaked object is the safe failure mode.
    if (row.storageKey.startsWith(ATTACHMENT_KEY_PREFIX)) {
      await this.storage.deleteObject(row.storageKey);
    }
  }
}
