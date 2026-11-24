// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An in-memory stand-in for the S3 client inside StorageService, for
// tests with no object store. It answers the commands StorageService
// sends (put, get with a range, head, delete, paged listing, multipart)
// the way S3 and MinIO do, so every StorageService method, including
// its key building, owner check and usage ledger writes, runs as in
// production. Presigned URLs are still signed by the real SDK client;
// a test that "uploads" through one writes the bytes with `put`.

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { StorageService } from '../storage/storage.service.js';

type Stored = { body: Buffer; contentType: string | undefined; lastModified: Date };

type Command = { constructor: { name: string }; input: Record<string, unknown> };

function notFound(name: 'NoSuchKey' | 'NotFound' | 'NoSuchUpload'): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
}

async function toBuffer(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** `bytes=a-b` or `bytes=a-` to an inclusive start and end, or null. */
function parseRange(range: unknown, size: number): [number, number] | null {
  if (typeof range !== 'string' || !range.startsWith('bytes=')) return null;
  const [a, b] = range.slice(6).split('-', 2);
  const start = Number(a);
  const end = b === undefined || b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end) return null;
  return [start, end];
}

export class MemoryS3 {
  readonly objects = new Map<string, Stored>();
  private readonly uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  /** Keys per listing page; S3 and MinIO return at most 1000. */
  pageSize = 1000;

  /** Write an object directly, as a browser PUT to a presigned URL would. */
  put(key: string, body: Buffer | string, contentType?: string): void {
    this.objects.set(key, {
      body: Buffer.from(body),
      contentType,
      lastModified: new Date(),
    });
  }

  async send(cmd: Command): Promise<unknown> {
    const i = cmd.input;
    const key = typeof i.Key === 'string' ? i.Key : '';
    switch (cmd.constructor.name) {
      case 'HeadBucketCommand':
      case 'CreateBucketCommand':
      case 'PutBucketPolicyCommand':
      case 'PutBucketCorsCommand':
        return {};
      case 'PutObjectCommand':
        this.objects.set(key, {
          body: await toBuffer(i.Body),
          contentType: i.ContentType as string | undefined,
          lastModified: new Date(),
        });
        return { $metadata: { httpStatusCode: 200 } };
      case 'GetObjectCommand': {
        const o = this.objects.get(key);
        if (!o) throw notFound('NoSuchKey');
        const r = parseRange(i.Range, o.body.length);
        const bytes = r ? o.body.subarray(r[0], r[1] + 1) : o.body;
        return {
          Body: Readable.from([Buffer.from(bytes)]),
          ContentType: o.contentType,
          ContentLength: bytes.length,
          ContentRange: r ? `bytes ${r[0]}-${r[1]}/${o.body.length}` : undefined,
          AcceptRanges: 'bytes',
          $metadata: { httpStatusCode: r ? 206 : 200 },
        };
      }
      case 'HeadObjectCommand': {
        const o = this.objects.get(key);
        if (!o) throw notFound('NotFound');
        return { ContentLength: o.body.length, ContentType: o.contentType };
      }
      case 'DeleteObjectCommand':
        this.objects.delete(key);
        return {};
      case 'ListObjectsV2Command': {
        const prefix = typeof i.Prefix === 'string' ? i.Prefix : '';
        const after =
          typeof i.ContinuationToken === 'string'
            ? i.ContinuationToken
            : typeof i.StartAfter === 'string'
              ? i.StartAfter
              : '';
        const keys = [...this.objects.keys()]
          .filter((k) => k.startsWith(prefix) && k > after)
          .sort();
        const page = keys.slice(0, this.pageSize);
        const truncated = keys.length > page.length;
        return {
          Contents: page.map((k) => {
            const o = this.objects.get(k)!;
            return { Key: k, Size: o.body.length, LastModified: o.lastModified };
          }),
          IsTruncated: truncated,
          NextContinuationToken: truncated ? page[page.length - 1] : undefined,
        };
      }
      case 'CreateMultipartUploadCommand': {
        const id = randomUUID();
        this.uploads.set(id, { key, parts: new Map() });
        return { UploadId: id };
      }
      case 'UploadPartCommand': {
        const u = this.uploads.get(String(i.UploadId));
        if (!u || u.key !== key) throw notFound('NoSuchUpload');
        u.parts.set(Number(i.PartNumber), await toBuffer(i.Body));
        return { ETag: `"${i.PartNumber}"` };
      }
      case 'ListPartsCommand': {
        const u = this.uploads.get(String(i.UploadId));
        if (!u || u.key !== key) throw notFound('NoSuchUpload');
        return {
          Parts: [...u.parts.entries()].map(([n, b]) => ({ PartNumber: n, ETag: `"${n}"`, Size: b.length })),
          IsTruncated: false,
        };
      }
      case 'CompleteMultipartUploadCommand': {
        const u = this.uploads.get(String(i.UploadId));
        if (!u || u.key !== key) throw notFound('NoSuchUpload');
        const order = [...u.parts.keys()].sort((a, b) => a - b);
        this.put(key, Buffer.concat(order.map((n) => u.parts.get(n)!)));
        this.uploads.delete(String(i.UploadId));
        return {};
      }
      case 'AbortMultipartUploadCommand': {
        const u = this.uploads.get(String(i.UploadId));
        if (!u || u.key !== key) throw notFound('NoSuchUpload');
        this.uploads.delete(String(i.UploadId));
        return {};
      }
      case 'ListMultipartUploadsCommand': {
        const prefix = typeof i.Prefix === 'string' ? i.Prefix : '';
        return {
          Uploads: [...this.uploads.entries()]
            .filter(([, u]) => u.key.startsWith(prefix))
            .map(([id, u]) => ({ Key: u.key, UploadId: id })),
          IsTruncated: false,
        };
      }
      default:
        throw new Error(`MemoryS3: ${cmd.constructor.name} is not modelled`);
    }
  }
}

const attached = new WeakMap<object, MemoryS3>();

/**
 * Put a MemoryS3 behind `storage` in place of its S3 client and return
 * the same service. Signing still uses the real SDK client.
 */
export function withMemoryS3(storage: StorageService, s3 = new MemoryS3()): StorageService {
  (storage as unknown as { client: MemoryS3 }).client = s3;
  attached.set(storage, s3);
  return storage;
}

/** The MemoryS3 behind a service made by withMemoryS3. */
export function memoryS3Of(storage: StorageService): MemoryS3 {
  const s3 = attached.get(storage);
  if (!s3) throw new Error('This StorageService has no in-memory store');
  return s3;
}
