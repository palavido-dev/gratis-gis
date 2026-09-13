// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The bytes a layer schema hashes to.
 *
 * The web field runtime stamps every cached layer and every queued
 * edit with a hash of the layer's field list, and compares it with
 * the live schema at sync time to detect drift. The hash is a client
 * concept (the server never sees it), so the only thing that has to
 * agree is the two clients: the web runtime, which hashes with
 * SubtleCrypto, and the native field client, which hashes with the
 * platform's SHA-256. What they have to agree on is the text, and
 * JSON.stringify's key order and number formatting are not something
 * to reimplement in Kotlin. So the text is produced here, once, and
 * shipped in the engine bundle; each client hashes the bytes it gets.
 *
 * The canonical form is what `hashLayerSchema` in
 * apps/portal-web/src/lib/offline-store.ts has always produced:
 * name, type, nullable (coerced to a boolean), domain (or null), in
 * that key order, sorted by name, serialised with JSON.stringify.
 * Changing it invalidates every hash on every device, so it must not
 * change without a plan for the rows carrying the old one.
 */

import type { FeatureField } from './data-layer';

/** The loose shape the web runtime passes: `nullable` may be absent. */
export interface LayerSchemaFieldForHash {
  name: string;
  type: string;
  nullable?: boolean | undefined;
  domain?: FeatureField['domain'] | null | undefined;
}

export function canonicalLayerSchema(
  fields: ReadonlyArray<LayerSchemaFieldForHash>,
): string {
  const canon = fields
    .map((f) => ({
      name: f.name,
      type: f.type,
      nullable: f.nullable === true,
      domain: f.domain ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify(canon);
}

/** Hex digest length the clients keep: 8 bytes, 16 characters. */
export const LAYER_SCHEMA_HASH_HEX_LENGTH = 16;
