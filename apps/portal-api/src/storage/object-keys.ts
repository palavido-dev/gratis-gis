// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';

import { isMultiTenant } from '../common/tenancy.js';
import type { AssetKind } from './storage.service.js';

/**
 * Object keys: how they are built and how their owner is checked.
 *
 * New objects get `<kind>/o/<orgId>/<uuid>[suffix]`. The kind stays
 * first so the bucket's public-read rules, which match `<kind>/*`,
 * keep working. Objects written before this layout keep their keys
 * (`<kind>/<uuid>` and a few other shapes); nothing is moved, and
 * both layouts are read.
 *
 * Every StorageService method that reads, writes, deletes or signs a
 * URL for a key runs `assertObjectOwner` first. The caller says which
 * organization the object must belong to: the org of the item or row
 * that authorised the access, never an org taken from the request.
 * System work (sweeps, backup, the usage reconcile) passes a system
 * owner instead and is not checked.
 */

/** Kinds written by background workers rather than by an upload. */
export type WorkerObjectKind = 'analysis-artifact' | 'sam-embed' | 'ingest-upload';

export type ObjectKind = AssetKind | WorkerObjectKind;

/** Every first segment an object key may start with. */
export const OBJECT_KINDS: ReadonlySet<string> = new Set<ObjectKind>([
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

/** Second segment that marks the org-prefixed layout. */
export const ORG_SEGMENT = 'o';

/** Longest key accepted. S3 allows 1024 bytes; ours are far shorter. */
export const MAX_OBJECT_KEY_LENGTH = 512;

// Fixed length and anchored, so it costs the same on any input.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for a lowercase, hyphenated UUID. */
export function isLowerUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID_RE.test(value);
}

/** Suffixes a key may end with after its UUID. */
export type KeySuffix = '' | '.png' | '.geojson';

/**
 * The key for a new object of `kind` owned by `orgId`. The one place
 * new keys are built; `scripts/check-storage-keys.mjs` fails CI on a
 * random key built anywhere else.
 */
export function storageKey(kind: ObjectKind, orgId: string, suffix: KeySuffix = ''): string {
  return `${orgPrefix(kind, orgId)}${randomUUID()}${suffix}`;
}

/**
 * The key for an object that belongs to no organization: a feedback
 * screenshot sent from a page with no org. Older layout, read only by
 * system work, never counted.
 */
export function unownedKey(kind: ObjectKind): string {
  if (!OBJECT_KINDS.has(kind)) throw new TypeError(`Unknown object kind: ${kind}`);
  return `${kind}/${randomUUID()}`;
}

/**
 * The prefix every new object of `kind` owned by `orgId` sits under,
 * ending in a slash. Used to build keys with a fixed path below the
 * org (cached embeddings) and to list one org's objects.
 */
export function orgPrefix(kind: ObjectKind, orgId: string): string {
  if (!OBJECT_KINDS.has(kind)) throw new TypeError(`Unknown object kind: ${kind}`);
  if (!isLowerUuid(orgId)) throw new TypeError('Object keys need a lowercase org UUID');
  return `${kind}/${ORG_SEGMENT}/${orgId}/`;
}

/**
 * Keys of one cached image embedding (a supertile of an imagery item),
 * newest layout first: `sam-embed/o/<orgId>/<itemId>/<z>/<gx>/<gy>.bin`,
 * then the older `sam-embed/<itemId>/...`. The analysis worker writes
 * the first; both are read. Cells are integers, so no input reaches
 * the key as text.
 */
export function samEmbedKeys(
  orgId: string,
  itemId: string,
  cell: { z: number; gx: number; gy: number },
): [string, string] {
  if (!isLowerUuid(itemId)) throw new TypeError('Embedding keys need an item UUID');
  const tail = `${itemId}/${Math.trunc(cell.z)}/${Math.trunc(cell.gx)}/${Math.trunc(cell.gy)}.bin`;
  return [`${orgPrefix('sam-embed', orgId)}${tail}`, `sam-embed/${tail}`];
}

export interface ParsedObjectKey {
  kind: ObjectKind;
  /** The org segment, or null for a key in the older layout. */
  orgId: string | null;
  /** Everything after the kind (and the org segment when present). */
  rest: string;
}

/**
 * Split a key into kind, org and the rest, or null when the key is not
 * one this server could have written. Refused:
 *
 * - anything but printable ASCII (Unicode look-alikes), `%` (encoded
 *   separators) and `\` (the other separator);
 * - empty, `.` and `..` segments (traversal);
 * - an unknown kind, or a kind in the wrong case;
 * - an org segment that is not a lowercase UUID, or nothing after it.
 *
 * S3 keys are opaque, so `..` does not escape in the store itself; it
 * is refused because a proxy that normalises paths would let it.
 */
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
    if (segments.length < 4 || !isLowerUuid(orgId)) return null;
    return { kind: kind as ObjectKind, orgId, rest: segments.slice(3).join('/') };
  }
  return { kind: kind as ObjectKind, orgId: null, rest: segments.slice(1).join('/') };
}

/** The org a key names in its path, or null (older layout or malformed). */
export function keyOrgId(key: unknown): string | null {
  return parseObjectKey(key)?.orgId ?? null;
}

/**
 * Who an object must belong to for a storage call to go ahead.
 *
 * - `{ orgId }`: the org of the item or row that authorised the call.
 * - `{ system }`: work that is not for one org (sweeps, backup, the
 *   usage reconcile). `system` is a short fixed label, never input.
 */
export type ObjectOwner = { readonly orgId: string } | { readonly system: string };

export function orgOwner(orgId: string): ObjectOwner {
  return { orgId };
}

export function systemOwner(reason: string): ObjectOwner {
  return { system: reason };
}

/** Thrown when a key fails the owner check. Answers 404, like a missing object. */
export class ObjectKeyRefusedError extends NotFoundException {
  constructor() {
    super('Not found');
  }
}

/**
 * The single owner check. Passes when:
 *
 * - the owner is system work; or
 * - the key is well formed and its org segment equals the owner's org; or
 * - the key is in the older layout and either this install serves one
 *   organization (every old key is that org's), or the usage ledger
 *   records the key under the owner's org.
 *
 * Everything else throws ObjectKeyRefusedError. With many
 * organizations, an old-layout key the ledger does not know is
 * refused: an unknown owner is never assumed to be the caller.
 */
export async function assertObjectOwner(
  key: string,
  owner: ObjectOwner,
  legacyOrgOf: (key: string) => Promise<string | null>,
): Promise<void> {
  if ('system' in owner) return;
  const parsed = parseObjectKey(key);
  if (!parsed || typeof owner.orgId !== 'string') throw new ObjectKeyRefusedError();
  if (parsed.orgId !== null) {
    if (parsed.orgId !== owner.orgId) throw new ObjectKeyRefusedError();
    return;
  }
  if (!isMultiTenant()) return;
  const recorded = await legacyOrgOf(key);
  if (recorded !== owner.orgId) throw new ObjectKeyRefusedError();
}
