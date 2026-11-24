// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * An in-memory S3 that answers the commands the off-site backup code
 * sends, checking Content-MD5 the way a real store does. Test helper
 * only. `fail` makes the next matching command throw an error shaped
 * like the SDK's.
 */
export class FakeS3 {
  objects = new Map<string, { body: Buffer; lastModified: Date; etag: string }>();
  uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  calls: string[] = [];
  aborted: string[] = [];
  /** Corrupt the ETag the next UploadPart returns. */
  lieAboutPartEtag = false;
  /** Report a different size from HeadObject. */
  lieAboutSize = false;
  private failures: Array<{ command: string; error: Error }> = [];
  private nextId = 1;

  fail(command: string, name: string, status = 400) {
    const err = Object.assign(new Error(`${name} from fake`), {
      name,
      $metadata: { httpStatusCode: status },
    });
    this.failures.push({ command, error: err });
  }

  /** Every later command throws this error, like wrong credentials. */
  failAll(name: string, status = 403) {
    this.sticky = Object.assign(new Error(`${name} from fake`), {
      name,
      $metadata: { httpStatusCode: status },
    });
  }
  private sticky: Error | null = null;

  async send(command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<unknown> {
    const name = command.constructor.name;
    this.calls.push(name);
    if (this.sticky) throw this.sticky;
    const i = this.failures.findIndex((f) => f.command === name);
    if (i >= 0) throw this.failures.splice(i, 1)[0]!.error;
    const input = command.input;
    const key = input.Key as string;
    switch (name) {
      case 'CreateMultipartUploadCommand': {
        const id = `u${this.nextId++}`;
        this.uploads.set(id, { key, parts: new Map() });
        return { UploadId: id };
      }
      case 'UploadPartCommand': {
        const body = input.Body as Buffer;
        const md5 = createHash('md5').update(body).digest();
        if (input.ContentMD5 !== md5.toString('base64')) {
          throw Object.assign(new Error('BadDigest'), { name: 'BadDigest' });
        }
        this.uploads
          .get(input.UploadId as string)!
          .parts.set(input.PartNumber as number, Buffer.from(body));
        const etag = this.lieAboutPartEtag
          ? '"00000000000000000000000000000000"'
          : `"${md5.toString('hex')}"`;
        this.lieAboutPartEtag = false;
        return { ETag: etag };
      }
      case 'CompleteMultipartUploadCommand': {
        const up = this.uploads.get(input.UploadId as string)!;
        const nums = [...up.parts.keys()].sort((a, b) => a - b);
        const body = Buffer.concat(nums.map((n) => up.parts.get(n)!));
        const md5s = Buffer.concat(
          nums.map((n) => createHash('md5').update(up.parts.get(n)!).digest()),
        );
        const etag = `"${createHash('md5').update(md5s).digest('hex')}-${nums.length}"`;
        this.objects.set(up.key, { body, lastModified: new Date(), etag });
        this.uploads.delete(input.UploadId as string);
        return { ETag: etag };
      }
      case 'AbortMultipartUploadCommand':
        this.aborted.push(input.UploadId as string);
        this.uploads.delete(input.UploadId as string);
        return {};
      case 'HeadObjectCommand': {
        const o = this.objects.get(key);
        if (!o)
          throw Object.assign(new Error('NotFound'), {
            name: 'NotFound',
            $metadata: { httpStatusCode: 404 },
          });
        return { ContentLength: o.body.length + (this.lieAboutSize ? 1 : 0), ETag: o.etag };
      }
      case 'PutObjectCommand': {
        const body = input.Body as Buffer;
        if (
          input.ContentMD5 &&
          input.ContentMD5 !== createHash('md5').update(body).digest('base64')
        ) {
          throw Object.assign(new Error('BadDigest'), { name: 'BadDigest' });
        }
        this.objects.set(key, { body: Buffer.from(body), lastModified: new Date(), etag: '"x"' });
        return {};
      }
      case 'GetObjectCommand': {
        const o = this.objects.get(key);
        if (!o)
          throw Object.assign(new Error('NoSuchKey'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        return { Body: Readable.from([o.body]), ContentLength: o.body.length };
      }
      case 'DeleteObjectCommand':
        this.objects.delete(key);
        return {};
      case 'ListObjectsV2Command': {
        const prefix = (input.Prefix as string) ?? '';
        const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        return {
          Contents: keys.map((k) => ({
            Key: k,
            Size: this.objects.get(k)!.body.length,
            LastModified: this.objects.get(k)!.lastModified,
          })),
          IsTruncated: false,
        };
      }
      default:
        throw new Error(`FakeS3 does not handle ${name}`);
    }
  }
}
