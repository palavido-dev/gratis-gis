// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

import type { OffsiteSettings } from './offsite-config.js';

/**
 * The S3 calls the off-site copy makes, kept small so tests can hand
 * in a fake with the same `send`.
 */
export interface S3Like {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

/** 16 MiB parts: 160 GB before the 10,000 part limit, raised past that. */
export const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
const MIN_PART_SIZE = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;

export function createOffsiteClient(s: OffsiteSettings): S3Client {
  return new S3Client({
    region: s.region,
    ...(s.endpoint ? { endpoint: s.endpoint } : {}),
    forcePathStyle: s.pathStyle,
    credentials: {
      accessKeyId: s.accessKeyId ?? '',
      secretAccessKey: s.secretAccessKey ?? '',
    },
    // Several S3-compatible stores refuse the newer default checksum
    // headers. Integrity is checked here instead: Content-MD5 on every
    // part, which the store verifies, and the ETags it returns.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 4,
  });
}

/** Part size for an upload of about `bytes`, inside the part limit. */
export function partSizeFor(bytes: number | null, base = DEFAULT_PART_SIZE): number {
  if (bytes === null || bytes <= 0) return Math.max(base, MIN_PART_SIZE);
  const needed = Math.ceil(bytes / (MAX_PARTS - 100));
  const size = Math.max(base, MIN_PART_SIZE, needed);
  // Round up to a whole MiB.
  return Math.ceil(size / (1024 * 1024)) * 1024 * 1024;
}

export interface UploadResult {
  bytes: number;
  sha256: string;
  parts: number;
}

const MD5_ETAG = /^"?([0-9a-f]{32})"?$/i;
const MULTIPART_ETAG = /^"?([0-9a-f]{32})-(\d+)"?$/i;

export class OffsiteVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffsiteVerifyError';
  }
}

/**
 * Stream bytes to one object with a multipart upload.
 *
 * Memory is one part. Each part carries Content-MD5, so the store
 * refuses a part that arrived damaged, and a returned part ETag that
 * is a plain MD5 is compared as well. After completing, the object's
 * size is read back and compared with what was sent, and the combined
 * ETag is checked when the store uses the usual MD5-of-MD5s form.
 * Any failure aborts the upload so no half object is left behind.
 */
export async function uploadStream(
  s3: S3Like,
  args: {
    bucket: string;
    key: string;
    body: AsyncIterable<Buffer>;
    expectedBytes?: number | null;
    partSize?: number;
    contentType?: string;
    metadata?: Record<string, string>;
    signal?: AbortSignal;
    onPart?: (bytesSoFar: number) => void | Promise<void>;
  },
): Promise<UploadResult> {
  const partSize = args.partSize ?? partSizeFor(args.expectedBytes ?? null);
  const opts = args.signal ? { abortSignal: args.signal } : undefined;

  // Read up to one part first. A body that ends inside it goes up as
  // one PUT with Content-MD5: one request instead of four, which is
  // what keeps mirror mode usable with many small files.
  const iter = args.body[Symbol.asyncIterator]();
  const first: Buffer[] = [];
  let firstLen = 0;
  let ended = false;
  while (firstLen < partSize) {
    const next = await iter.next();
    if (next.done) {
      ended = true;
      break;
    }
    first.push(next.value);
    firstLen += next.value.length;
  }
  if (ended) {
    const data = Buffer.concat(first, firstLen);
    const md5 = createHash('md5').update(data).digest();
    const res = (await s3.send(
      new PutObjectCommand({
        Bucket: args.bucket,
        Key: args.key,
        Body: data,
        ContentLength: data.length,
        ContentMD5: md5.toString('base64'),
        ContentType: args.contentType ?? 'application/octet-stream',
        ...(args.metadata ? { Metadata: args.metadata } : {}),
      }),
      opts,
    )) as { ETag?: string };
    const plain = res.ETag ? MD5_ETAG.exec(res.ETag) : null;
    if (plain && plain[1]!.toLowerCase() !== md5.toString('hex')) {
      throw new OffsiteVerifyError('The stored file has a different checksum than the one sent.');
    }
    await verifyStored(s3, args, data.length, opts);
    await args.onPart?.(data.length);
    return {
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      parts: 1,
    };
  }
  async function* rest(): AsyncGenerator<Buffer> {
    yield* first;
    for (;;) {
      const next = await iter.next();
      if (next.done) return;
      yield next.value;
    }
  }
  const created = (await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: args.bucket,
      Key: args.key,
      ContentType: args.contentType ?? 'application/octet-stream',
      ...(args.metadata ? { Metadata: args.metadata } : {}),
    }),
    opts,
  )) as { UploadId?: string };
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error('The storage provider did not start the upload.');

  const sha = createHash('sha256');
  const partMd5s: Buffer[] = [];
  const completed: Array<{ ETag: string; PartNumber: number }> = [];
  let total = 0;
  let pending: Buffer[] = [];
  let pendingLen = 0;

  const sendPart = async (data: Buffer) => {
    const number = completed.length + 1;
    if (number > MAX_PARTS) throw new Error('The backup is too large for one upload.');
    const md5 = createHash('md5').update(data).digest();
    const res = (await s3.send(
      new UploadPartCommand({
        Bucket: args.bucket,
        Key: args.key,
        UploadId: uploadId,
        PartNumber: number,
        Body: data,
        ContentLength: data.length,
        ContentMD5: md5.toString('base64'),
      }),
      opts,
    )) as { ETag?: string };
    if (!res.ETag) throw new OffsiteVerifyError(`Part ${number} was not acknowledged.`);
    const plain = MD5_ETAG.exec(res.ETag);
    if (plain && plain[1]!.toLowerCase() !== md5.toString('hex')) {
      throw new OffsiteVerifyError(
        `Part ${number} arrived with a different checksum than it was sent with.`,
      );
    }
    partMd5s.push(md5);
    completed.push({ ETag: res.ETag, PartNumber: number });
    total += data.length;
    await args.onPart?.(total);
  };

  try {
    for await (const piece of rest()) {
      sha.update(piece);
      pending.push(piece);
      pendingLen += piece.length;
      while (pendingLen >= partSize) {
        const all = Buffer.concat(pending, pendingLen);
        await sendPart(all.subarray(0, partSize));
        const rest = all.subarray(partSize);
        pending = rest.length ? [rest] : [];
        pendingLen = rest.length;
      }
    }
    // A last part, or the only one; an empty file still needs one.
    if (pendingLen > 0 || completed.length === 0) {
      await sendPart(Buffer.concat(pending, pendingLen));
    }
    const done = (await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: args.bucket,
        Key: args.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completed },
      }),
      opts,
    )) as { ETag?: string };
    const multi = done.ETag ? MULTIPART_ETAG.exec(done.ETag) : null;
    if (multi) {
      const expect = createHash('md5').update(Buffer.concat(partMd5s)).digest('hex');
      if (multi[1]!.toLowerCase() !== expect || Number(multi[2]) !== completed.length) {
        throw new OffsiteVerifyError('The stored file has a different checksum than the one sent.');
      }
    }
  } catch (err) {
    await s3
      .send(
        new AbortMultipartUploadCommand({ Bucket: args.bucket, Key: args.key, UploadId: uploadId }),
      )
      .catch(() => undefined);
    throw err;
  }

  await verifyStored(s3, args, total, opts);
  return { bytes: total, sha256: sha.digest('hex'), parts: completed.length };
}

/** Read the stored size back and compare it with what was sent. */
async function verifyStored(
  s3: S3Like,
  args: { bucket: string; key: string; expectedBytes?: number | null | undefined },
  total: number,
  opts: { abortSignal: AbortSignal } | undefined,
): Promise<void> {
  const head = (await s3.send(
    new HeadObjectCommand({ Bucket: args.bucket, Key: args.key }),
    opts,
  )) as {
    ContentLength?: number;
  };
  if (Number(head.ContentLength) !== total) {
    throw new OffsiteVerifyError(
      `The stored file is ${head.ContentLength ?? 'of unknown'} bytes; ${total} were sent.`,
    );
  }
  if (
    args.expectedBytes !== undefined &&
    args.expectedBytes !== null &&
    args.expectedBytes !== total
  ) {
    throw new OffsiteVerifyError(`Sent ${total} bytes; expected ${args.expectedBytes}.`);
  }
}

/** One small object, with Content-MD5. For sidecars and markers. */
export async function putSmall(
  s3: S3Like,
  bucket: string,
  key: string,
  body: Buffer,
  contentType = 'application/json',
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: contentType,
      ContentMD5: createHash('md5').update(body).digest('base64'),
    }),
  );
}

export interface ListedObject {
  key: string;
  size: number;
  lastModified: Date | null;
  etag: string | null;
}

export async function* listObjects(
  s3: S3Like,
  bucket: string,
  prefix: string,
): AsyncGenerator<ListedObject> {
  let token: string | undefined;
  do {
    const page = (await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    )) as {
      Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date; ETag?: string }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    };
    for (const o of page.Contents ?? []) {
      if (!o.Key) continue;
      yield {
        key: o.Key,
        size: Number(o.Size ?? 0),
        lastModified: o.LastModified ?? null,
        etag: o.ETag ?? null,
      };
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

export async function deleteObject(s3: S3Like, bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** The body of one object as a byte stream. */
export async function getObjectStream(
  s3: S3Like,
  bucket: string,
  key: string,
  signal?: AbortSignal,
): Promise<AsyncIterable<Buffer>> {
  const res = (await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    signal ? { abortSignal: signal } : undefined,
  )) as { Body?: unknown };
  if (!res.Body) throw new Error(`The object ${key} has no body.`);
  return res.Body as AsyncIterable<Buffer>;
}

export async function getSmall(s3: S3Like, bucket: string, key: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of await getObjectStream(s3, bucket, key)) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    n += b.length;
    if (n > 1024 * 1024) throw new Error(`The object ${key} is larger than expected.`);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/**
 * A plain sentence for an S3 failure. Clock skew gets its own because
 * it breaks every signature and looks like a credentials problem.
 */
export function describeS3Error(err: unknown): string {
  const e = (err ?? {}) as {
    name?: string;
    Code?: string;
    code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const code = e.name ?? e.Code ?? e.code ?? '';
  const status = e.$metadata?.httpStatusCode;
  switch (code) {
    case 'RequestTimeTooSkewed':
      return "The server clock is too far from the storage provider's clock, so every request is refused. Fix the time on this server (for example, turn on NTP) and try again.";
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch':
    case 'InvalidToken':
    case 'ExpiredToken':
      return 'The storage provider refused the access key or secret. Check both and save them again.';
    case 'AccessDenied':
    case 'Forbidden':
      return 'The storage provider refused access. The key needs permission to list, read, write and delete in this bucket.';
    case 'NoSuchBucket':
      return 'The bucket does not exist at this endpoint. Check the bucket name, the endpoint and the region.';
    case 'PermanentRedirect':
    case 'AuthorizationHeaderMalformed':
    case 'IllegalLocationConstraintException':
      return 'The bucket is in a different region than the one set here. Check the region.';
    case 'BadDigest':
    case 'InvalidDigest':
      return 'The storage provider received data that did not match its checksum. Try again; if it keeps happening, check the network between this server and the provider.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return "The endpoint name could not be found. Check the endpoint address and this server's DNS.";
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ETIMEDOUT':
    case 'TimeoutError':
      return "Could not reach the endpoint. Check the address and this server's outbound network.";
  }
  if (err instanceof OffsiteVerifyError) return `Verification failed: ${err.message}`;
  if (status === 403)
    return 'The storage provider refused access (HTTP 403). Check the keys and their permissions.';
  if (status === 404)
    return 'The storage provider answered "not found" (HTTP 404). Check the endpoint and bucket.';
  const msg = (e.message ?? String(err)).replace(/\s+/g, ' ').slice(0, 300);
  return code ? `${code}: ${msg}` : msg;
}
