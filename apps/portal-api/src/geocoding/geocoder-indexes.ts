// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Geocoder search indexes are partial trigram indexes on the shared,
 * partitioned `observation` table, named `idx_geo_<itemIdHex>_<field>`.
 * Building or dropping one locks the whole table (every layer of every
 * org), so these helpers exist to keep their number bounded and to
 * remove them when the geocoder goes away.
 */
export const GEOCODER_INDEX_PREFIX = 'idx_geo';
export const GEOCODER_INDEX_NAME = /^idx_geo_[a-f0-9]+_[a-zA-Z0-9_]+$/;

/** Most geocoder indexes one org may hold across all its geocoders. */
export const GEOCODER_INDEXES_PER_ORG = 12;

export function geocoderIndexPrefix(itemId: string): string {
  return `${GEOCODER_INDEX_PREFIX}_${itemId.replace(/-/g, '').slice(0, 16)}_`;
}

interface RawClient {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string): Promise<unknown>;
}

/** Drop every index owned by one geocoder item. Returns the names. */
export async function dropGeocoderIndexes(
  prisma: RawClient,
  itemId: string,
): Promise<string[]> {
  const existing = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname LIKE ${`${geocoderIndexPrefix(itemId)}%`}
  `;
  const dropped: string[] = [];
  for (const r of existing) {
    if (!GEOCODER_INDEX_NAME.test(r.indexname)) continue;
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${r.indexname}"`);
    dropped.push(r.indexname);
  }
  return dropped;
}
