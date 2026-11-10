// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Pure pieces of the resumable import upload: part sizing, the signed
 * upload handle, and the disk-space rule. Kept apart from the service
 * so they can be tested without storage or a database.
 */

const MIB = 1024 * 1024;

/**
 * Largest file the import accepts. This is a sanity ceiling, not a
 * product limit. The real limit is free disk on the server, which the
 * start endpoint measures. Shared with the multipart `POST
 * /ingest/stage` path and its multer config.
 */
export const INGEST_MAX_UPLOAD_BYTES = 50 * 1024 * MIB;

/** S3 allows at most 10,000 parts in one multipart upload. */
export const MAX_UPLOAD_PARTS = 10_000;

/** Smallest part we hand out. S3 needs 5 MiB for every part but the last. */
export const MIN_PART_BYTES = 16 * MIB;

/** Spare bytes required on top of twice the file size. */
export const UPLOAD_DISK_MARGIN_BYTES = 512 * MIB;

/** How long a handle stays valid. MinIO drops stale uploads after 24h by default. */
export const UPLOAD_HANDLE_TTL_MS = 48 * 60 * 60 * 1000;

/** Object key prefix for in-flight import uploads. Private: not in the public-read policy. */
export const INGEST_UPLOAD_PREFIX = 'ingest-upload/';

/**
 * Part size for a file of `sizeBytes`: at least 16 MiB, and large
 * enough that the file fits in 10,000 parts. Rounded up to a whole MiB.
 */
export function choosePartSize(sizeBytes: number): number {
  const needed = Math.ceil(sizeBytes / MAX_UPLOAD_PARTS / MIB) * MIB;
  return Math.max(MIN_PART_BYTES, needed);
}

export function partCountFor(sizeBytes: number, partSize: number): number {
  return Math.max(1, Math.ceil(sizeBytes / partSize));
}

/** Exact byte length of part `n` (1-based). The last part holds the rest. */
export function partLength(sizeBytes: number, partSize: number, n: number): number {
  const count = partCountFor(sizeBytes, partSize);
  if (!Number.isInteger(n) || n < 1 || n > count) return 0;
  if (n < count) return partSize;
  return sizeBytes - partSize * (count - 1);
}

/** Bytes that must be free on the staging volume before an upload starts. */
export function requiredFreeBytes(sizeBytes: number): number {
  return sizeBytes * 2 + UPLOAD_DISK_MARGIN_BYTES;
}

/** Plain size for messages: "1.4 GB", "820 MB". */
export function formatSize(bytes: number): string {
  const gb = bytes / (1024 * MIB);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / MIB))} MB`;
}

/** What a handle carries. Every field is fixed at start. */
export interface UploadClaims {
  /** User who started the upload. */
  uid: string;
  /** Object key in the bucket. */
  key: string;
  /** S3 multipart upload id. */
  upl: string;
  /** Declared file size in bytes. */
  size: number;
  /** Part size in bytes. */
  part: number;
  /** Original file name, already checked. */
  name: string;
  /** Expiry, ms since epoch. */
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(`v1.${body}`).digest();
}

/**
 * Sign the claims into an opaque string the browser keeps. The server
 * does not store uploads anywhere else, so this signature is what ties
 * an upload to the user who started it.
 */
export function signUploadHandle(claims: UploadClaims, key: Buffer): string {
  const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${body}.${b64url(mac(key, body))}`;
}

/**
 * Claims from a handle, or null when the handle is malformed, carries
 * a bad signature, or has expired. Callers check the user id.
 */
export function verifyUploadHandle(
  handle: unknown,
  key: Buffer,
  now = Date.now(),
): UploadClaims | null {
  if (typeof handle !== 'string' || handle.length > 4096) return null;
  const dot = handle.indexOf('.');
  if (dot <= 0 || dot !== handle.lastIndexOf('.')) return null;
  const body = handle.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(handle.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const c = parsed as Partial<UploadClaims> | null;
  if (
    !c ||
    typeof c.uid !== 'string' ||
    typeof c.key !== 'string' ||
    typeof c.upl !== 'string' ||
    typeof c.name !== 'string' ||
    typeof c.size !== 'number' ||
    typeof c.part !== 'number' ||
    typeof c.exp !== 'number'
  ) {
    return null;
  }
  if (c.exp < now) return null;
  return {
    uid: c.uid,
    key: c.key,
    upl: c.upl,
    size: c.size,
    part: c.part,
    name: c.name,
    exp: c.exp,
  };
}
