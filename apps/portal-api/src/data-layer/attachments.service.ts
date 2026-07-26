// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

/**
 * Storage-key prefix the presign path mints for attachment uploads
 * (StorageService composes keys as `<kind>/<uuid>`). register()
 * takes the key from the client, so it must be pinned here: an
 * arbitrary key would later be deleted verbatim by remove(),
 * turning attachment delete into arbitrary-MinIO-object delete,
 * and served through the private-asset route under the wrong ACL.
 */
const ATTACHMENT_KEY_PREFIX = 'feature-attachment/';

/**
 * Per-feature attachments for v3 feature-service items. Metadata lives
 * in the `feature_attachment` table; bytes live in MinIO at
 * `storageKey`. Writes go through presigned PUT to MinIO first, then
 * the client calls `register()` here to record the metadata. This
 * mirrors the thumbnail flow and keeps portal-api off the hot upload
 * path (no buffering 25 MB files through Node).
 */
export interface RegisterAttachmentInput {
  fileName: string;
  mime: string;
  sizeBytes: number;
  /** MinIO object key returned from the presign step. */
  storageKey: string;
  /** Public URL returned from the presign step. */
  storageUrl: string;
}

@Injectable()
export class DataLayerAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  list(itemId: string, layerId: string, featureId: string) {
    return this.prisma.featureAttachment.findMany({
      where: { itemId, layerId, featureId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        fileName: true,
        mime: true,
        sizeBytes: true,
        storageUrl: true,
        createdAt: true,
        createdBy: true,
      },
    });
  }

  async register(
    itemId: string,
    layerId: string,
    featureId: string,
    input: RegisterAttachmentInput,
    userId: string,
  ) {
    if (
      typeof input.storageKey !== 'string' ||
      !input.storageKey.startsWith(ATTACHMENT_KEY_PREFIX)
    ) {
      throw new BadRequestException(
        'storageKey is not an attachment upload',
      );
    }
    return this.prisma.featureAttachment.create({
      data: {
        itemId,
        layerId,
        featureId,
        fileName: input.fileName,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        storageKey: input.storageKey,
        storageUrl: input.storageUrl,
        createdBy: userId,
      },
      select: {
        id: true,
        fileName: true,
        mime: true,
        sizeBytes: true,
        storageUrl: true,
        createdAt: true,
        createdBy: true,
      },
    });
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
