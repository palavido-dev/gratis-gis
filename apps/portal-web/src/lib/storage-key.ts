// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Object keys as the web app sees them: a mirror of parseObjectKey in
 * apps/portal-api/src/storage/object-keys.ts (the web app cannot import
 * API code). Both are tested against the same cases in
 * apps/portal-api/src/storage/object-key-cases.json, so they cannot
 * drift apart.
 *
 * Keys are `<kind>/<uuid>` (older) or `<kind>/o/<orgId>/<uuid>`
 * (newer). Refused: anything but printable ASCII, `%` and `\`, empty,
 * `.` and `..` segments, an unknown kind, and an org segment that is
 * not a lowercase UUID or has nothing after it.
 */

export const OBJECT_KINDS: ReadonlySet<string> = new Set([
  'item-thumb',
  'group-thumb',
  'user-avatar',
  'org-hero',
  'feature-attachment',
  'item-file',
  'item-tile-layer',
  'item-point-cloud',
  'map-icon',
  'feedback-screenshot',
  'offline-package',
  'analysis-artifact',
  'sam-embed',
  'ingest-upload',
]);

const ORG_SEGMENT = 'o';
const MAX_OBJECT_KEY_LENGTH = 512;
// Fixed length and anchored.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ParsedObjectKey {
  kind: string;
  orgId: string | null;
  rest: string;
}

export function parseObjectKey(key: unknown): ParsedObjectKey | null {
  if (typeof key !== 'string') return null;
  if (key.length === 0 || key.length > MAX_OBJECT_KEY_LENGTH) return null;
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || c === 0x25 || c === 0x5c) return null;
  }
  const segments = key.split('/');
  for (const s of segments) {
    if (s.length === 0 || s === '.' || s === '..') return null;
  }
  const kind = segments[0]!;
  if (!OBJECT_KINDS.has(kind) || segments.length < 2) return null;
  if (segments[1] === ORG_SEGMENT) {
    const orgId = segments[2];
    if (segments.length < 4 || typeof orgId !== 'string' || orgId.length !== 36 || !UUID_RE.test(orgId)) {
      return null;
    }
    return { kind, orgId, rest: segments.slice(3).join('/') };
  }
  return { kind, orgId: null, rest: segments.slice(1).join('/') };
}

/** Kinds the API serves at `storage/private/<key>` with a sharing check. */
const PROXIED_PRIVATE_KINDS: ReadonlySet<string> = new Set([
  'item-file',
  'item-tile-layer',
  'item-point-cloud',
  'feature-attachment',
]);

const PRIVATE_PREFIX = 'storage/private/';
const MAX_NAME_LENGTH = 200;

function isNameChar(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x2e ||
    c === 0x5f ||
    c === 0x2d
  );
}

/**
 * True when a BFF path suffix is a private file read in either key
 * layout: `storage/private/<kind>/<name>` or
 * `storage/private/<kind>/o/<orgId>/<name>`, for a proxied kind, with
 * one object name of `[A-Za-z0-9._-]`.
 */
export function isPrivateStorageProxyPath(suffix: string): boolean {
  if (!suffix.startsWith(PRIVATE_PREFIX)) return false;
  const parsed = parseObjectKey(suffix.slice(PRIVATE_PREFIX.length));
  if (!parsed || !PROXIED_PRIVATE_KINDS.has(parsed.kind)) return false;
  const name = parsed.rest;
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  for (let i = 0; i < name.length; i += 1) {
    if (!isNameChar(name.charCodeAt(i))) return false;
  }
  return true;
}
