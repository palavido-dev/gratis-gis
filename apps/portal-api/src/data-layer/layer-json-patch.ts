// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Change one field on one layer of item.data_json in the same
 * statement that reads the row. A whole-document write from an
 * earlier read would drop a syncVersion committed in between.
 */
export async function patchLayerField(
  prisma: PrismaService,
  itemId: string,
  layerId: string,
  field: 'source' | 'featureCount',
  value: unknown,
): Promise<void> {
  const path = field === 'source' ? '{source}' : '{featureCount}';
  await prisma.$executeRaw`
    UPDATE item
    SET data_json = jsonb_set(
          data_json,
          '{layers}',
          (
            SELECT COALESCE(jsonb_agg(
              CASE WHEN elem->>'id' = ${layerId}
                   THEN jsonb_set(elem, ${path}::text[], ${JSON.stringify(value)}::jsonb, true)
                   ELSE elem END
            ), '[]'::jsonb)
            FROM jsonb_array_elements(data_json->'layers') elem
          ),
          true
        ),
        updated_at = now()
    WHERE id = ${itemId}::uuid
      AND data_json->>'version' = '3'
  `;
}

export async function patchLayerCounts(
  prisma: PrismaService,
  itemId: string,
  counts: Record<string, number>,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE item
    SET data_json = jsonb_set(
          data_json,
          '{layers}',
          (
            SELECT COALESCE(jsonb_agg(
              CASE WHEN ${JSON.stringify(counts)}::jsonb ? (elem->>'id')
                   THEN jsonb_set(
                     elem,
                     '{featureCount}',
                     ${JSON.stringify(counts)}::jsonb -> (elem->>'id'),
                     true
                   )
                   ELSE elem END
            ), '[]'::jsonb)
            FROM jsonb_array_elements(data_json->'layers') elem
          ),
          true
        ),
        updated_at = now()
    WHERE id = ${itemId}::uuid
      AND data_json->>'version' = '3'
  `;
}
