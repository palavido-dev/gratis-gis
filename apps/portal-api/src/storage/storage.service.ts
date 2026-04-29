import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Kinds of content we host. Each gets its own path prefix inside the
 * bucket so retention rules and browsing stay simple. Keep additions
 * aligned with the Prisma models that actually reference storage.
 */
export type AssetKind =
  | 'item-thumb'
  | 'group-thumb'
  | 'user-avatar'
  | 'org-hero'
  | 'feature-attachment';

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** Feature attachments are any MIME (images, PDFs, office docs, etc.)
 *  up to a higher cap. The picker on the client side is what decides
 *  how to render them; the service just stores bytes. */
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB; thumbnails should be small.

export interface PresignResult {
  /** URL the browser PUTs the bytes to. Expires in 60 seconds. */
  uploadUrl: string;
  /** Public URL we save on the entity after the upload completes. */
  publicUrl: string;
  /** Object key inside the bucket; handy for debugging and tests. */
  key: string;
  /** The MIME type the client committed to; the PUT must match. */
  contentType: string;
  /** Matches MAX_UPLOAD_BYTES, echoed so the client can pre-validate. */
  maxBytes: number;
}

/**
 * Wraps the MinIO client. Responsibilities:
 *   - Make sure the target bucket exists + has anonymous-read + browser CORS.
 *   - Mint short-lived presigned PUT URLs the browser uses for direct upload.
 *   - Construct the stable public URL we persist on the owning entity.
 *
 * The bucket policy is deliberately public-read because thumbnails are,
 * by nature, shown to anyone who can see the entity. Sensitive payloads
 * (feature data, form submissions) will live in separate buckets with
 * per-request signed reads; we do NOT co-mingle them here.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string;

  constructor(private readonly cfg: ConfigService) {
    const endpoint = cfg.get<string>('MINIO_ENDPOINT', 'http://localhost:9000');
    const accessKeyId = cfg.get<string>('MINIO_ACCESS_KEY', 'gratisgis');
    const secretAccessKey = cfg.get<string>('MINIO_SECRET_KEY', 'devpassword');
    this.bucket = cfg.get<string>('MINIO_BUCKET', 'gratisgis');

    // Browsers hit MinIO directly for both upload (presigned PUT) and
    // read (public bucket), so the public base URL has to be something
    // the browser can reach. In dev that's the same localhost endpoint;
    // in prod this should be a CDN / reverse-proxied hostname.
    this.publicBase = cfg.get<string>('MINIO_PUBLIC_BASE', endpoint);

    this.client = new S3Client({
      endpoint,
      region: 'us-east-1', // MinIO ignores this but the SDK requires a value.
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true, // MinIO only supports path-style addressing.
    });
  }

  /**
   * Tracks whether bucket provisioning has completed so that the first
   * presign attempt can reattempt it lazily. The API must not refuse to
   * start just because MinIO happened to be slow coming up in docker.
   */
  private bootstrapped = false;

  async onModuleInit() {
    // Fire-and-forget: if MinIO isn't reachable at boot (common during
    // docker compose up while containers are still starting), log the
    // reason and keep running. The first upload attempt will retry.
    try {
      await this.ensureBucket();
      this.bootstrapped = true;
    } catch (err) {
      this.log.warn(
        `Storage bootstrap deferred: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Idempotent: creates the bucket if missing and sets the policies we
   * depend on (anonymous read, browser CORS).
   */
  private async ensureBucket() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      // Only treat "bucket not found" as a signal to create. Any other
      // error (e.g. connection refused) should propagate so the caller
      // can decide whether to retry or warn.
      const name = (err as { name?: string } | undefined)?.name ?? '';
      if (name === 'NotFound' || name === 'NoSuchBucket') {
        this.log.log(`Creating MinIO bucket "${this.bucket}"`);
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } else {
        throw err;
      }
    }

    // Anonymous GET on every object. Thumbnails are public by design.
    await this.client.send(
      new PutBucketPolicyCommand({
        Bucket: this.bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'PublicReadGetObject',
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${this.bucket}/*`],
            },
          ],
        }),
      }),
    );

    // Allow cross-origin PUTs from the portal-web dev server and the
    // configured web origin so the browser can talk directly to MinIO.
    const allowedOrigins = this.cfg
      .get<string>('STORAGE_ALLOWED_ORIGINS', 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedHeaders: ['*'],
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedOrigins: allowedOrigins,
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  }

  /**
   * Mint a short-lived presigned PUT for the browser, plus the public
   * URL we'll persist on the entity once upload succeeds.
   */
  async presignUpload(kind: AssetKind, contentType: string): Promise<PresignResult> {
    // Thumbnails/avatars stay image-only. Feature attachments accept
    // any MIME type because they legitimately include PDFs, audio,
    // CAD exports, whatever the field team captures. The caller's
    // kind choice determines which rule applies.
    const isAttachment = kind === 'feature-attachment';
    if (!isAttachment && !ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }
    // Lazy retry: if bootstrap was deferred because MinIO wasn't up at
    // boot, try again before minting a URL so the first upload after a
    // docker restart self-heals instead of failing.
    if (!this.bootstrapped) {
      try {
        await this.ensureBucket();
        this.bootstrapped = true;
      } catch (err) {
        this.log.warn(
          `Storage still not ready: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    const key = `${kind}/${randomUUID()}`;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    // Tight expiry: 60s is enough for a 5 MB thumbnail and short enough
    // that a leaked URL is effectively harmless. Attachments bump to
    // 300s because 25 MB over slow mobile links takes longer.
    const expiresIn = isAttachment ? 300 : 60;
    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn });
    const publicUrl = `${this.publicBase.replace(/\/$/, '')}/${this.bucket}/${key}`;
    return {
      uploadUrl,
      publicUrl,
      key,
      contentType,
      maxBytes: isAttachment ? ATTACHMENT_MAX_BYTES : MAX_UPLOAD_BYTES,
    };
  }

  /** Delete an object by key. Idempotent. Used when a feature
   *  attachment row is removed so we don't leak bytes in MinIO. */
  async deleteObject(key: string): Promise<void> {
    try {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      // Non-fatal: log, don't throw. A stuck metadata row is worse
      // than a leaked 25 MB object.
      this.log.warn(
        `Failed to delete ${key}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Exposed for DTO tests and error messages. */
  get allowedContentTypes(): ReadonlySet<string> {
    return ALLOWED_CONTENT_TYPES;
  }

  /**
   * The bucket name we're configured to use. The Housekeeping page
   * shows it next to the usage readout so the operator can spot a
   * misconfigured deployment (e.g., still pointing at a leftover
   * dev bucket) at a glance.
   */
  get bucketName(): string {
    return this.bucket;
  }

  /**
   * Walk every object in the bucket and total count + bytes.
   *
   * Used by the Housekeeping admin page (#161) to surface MinIO
   * usage. ListObjectsV2 returns up to 1000 keys per page; we paginate
   * via ContinuationToken until done. For a deployment with many
   * thousands of objects this is O(N), so the controller calls it
   * lazily (only when the admin opens the Storage card) rather than
   * on every page render.
   *
   * Returns null if the bucket can't be enumerated (MinIO down at
   * boot, credentials wrong, etc.) so the UI can surface that
   * gracefully without a 500.
   */
  async getBucketUsage(): Promise<{
    objectCount: number;
    totalBytes: number;
  } | null> {
    let objectCount = 0;
    let totalBytes = 0;
    let continuationToken: string | undefined;
    try {
      do {
        const cmd = new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(continuationToken
            ? { ContinuationToken: continuationToken }
            : {}),
        });
        const res = await this.client.send(cmd);
        for (const obj of res.Contents ?? []) {
          objectCount += 1;
          totalBytes += obj.Size ?? 0;
        }
        continuationToken = res.IsTruncated
          ? res.NextContinuationToken
          : undefined;
      } while (continuationToken);
      return { objectCount, totalBytes };
    } catch (err) {
      this.log.warn(
        `Bucket usage query failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}
