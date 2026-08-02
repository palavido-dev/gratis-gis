// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  GetObjectCommand,
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
  | 'feature-attachment'
  // #296: arbitrary file uploaded as the body of a `file` item (PDF,
  // CSV, image, zipped shapefile, etc.). Same any-MIME treatment as
  // feature-attachment; size cap bumped to fit larger documents.
  | 'item-file'
  // #179: PMTiles tile-cache upload for the tile_layer item. Larger
  // size cap (several GB possible) because regional raster basemap
  // caches legitimately get big; range-request friendly so we serve
  // through MinIO without holding the whole file in memory.
  | 'item-tile-layer'
  // #179: COPC point cloud upload for the point_cloud item.
  // Multi-GB uploads are normal for lidar tiles; range-request
  // friendly like item-tile-layer, served through the API proxy
  // with the item's read ACL.
  | 'item-point-cloud'
  // #73: user-uploaded SVG marker glyphs for the map point-symbol
  // picker. Each upload is a sanitized SVG body served from a
  // public bucket key so the renderer can resolve
  // `upload:<key>` icon references without proxying through the
  // api. Small (low-KB) so no streaming required.
  | 'map-icon';

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

/** File items wrap one arbitrary upload that's the whole point of
 *  the item -- a CSV deliverable, a PDF report, a zipped shapefile.
 *  Accepts any MIME, larger ceiling than feature attachments because
 *  these stand alone rather than ride along on a feature row. Still
 *  bounded so a runaway upload can't fill the bucket. */
const FILE_ITEM_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

/** Tile-cache files for the tile_layer item type (#179). PMTiles
 *  caches for regional / statewide imagery legitimately reach several
 *  gigabytes (a WV-statewide 30cm orthophoto cache at z18 is ~5 GB).
 *  We accept up to 8 GB so a typical state-scale cache fits with
 *  headroom; operators can bump this server-side if they ingest
 *  larger sets. */
const TILE_LAYER_MAX_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB

/** COPC point clouds (#179). A single USGS 3DEP delivery tile runs
 *  hundreds of MB to a few GB compressed; county-scale merges go
 *  higher. Same 8 GB ceiling as tile caches: big enough for real
 *  lidar, still a bound. */
const POINT_CLOUD_MAX_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB

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
  private readonly s3Endpoint: string;
  private readonly s3AccessKeyId: string;
  private readonly s3SecretAccessKey: string;

  /**
   * #211: connection material for GDAL's /vsis3/ virtual filesystem,
   * so the elevation-mosaic composer can range-read COGs straight
   * from MinIO (same credentials this SDK client uses) instead of
   * downloading whole files. Stays inside the process; never
   * serialize this into a response.
   */
  vsis3Config(): {
    bucket: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
  } {
    return {
      bucket: this.bucket,
      endpoint: this.s3Endpoint,
      accessKeyId: this.s3AccessKeyId,
      secretAccessKey: this.s3SecretAccessKey,
    };
  }

  constructor(private readonly cfg: ConfigService) {
    const endpoint = cfg.get<string>('MINIO_ENDPOINT', 'http://localhost:9000');
    const accessKeyId = cfg.get<string>('MINIO_ACCESS_KEY', 'gratisgis');
    const secretAccessKey = cfg.get<string>('MINIO_SECRET_KEY', 'devpassword');
    this.bucket = cfg.get<string>('MINIO_BUCKET', 'gratisgis');
    this.s3Endpoint = endpoint;
    this.s3AccessKeyId = accessKeyId;
    this.s3SecretAccessKey = secretAccessKey;

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
      // AWS SDK v3 turns on default integrity protections that send
      // x-amz-sdk-checksum-algorithm + x-amz-content-sha256 headers
      // even on operations like HeadBucket. Older / non-AWS S3
      // implementations (including some MinIO releases) reject the
      // header with "A header you provided implies functionality that
      // is not implemented." Opting out via WHEN_REQUIRED keeps the
      // checksum on real PUT-data calls (where MinIO supports it) and
      // skips it on the metadata operations where MinIO chokes.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
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

    // Anonymous GET only on the prefixes that are public by design:
    // thumbnails + avatars + hero images.  Private prefixes
    // (feature-attachment, item-file, item-tile-layer) are NOT
    // listed and therefore require AWS-signed reads via the SDK.
    // Portal-api mediates those via /api/storage/private/* with a
    // SharingService check.  Tile-layer range requests go through
    // /api/portal/tile-layer/:id/file which also uses the SDK.
    await this.client.send(
      new PutBucketPolicyCommand({
        Bucket: this.bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'PublicReadGetObjectOnPublicPrefixes',
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [
                `arn:aws:s3:::${this.bucket}/item-thumb/*`,
                `arn:aws:s3:::${this.bucket}/group-thumb/*`,
                `arn:aws:s3:::${this.bucket}/user-avatar/*`,
                `arn:aws:s3:::${this.bucket}/org-hero/*`,
              ],
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
    // Thumbnails/avatars stay image-only. Feature attachments + file
    // items accept any MIME type because they legitimately include
    // PDFs, audio, CAD exports, zipped shapefiles -- whatever the
    // field team or author captures. The caller's kind choice
    // determines which rule applies.
    const isAttachment = kind === 'feature-attachment';
    const isFileItem = kind === 'item-file';
    const isTileLayer = kind === 'item-tile-layer';
    const isPointCloud = kind === 'item-point-cloud';
    const anyMime = isAttachment || isFileItem || isTileLayer || isPointCloud;
    if (!anyMime && !ALLOWED_CONTENT_TYPES.has(contentType)) {
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
    // Presigned-PUT expiry: tight by default so a leaked URL is
    // short-lived.  60s suffices for a 5 MB thumbnail; 180s for
    // attachments / file items so a 100 MB upload over a slow
    // office link still completes; tile-layer caches legitimately
    // run multi-GB on slow uplinks, so they get the longer 600s
    // window.
    const expiresIn = isTileLayer || isPointCloud ? 600 : anyMime ? 180 : 60;
    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn });
    // Private-kind objects are served back through the api with a
    // sharing check (the bucket policy no longer permits anonymous
    // GET on those prefixes).  Public-kind objects (thumbnails,
    // avatars, hero) keep their direct MinIO URL so the browser
    // doesn't pay an auth round-trip on every render.
    const publicUrl = StorageService.isPrivateKind(kind)
      ? this.apiUrlFor(kind, key)
      : `${this.publicBase.replace(/\/$/, '')}/${this.bucket}/${key}`;
    return {
      uploadUrl,
      publicUrl,
      key,
      contentType,
      maxBytes: isTileLayer
        ? TILE_LAYER_MAX_BYTES
        : isPointCloud
          ? POINT_CLOUD_MAX_BYTES
          : isFileItem
          ? FILE_ITEM_MAX_BYTES
          : isAttachment
            ? ATTACHMENT_MAX_BYTES
            : MAX_UPLOAD_BYTES,
    };
  }

  /**
   * Upload a local file (path on the api container's filesystem)
   * directly to MinIO as a given asset kind (#179). Used by the
   * tile-layer conversion pipeline: it produces a converted
   * .pmtiles in a temp dir, then asks us to put it in object
   * storage. Streams the file rather than buffering, so multi-GB
   * tile caches don't blow up the api's heap.
   *
   * Returns the storage key + public URL the same way
   * presignUpload would, so the caller can persist them on the
   * tile_layer item.
   */
  /**
   * In-memory variant of `uploadLocalFile` (#73). Used by the
   * map-icon upload path: the sanitizer parses + rewrites the
   * SVG to a buffer before it ever touches disk, so we push the
   * buffer to MinIO directly without a tmp-file round trip.
   * Returns the same `{ key, publicUrl }` shape so callers can
   * persist them on whatever item / row they belong to.
   */
  async uploadBuffer(
    kind: AssetKind,
    body: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<{ key: string; publicUrl: string }> {
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
      ContentLength: body.length,
      Body: body,
    });
    await this.client.send(cmd);
    const publicUrl = StorageService.isPrivateKind(kind)
      ? this.apiUrlFor(kind, key)
      : `${this.publicBase.replace(/\/$/, '')}/${this.bucket}/${key}`;
    return { key, publicUrl };
  }

  async uploadLocalFile(
    kind: AssetKind,
    localPath: string,
    contentType = 'application/octet-stream',
  ): Promise<{ key: string; publicUrl: string }> {
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
    const { createReadStream, statSync } = await import('node:fs');
    const stats = statSync(localPath);
    const key = `${kind}/${randomUUID()}`;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: stats.size,
      Body: createReadStream(localPath),
    });
    await this.client.send(cmd);
    const publicUrl = StorageService.isPrivateKind(kind)
      ? this.apiUrlFor(kind, key)
      : `${this.publicBase.replace(/\/$/, '')}/${this.bucket}/${key}`;
    return { key, publicUrl };
  }

  /**
   * Compose the api-side URL that wraps a private-kind storage
   * object.  The browser sends this URL through the portal-web BFF
   * (which injects the Keycloak access token from the session
   * cookie) and the BFF forwards to portal-api's
   * `/api/storage/private/<kind>/<key>` route.  Portal-api validates
   * sharing then streams the bytes via the SDK.
   *
   * The `/api/portal/<suffix>` shape is the BFF passthrough
   * (apps/portal-web/src/app/api/portal/[...path]/route.ts);
   * suffix routes 1:1 to portal-api's `/api/<suffix>` after the
   * BFF strips the `portal/` segment.
   *
   * Returned as a relative path because the portal hostname
   * differs across local dev, staging, and prod.  The browser
   * resolves it against the current origin.
   */
  private apiUrlFor(kind: AssetKind, key: string): string {
    // Strip the kind prefix off the key for the api-side URL since
    // the route segment already implies it.  E.g.
    // `feature-attachment/abc...` -> `/api/portal/storage/private/feature-attachment/abc...`.
    const bareKey = key.startsWith(`${kind}/`) ? key.slice(kind.length + 1) : key;
    return `/api/portal/storage/private/${kind}/${bareKey}`;
  }

  /**
   * Asset kinds whose objects are NOT publicly readable from the
   * bucket policy.  Callers must go through the api with a sharing
   * check.  The corresponding public prefixes (`item-thumb`,
   * `group-thumb`, `user-avatar`, `org-hero`) keep their direct
   * MinIO URLs and are fetched without an auth round-trip.
   */
  static readonly PRIVATE_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>([
    'feature-attachment',
    'item-file',
    'item-tile-layer',
    'item-point-cloud',
  ]);

  /**
   * True if the given asset kind requires a sharing check before
   * read.  Callers in the upload path use this to decide whether
   * to mint an API-mediated publicUrl or a direct MinIO URL.
   */
  static isPrivateKind(kind: AssetKind): boolean {
    return StorageService.PRIVATE_KINDS.has(kind);
  }

  /**
   * Stream an object back to the caller with optional Range header
   * forwarding.  Uses the SDK + service credentials, so this keeps
   * working after the bucket policy is tightened to deny anonymous
   * GET on private prefixes.
   *
   * Returns the upstream response shape (status, headers, body).
   * Caller is responsible for piping the body to the HTTP response
   * and selecting which response headers to forward.
   */
  async streamObject(
    key: string,
    range?: string,
  ): Promise<{
    statusCode: number;
    contentType: string | undefined;
    contentLength: number | undefined;
    contentRange: string | undefined;
    etag: string | undefined;
    acceptRanges: string | undefined;
    body: NodeJS.ReadableStream;
  }> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(range ? { Range: range } : {}),
    });
    const res = await this.client.send(cmd);
    // The SDK returns the body as a Node Readable when running on
    // Node; cast accordingly.
    const body = res.Body as NodeJS.ReadableStream;
    return {
      // SDK returns 200 for full responses, 206 for ranged.  We
      // mirror that via the http status from the underlying http
      // metadata.
      statusCode: (res.$metadata.httpStatusCode ?? 200) as number,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
      contentRange: res.ContentRange,
      etag: res.ETag,
      acceptRanges: res.AcceptRanges,
      body,
    };
  }

  /**
   * Stream an object to a local file path. Used by the tile-layer
   * conversion pipeline so the conversion doesn't have to fetch a
   * user-supplied URL (which would be an SSRF surface). The caller
   * provides the storage key; we read via the S3 client and pipe
   * the body to disk.
   *
   * Errors propagate. Caller owns the destination file lifecycle.
   */
  async streamObjectToDisk(key: string, destPath: string): Promise<void> {
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const obj = await this.streamObject(key);
    await pipeline(obj.body, createWriteStream(destPath));
  }

  /** True when an object exists under the key. Head request only. */
  async objectExists(key: string): Promise<boolean> {
    try {
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Delete an object by key. Idempotent. Used when a feature
   *  attachment row is removed so we don't leak bytes in MinIO.
   *  Returns whether the delete call succeeded so callers that
   *  report counts (the housekeeping orphan sweep) can be honest
   *  about partial failures; existing callers ignore the value. */
  async deleteObject(key: string): Promise<boolean> {
    try {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      // Non-fatal: log, don't throw. A stuck metadata row is worse
      // than a leaked 25 MB object.
      this.log.warn(
        `Failed to delete ${key}: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  /**
   * List every object under a key prefix (paginated walk, same
   * mechanics as getBucketUsage). Powers the housekeeping orphaned-
   * upload sweep, which needs key + size + age for each object so
   * it can cross-check against the referencing rows. Throws on
   * enumeration failure rather than returning a partial list: the
   * sweep must never mistake "listing died halfway" for "these are
   * all the objects" (the caller treats a throw as "storage
   * unavailable" and reports that instead of guessing).
   */
  async listObjectsUnder(prefix: string): Promise<
    Array<{ key: string; sizeBytes: number; lastModified: Date | null }>
  > {
    const out: Array<{
      key: string;
      sizeBytes: number;
      lastModified: Date | null;
    }> = [];
    let continuationToken: string | undefined;
    do {
      const cmd = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ...(continuationToken
          ? { ContinuationToken: continuationToken }
          : {}),
      });
      const res = await this.client.send(cmd);
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        out.push({
          key: obj.Key,
          sizeBytes: obj.Size ?? 0,
          lastModified: obj.LastModified ?? null,
        });
      }
      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return out;
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
