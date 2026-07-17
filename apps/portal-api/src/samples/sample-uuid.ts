// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';

/**
 * Fixed namespace for GratisGIS sample-content entity ids. Any random
 * UUID works here as long as it never changes: the value is hashed
 * into every derived id, so changing it would re-key every sample
 * feature on the next seed run.
 */
const SAMPLE_UUID_NAMESPACE = 'c1c73c46-2c33-46a9-a6a9-6d5a53bfb0f6';

/**
 * Deterministic name-based UUID (RFC 9562 section 5.6, version 5 /
 * SHA-1) for sample feature entities. The observation engine requires
 * every entity id to be UUID-shaped (packages/engine validate.ts), so
 * the human-readable slugs baked into the bundled GeoJSON
 * ("sample-fac-01") cannot be used directly. Hashing
 * `<layerItemId>:<slug>` gives each feature a stable UUID: a re-run
 * after a partial failure resolves the same layer item id from its
 * seedKind and therefore addresses the same entities, and two orgs
 * never collide because their layer item ids differ.
 *
 * Hand-rolled (about ten lines) rather than a dependency: Node ships
 * SHA-1 in node:crypto and the version / variant bit twiddling is the
 * whole remaining algorithm.
 */
export function deterministicSampleUuid(name: string): string {
  const ns = Buffer.from(SAMPLE_UUID_NAMESPACE.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(ns).update(name, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}
