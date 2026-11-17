// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * After a data layer's schema includes layers probed from a staged
 * file, ask the API to load those features. The structure editor and
 * the create wizard both do this. Schema alone leaves an empty layer,
 * which dashboards then omit.
 */

export interface StagedLayerRef {
  layerId: string;
  sourceLayerName: string;
}

export interface StagedFileImport {
  stagingId: string;
  layers: StagedLayerRef[];
}

export async function enqueueStagedLayerImports(
  itemId: string,
  pending: readonly StagedFileImport[],
  post: (url: string, body: unknown) => Promise<Response> = (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
): Promise<string[]> {
  const errors: string[] = [];
  for (const entry of pending) {
    for (const layer of entry.layers) {
      const url = `/api/portal/items/${encodeURIComponent(itemId)}/layers/${encodeURIComponent(layer.layerId)}/import-jobs`;
      try {
        const res = await post(url, {
          stagingId: entry.stagingId,
          sourceLayerName: layer.sourceLayerName,
          mode: 'replace',
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          errors.push(`${layer.sourceLayerName}: ${res.status} ${text.slice(0, 200)}`);
        }
      } catch (err) {
        errors.push(
          `${layer.sourceLayerName}: ${err instanceof Error ? err.message : 'network error'}`,
        );
      }
    }
  }
  return errors;
}
