// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';

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
 * The suffixes each kind may carry. Raster map icons end in `.png`
 * (a style names them by that full key) and the worker's analysis
 * results end in `.geojson`; every other kind is the bare UUID. The
 * orphan sweep's key pattern captures exactly these.
 */
export const KIND_SUFFIXES: ReadonlyMap<ObjectKind, readonly KeySuffix[]> = new Map<
  ObjectKind,
  readonly KeySuffix[]
>([
  ['map-icon', ['', '.png']],
  ['analysis-artifact', ['', '.geojson']],
]);

/** The suffixes `kind` may carry after its UUID. */
export function suffixesOf(kind: ObjectKind): readonly KeySuffix[] {
  return KIND_SUFFIXES.get(kind) ?? [''];
}

/**
 * The key for a new object of `kind` owned by `orgId`. The one place
 * new keys are built; `scripts/check-storage-keys.mjs` fails CI on a
 * random key built anywhere else.
 */
export function storageKey(kind: ObjectKind, orgId: string, suffix: KeySuffix = ''): string {
  if (!suffixesOf(kind).includes(suffix)) {
    throw new TypeError(`Kind ${kind} does not take the suffix ${suffix}`);
  }
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

/** The parsed key when it is well formed and of `kind`, else null. */
export function parseKeyOfKind(key: unknown, kind: ObjectKind): ParsedObjectKey | null {
  const parsed = parseObjectKey(key);
  return parsed && parsed.kind === kind ? parsed : null;
}

/** True when `key` is well formed and of `kind`, in either layout. */
export function isKeyOfKind(key: unknown, kind: ObjectKind): key is string {
  return parseKeyOfKind(key, kind) !== null;
}

/**
 * True when `key` is well formed and may belong to `orgId`: a key in
 * the org layout must name that org; a key in the older layout names
 * none, so the caller's other checks decide.
 */
export function keyMayBelongToOrg(key: unknown, orgId: string): boolean {
  const parsed = parseObjectKey(key);
  return parsed !== null && (parsed.orgId === null || parsed.orgId === orgId);
}

/**
 * Refuse a job whose source files name another organization. Used
 * where the API hands item keys to a background worker that reads with
 * the server's own credentials: a key in the org layout must name the
 * org of the item that authorised the job. Older keys carry no org and
 * keep their earlier checks.
 */
export function assertKeysMayBelongToOrg(keys: Iterable<unknown>, orgId: string): void {
  for (const key of keys) {
    // Only a key that names an org is judged here. Older and malformed
    // keys are left to the checks that already apply to them.
    const named = keyOrgId(key);
    if (named !== null && named !== orgId) {
      throw new BadRequestException(
        "This layer's file is not stored where this kind of layer keeps its files, so it was not read.",
      );
    }
  }
}

/** Longest object name accepted after the UUID (suffix included). */
const MAX_OBJECT_NAME_LENGTH = 100;

function isNameChar(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || // 0-9
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    c === 0x2e || // .
    c === 0x5f || // _
    c === 0x2d // -
  );
}

/**
 * True when `rest` (what follows the kind and org) is one object name:
 * a UUID then at most a short run of `[A-Za-z0-9._-]`, with no slash.
 * Public image URLs name exactly one such object.
 */
export function isSingleObjectName(rest: string): boolean {
  if (rest.length < 36 || rest.length > MAX_OBJECT_NAME_LENGTH) return false;
  if (!isLowerUuid(rest.slice(0, 36).toLowerCase())) return false;
  for (let i = 36; i < rest.length; i += 1) {
    if (!isNameChar(rest.charCodeAt(i))) return false;
  }
  return true;
}

/** Where public objects are served from: `<publicBase>/<bucket>/<key>`. */
export interface PublicObjectBase {
  publicBase: string;
  bucket: string;
}

/** The URL prefix public objects are served under, ending in a slash. */
export function publicObjectPrefix(base: PublicObjectBase): string {
  const trimmed = base.publicBase.endsWith('/') ? base.publicBase.slice(0, -1) : base.publicBase;
  return `${trimmed}/${base.bucket}/`;
}

/** Longest stored URL looked at. */
const MAX_URL_LENGTH = 2048;

/**
 * The object a public URL of this install names, when it is one object
 * of `kind` in either layout: `<publicBase>/<bucket>/<kind>/<name>` or
 * `<publicBase>/<bucket>/<kind>/o/<orgId>/<name>`. Null for anything
 * else, including a query string or fragment.
 */
export function publicUrlObject(
  url: unknown,
  base: PublicObjectBase,
  kind: ObjectKind,
): (ParsedObjectKey & { key: string }) | null {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null;
  const prefix = publicObjectPrefix(base);
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  const parsed = parseKeyOfKind(key, kind);
  if (!parsed || !isSingleObjectName(parsed.rest)) return null;
  return { ...parsed, key };
}

/** Kinds whose objects are read straight from the bucket by URL. */
export const PUBLIC_URL_KINDS: readonly ObjectKind[] = [
  'item-thumb',
  'group-thumb',
  'user-avatar',
  'org-hero',
];

/**
 * The object key at the end of a stored public URL, whatever host it
 * was stored under, or null. For the usage reconcile, which reads URLs
 * saved over the life of the install, when the public base may have
 * changed.
 */
export function objectKeyInStoredUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null;
  for (const kind of PUBLIC_URL_KINDS) {
    const at = url.lastIndexOf(`/${kind}/`);
    if (at === -1) continue;
    let end = url.length;
    for (const stop of ['?', '#']) {
      const i = url.indexOf(stop, at);
      if (i !== -1 && i < end) end = i;
    }
    const key = url.slice(at + 1, end);
    return parseKeyOfKind(key, kind) ? key : null;
  }
  return null;
}

/** Private kinds whose bare bucket URLs item data may still carry. */
const BARE_URL_PRIVATE_KINDS: ReadonlySet<string> = new Set<ObjectKind>([
  'item-file',
  'item-tile-layer',
  'feature-attachment',
]);

/**
 * Where bare bucket URLs of this install can point: the public base
 * and the storage endpoint the API itself uses, each followed by
 * `/<bucket>/`. A relative `/<bucket>/` path counts too.
 */
export interface BareUrlBases {
  bases: readonly string[];
  bucket: string;
}

/**
 * The bases from the same settings StorageService reads: the public
 * base (`MINIO_PUBLIC_BASE`, defaulting to the endpoint) and the
 * endpoint the API uses (`MINIO_ENDPOINT`), with `MINIO_BUCKET`.
 */
export function bareUrlBasesFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BareUrlBases {
  const endpoint = env.MINIO_ENDPOINT || 'http://localhost:9000';
  return {
    bases: [env.MINIO_PUBLIC_BASE || endpoint, endpoint],
    bucket: env.MINIO_BUCKET || 'gratisgis',
  };
}

/**
 * The API path for a bare bucket URL of a private object of this
 * install, or null when `value` is anything else. The whole value must
 * be `<base>/<bucket>/<kind>/[o/<orgId>/]<uuid>` (plus a suffix the
 * kind allows), where `<base>` is one of `bases.bases` or empty (a
 * relative path). Any other host, name, query or embedded text is
 * left as written. Private objects are served only through the API
 * with a sharing check; an item saved with the bucket URL is
 * rewritten to the API path.
 */
export function privatePathForBareUrl(value: unknown, bases: BareUrlBases): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  if (bases.bucket.length === 0) return null;
  const tail = `/${bases.bucket}/`;
  let key: string | null = null;
  for (const base of ['', ...bases.bases]) {
    const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
    if (base !== '' && !/^https?:\/\/[^/]/.test(trimmed)) continue;
    const prefix = `${trimmed}${tail}`;
    if (value.startsWith(prefix)) {
      key = value.slice(prefix.length);
      break;
    }
  }
  if (key === null) return null;
  const parsed = parseObjectKey(key);
  if (!parsed || !BARE_URL_PRIVATE_KINDS.has(parsed.kind)) return null;
  const name = parsed.rest;
  const named = suffixesOf(parsed.kind).some(
    (suffix) =>
      name.length === 36 + suffix.length && name.endsWith(suffix) && isLowerUuid(name.slice(0, 36)),
  );
  return named ? `/api/portal/storage/private/${key}` : null;
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
 * Where the owner check learns who owns an older-layout key.
 *
 * - `orgOf`: the org the usage ledger records for the key, or null.
 * - `ledgerFilled`: true once a full reconcile has filled the ledger.
 *   Until then a key with no ledger row may simply not be recorded yet.
 */
export interface LegacyOwnerLookup {
  orgOf(key: string): Promise<string | null>;
  ledgerFilled(): Promise<boolean>;
}

/**
 * Process-wide counts for the older-layout rule, read by the metrics
 * endpoint. `refusedNoRow`: older keys refused because the filled
 * ledger has no row for them. `passedBeforeFill`: older keys let
 * through because the ledger has not been filled yet.
 */
export const legacyKeyCounters = { refusedNoRow: 0, passedBeforeFill: 0 };

const ownerLog = new Logger('StorageOwnerCheck');

/** At most one log line per event per this many ms. */
const LOG_EVERY_MS = 60_000;

class RateLimitedLine {
  private last = 0;
  private suppressed = 0;

  constructor(private readonly write: (line: string) => void) {}

  say(line: string, now: number = Date.now()): void {
    if (now - this.last < LOG_EVERY_MS) {
      this.suppressed += 1;
      return;
    }
    const more = this.suppressed > 0 ? ` (${this.suppressed} more since the last line)` : '';
    this.last = now;
    this.suppressed = 0;
    this.write(`${line}${more}`);
  }
}

const refusedLine = new RateLimitedLine((l) => ownerLog.warn(l));
const windowLine = new RateLimitedLine((l) => ownerLog.log(l));

/**
 * The single owner check. Passes when:
 *
 * - the owner is system work; or
 * - the key is well formed and its org segment equals the owner's org; or
 * - the key is in the older layout and either this install serves one
 *   organization (every old key is that org's), or the usage ledger
 *   records the key under the owner's org, or the ledger has not been
 *   filled yet and has no row for the key.
 *
 * The last case keeps files stored before the ledger existed readable
 * until its first fill has finished; the item permission checks still
 * apply to them, as they did before the ledger. After the first fill
 * an older key the ledger does not know is refused (logged, rate
 * limited, and counted): an unknown owner is never assumed to be the
 * caller.
 *
 * `legacy` may also be a plain lookup function; the ledger is then
 * taken as filled.
 */
export async function assertObjectOwner(
  key: string,
  owner: ObjectOwner,
  legacy: LegacyOwnerLookup | ((key: string) => Promise<string | null>),
): Promise<void> {
  if ('system' in owner) return;
  const parsed = parseObjectKey(key);
  if (!parsed || typeof owner.orgId !== 'string') throw new ObjectKeyRefusedError();
  if (parsed.orgId !== null) {
    if (parsed.orgId !== owner.orgId) throw new ObjectKeyRefusedError();
    return;
  }
  if (!isMultiTenant()) return;
  const lookup: LegacyOwnerLookup =
    typeof legacy === 'function' ? { orgOf: legacy, ledgerFilled: async () => true } : legacy;
  const recorded = await lookup.orgOf(key);
  if (recorded !== null) {
    if (recorded !== owner.orgId) throw new ObjectKeyRefusedError();
    return;
  }
  if (!(await lookup.ledgerFilled())) {
    legacyKeyCounters.passedBeforeFill += 1;
    windowLine.say(
      'Storage usage ledger not filled yet: an older file with no ledger row was served under ' +
        'the item permission checks alone. This stops once the first fill finishes.',
    );
    return;
  }
  legacyKeyCounters.refusedNoRow += 1;
  refusedLine.say(`Refused an older file key with no usage ledger row (kind ${parsed.kind}).`);
  throw new ObjectKeyRefusedError();
}
