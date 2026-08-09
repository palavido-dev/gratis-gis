// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AssetKind } from './storage.service.js';

/**
 * The three item types that name a single MinIO object from their
 * data_json. StorageService composes keys as `<kind>/<uuid>`, so an
 * item of one of these types may only ever reference a key under its
 * own kind's prefix.
 *
 * This exists because the constraint is enforced in several places
 * that must agree: item create/update (the generic /items DTO
 * validates `data` with nothing but @IsObject, so any caller can
 * propose a key), the @Public serve proxies, and the purge path that
 * deletes through the key. tile-layer.service.ts and
 * point-cloud.service.ts each grew their own copy of the prefix
 * literal first; keep new call sites pointed here instead.
 *
 * Why it matters: the serve proxies read with portal-api's own MinIO
 * credentials, so they bypass the bucket policy rather than riding
 * it. An unpinned key turns a public item into a read primitive over
 * the whole bucket, including `feedback-screenshot/` (uploaded
 * anonymously, meant for admin triage only) and `feature-attachment/`.
 * The same unpinned key is what purge deletes, so it is a delete
 * primitive too.
 */
export const ITEM_ASSET_KIND = {
  file: 'item-file',
  tile_layer: 'item-tile-layer',
  point_cloud: 'item-point-cloud',
} as const satisfies Record<string, AssetKind>;

export type AssetKeyedItemType = keyof typeof ITEM_ASSET_KIND;

export function isAssetKeyedItemType(
  type: string,
): type is AssetKeyedItemType {
  return Object.prototype.hasOwnProperty.call(ITEM_ASSET_KIND, type);
}

/**
 * True when `key` is a well-formed object key belonging to `kind`.
 *
 * Rejects traversal and empty segments as well as the wrong prefix.
 * S3 keys are opaque strings rather than paths, so `..` does not
 * actually escape in MinIO, but any proxy or client that normalises
 * on the way through would make it escape, and nothing legitimate
 * ever mints such a key.
 */
export function isValidAssetKey(key: unknown, kind: AssetKind): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  const prefix = `${kind}/`;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  if (rest.length === 0) return false;
  return rest.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

/**
 * The key an item of this type is allowed to reference, or null when
 * the item does not carry one. Throws nothing: callers decide whether
 * a bad key is a 400 (write paths) or a 404 (read paths), because
 * leaking "that key exists but is not yours" is itself a signal.
 */
export function assetKeyFor(
  itemType: string,
  key: unknown,
): { ok: true; key: string | null } | { ok: false } {
  if (!isAssetKeyedItemType(itemType)) return { ok: true, key: null };
  // An empty string is how the UI clears a file item's upload, and
  // an absent key is an item whose upload has not happened yet.
  if (key === undefined || key === null || key === '') {
    return { ok: true, key: null };
  }
  if (!isValidAssetKey(key, ITEM_ASSET_KIND[itemType])) return { ok: false };
  return { ok: true, key: key as string };
}
