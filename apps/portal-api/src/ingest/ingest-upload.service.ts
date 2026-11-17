// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';

import { LeaderElectionService } from '../cron/leader-election.service.js';
import { StorageService } from '../storage/storage.service.js';
import { serverUploadName } from './ingest-disk-path.js';
import {
  IngestStagingService,
  stagingDiskPath,
} from './ingest-staging.service.js';
import {
  choosePartSize,
  formatSize,
  INGEST_MAX_UPLOAD_BYTES,
  INGEST_UPLOAD_PREFIX,
  MAX_OPEN_UPLOADS_PER_USER,
  declaredSizeOfKey,
  uploadObjectKey,
  partCountFor,
  partLength,
  requiredFreeBytes,
  signUploadHandle,
  UPLOAD_HANDLE_TTL_MS,
  verifyUploadHandle,
  type UploadClaims,
} from './ingest-upload-handle.js';

/** Most part URLs one sign request may ask for. */
export const MAX_SIGN_BATCH = 100;

/** Lifetime of one presigned part URL. The client asks again when one expires. */
const PART_URL_TTL_SECONDS = 60 * 60;

/**
 * A completed upload object is deleted as soon as it is staged. One
 * still in the bucket after this long belongs to a request that died
 * between completing and staging, and the sweep removes it.
 */
const COMPLETED_OBJECT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const HANDLE_KEY_LABEL = 'ingest-upload-handle/v1';

/** User ids are UUIDs. Anything else is refused before it reaches a key. */
const USER_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface StartedUpload {
  handle: string;
  sizeBytes: number;
  partSize: number;
  partCount: number;
  expiresAt: string;
}

function storageErrorName(err: unknown): string {
  return (err as { name?: string; Code?: string } | undefined)?.name ?? '';
}

function isMissingUpload(err: unknown): boolean {
  const name = storageErrorName(err);
  return name === 'NoSuchUpload' || name === 'NotFound' || name === 'NoSuchKey';
}

/**
 * Resumable import uploads (#573). The browser sends the file straight
 * to MinIO as an S3 multipart upload, one presigned PUT per part. That
 * keeps large files off Caddy's request cap, the web app's proxy, and
 * the 5 minute Node request timeout on both servers. A dropped
 * connection or a closed tab loses at most the parts in flight.
 *
 * Nothing is written to the database. The browser holds a handle that
 * this server signs over the user id, object key, upload id, file
 * size, and part size. Every later call checks the signature and the
 * user, so another user cannot sign parts for, finish, or abort an
 * upload they did not start.
 *
 * Abandoned uploads: MinIO removes unfinished multipart uploads by
 * itself after MINIO_API_STALE_UPLOADS_EXPIRY (default 24h, checked
 * every MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL, default 6h). A
 * completed object is deleted right after it is staged, and a cron
 * removes any that a crash left behind.
 */
@Injectable()
export class IngestUploadService {
  private readonly log = new Logger(IngestUploadService.name);
  private readonly handleKey: Buffer;

  constructor(
    private readonly storage: StorageService,
    private readonly staging: IngestStagingService,
    @Optional() private readonly leader?: LeaderElectionService,
  ) {
    this.handleKey = storage.deriveSigningKey(HANDLE_KEY_LABEL);
  }

  /** Free bytes on the staging volume. Test seam. */
  async freeStagingBytes(): Promise<number> {
    const stats = await statfs(stagingDiskPath());
    return stats.bavail * stats.bsize;
  }

  /**
   * Check the name, the size, and free disk, then open a multipart
   * upload. Nothing is created in storage when a check fails.
   */
  async start(
    userId: string,
    fileName: string,
    sizeBytes: number,
  ): Promise<StartedUpload> {
    if (!USER_ID.test(userId)) {
      throw new ForbiddenException('This account cannot start an upload.');
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new BadRequestException('The file is empty.');
    }
    if (sizeBytes > INGEST_MAX_UPLOAD_BYTES) {
      throw new HttpException(
        `The file is too large. The largest import is ${formatSize(INGEST_MAX_UPLOAD_BYTES)}.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    if (serverUploadName(fileName) === 'payload.bin') {
      throw new BadRequestException(
        'This file type cannot be imported. Use a GeoPackage, a zipped shapefile or File Geodatabase, GeoJSON, CSV, KML, or another supported format.',
      );
    }

    // Uploads already started but not finished hold no reservation
    // until they complete, so each new one used to pass the same
    // free-space check. Count them: one user may keep only a few open,
    // and their declared sizes are added to this one's below.
    let openKeys: string[] = [];
    try {
      openKeys = await this.storage.listMultipartUploadsUnder(INGEST_UPLOAD_PREFIX);
    } catch (err) {
      // A store that will not list open uploads still gets the
      // per-upload free-space check below; do not refuse every upload.
      this.log.warn(
        `Could not list open import uploads: ${err instanceof Error ? err.message : err}`,
      );
    }
    const mine = openKeys.filter((k) => k.startsWith(`${INGEST_UPLOAD_PREFIX}${userId}/`));
    if (mine.length >= MAX_OPEN_UPLOADS_PER_USER) {
      throw new HttpException(
        `You already have ${mine.length} uploads in progress. Finish or cancel one, then try again.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const openBytes = openKeys.reduce((sum, k) => sum + declaredSizeOfKey(k), 0);

    let free: number;
    try {
      free = await this.freeStagingBytes();
    } catch {
      throw new HttpException(
        'The server could not check its free disk space, so it did not accept the file.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const needed = requiredFreeBytes(sizeBytes + openBytes);
    if (!Number.isFinite(free) || free < needed) {
      throw new HttpException(
        `Not enough free disk space on the server for this file. ${formatSize(
          Math.max(0, free),
        )} is free and ${formatSize(
          needed,
        )} is needed (twice the file size${
          openBytes > 0 ? ' and the uploads already in progress' : ''
        }, plus room to unpack it). Free some space and try again.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const partSize = choosePartSize(sizeBytes);
    const partCount = partCountFor(sizeBytes, partSize);
    const key = uploadObjectKey(userId, sizeBytes, randomUUID());
    const uploadId = await this.storage.createMultipartUpload(key);
    const exp = Date.now() + UPLOAD_HANDLE_TTL_MS;
    const claims: UploadClaims = {
      uid: userId,
      key,
      upl: uploadId,
      size: sizeBytes,
      part: partSize,
      name: fileName,
      exp,
    };
    this.log.log(
      `Started import upload ${key} (${sizeBytes} B, ${partCount} parts of ${partSize} B)`,
    );
    return {
      handle: signUploadHandle(claims, this.handleKey),
      sizeBytes,
      partSize,
      partCount,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  /**
   * Claims of a handle the caller started. A bad or expired handle is
   * a 400. Someone else's handle is a 403.
   */
  claimsFor(userId: string, handle: unknown): UploadClaims {
    const claims = verifyUploadHandle(handle, this.handleKey);
    if (!claims) {
      throw new BadRequestException(
        'This upload is no longer valid. Start the upload again.',
      );
    }
    if (claims.uid !== userId || !claims.key.startsWith(`${INGEST_UPLOAD_PREFIX}${userId}/`)) {
      throw new ForbiddenException('This upload was started by another user.');
    }
    return claims;
  }

  /** Presigned PUT URLs for the requested part numbers. */
  async signParts(
    userId: string,
    handle: unknown,
    partNumbers: number[],
  ): Promise<{ parts: Array<{ partNumber: number; url: string }> }> {
    const claims = this.claimsFor(userId, handle);
    if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
      throw new BadRequestException('Ask for at least one part.');
    }
    if (partNumbers.length > MAX_SIGN_BATCH) {
      throw new BadRequestException(`Ask for at most ${MAX_SIGN_BATCH} parts at a time.`);
    }
    const count = partCountFor(claims.size, claims.part);
    const unique = [...new Set(partNumbers)];
    for (const n of unique) {
      if (!Number.isInteger(n) || n < 1 || n > count) {
        throw new BadRequestException(`Part ${String(n)} is not part of this upload.`);
      }
    }
    const parts = await Promise.all(
      unique.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.presignUploadPart(
          claims.key,
          claims.upl,
          partNumber,
          partLength(claims.size, claims.part, partNumber),
          PART_URL_TTL_SECONDS,
        ),
      })),
    );
    return { parts };
  }

  /**
   * Parts already stored, for resume. A part whose size does not match
   * its slot is left out so the client sends it again.
   */
  async status(
    userId: string,
    handle: unknown,
  ): Promise<{
    sizeBytes: number;
    partSize: number;
    partCount: number;
    uploadedParts: Array<{ partNumber: number; size: number }>;
  }> {
    const claims = this.claimsFor(userId, handle);
    const stored = await this.listParts(claims);
    return {
      sizeBytes: claims.size,
      partSize: claims.part,
      partCount: partCountFor(claims.size, claims.part),
      uploadedParts: stored.map((p) => ({ partNumber: p.partNumber, size: p.size })),
    };
  }

  private async listParts(
    claims: UploadClaims,
  ): Promise<Array<{ partNumber: number; etag: string; size: number }>> {
    let stored: Array<{ partNumber: number; etag: string; size: number }>;
    try {
      stored = await this.storage.listUploadedParts(claims.key, claims.upl);
    } catch (err) {
      if (isMissingUpload(err)) {
        throw new NotFoundException(
          'This upload no longer exists. It may have expired. Start the upload again.',
        );
      }
      throw err;
    }
    return stored.filter(
      (p) => p.size === partLength(claims.size, claims.part, p.partNumber),
    );
  }

  /**
   * Finish the multipart upload, copy the object into a fresh staging
   * directory, and delete the object. The object is deleted on every
   * exit, so a failure here never leaves a full copy in the bucket.
   * The caller holds the ingest slot and has checked disk room.
   */
  async completeToStaging(claims: UploadClaims): Promise<{
    stagingId: string;
    filePath: string;
    originalName: string;
    sizeBytes: number;
  }> {
    const parts = await this.listParts(claims);
    const count = partCountFor(claims.size, claims.part);
    const have = new Set(parts.map((p) => p.partNumber));
    let missing = 0;
    for (let n = 1; n <= count; n += 1) if (!have.has(n)) missing += 1;
    if (missing > 0) {
      throw new ConflictException(
        `The upload is not finished. ${missing} of ${count} parts are still missing.`,
      );
    }
    try {
      await this.storage.completeMultipartUpload(
        claims.key,
        claims.upl,
        parts.filter((p) => p.partNumber <= count),
      );
    } catch (err) {
      if (isMissingUpload(err)) {
        throw new NotFoundException(
          'This upload no longer exists. It may have expired. Start the upload again.',
        );
      }
      throw err;
    }
    try {
      const object = await this.storage.streamObject(claims.key);
      const staged = await this.staging.stageStream({
        stream: object.body,
        originalName: claims.name,
        ownerId: claims.uid,
        storedName: serverUploadName(claims.name),
      });
      if (staged.sizeBytes !== claims.size) {
        await this.staging.dropStaging(staged.stagingId).catch(() => {});
        throw new ConflictException(
          'The uploaded file does not match the size declared when the upload started.',
        );
      }
      return staged;
    } finally {
      await this.storage.deleteObject(claims.key);
    }
  }

  /** Stop the upload and remove whatever was stored for it. */
  async abort(userId: string, handle: unknown): Promise<{ aborted: true }> {
    const claims = this.claimsFor(userId, handle);
    await this.storage.abortMultipartUpload(claims.key, claims.upl);
    await this.storage.deleteObject(claims.key);
    return { aborted: true };
  }

  /**
   * Remove completed upload objects that were never staged. MinIO
   * handles unfinished multipart uploads on its own (see above).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepLeftoverObjects(): Promise<void> {
    if (this.leader && !this.leader.shouldRun()) return;
    await this.sweepLeftoverObjectsNow();
  }

  async sweepLeftoverObjectsNow(now = Date.now()): Promise<number> {
    let removed = 0;
    try {
      const objects = await this.storage.listObjectsUnder(INGEST_UPLOAD_PREFIX);
      for (const obj of objects) {
        // Unknown age counts as fresh.
        const age = obj.lastModified ? now - obj.lastModified.getTime() : 0;
        if (age < COMPLETED_OBJECT_MAX_AGE_MS) continue;
        if (await this.storage.deleteObject(obj.key)) removed += 1;
      }
    } catch (err) {
      this.log.warn(
        `Import upload sweep skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (removed > 0) this.log.log(`Removed ${removed} leftover import upload object(s)`);
    return removed;
  }
}
