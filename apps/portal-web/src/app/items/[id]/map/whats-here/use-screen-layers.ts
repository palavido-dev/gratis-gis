// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FeatureField, MapLayer } from '@gratis-gis/shared-types';

import type { ScreenGeometry, ScreenLayer } from '@/lib/whats-here';

/** code -> label for each field that has a pick list. */
export type CodeLabels = Record<string, Record<string, string>>;

export interface ScreenLayerInfo extends ScreenLayer {
  /** Field whose value names a picked feature (an APN, a site id). */
  labelField: string | null;
  codeLabels: CodeLabels;
}

interface ItemDoc {
  data?: {
    layers?: Array<{
      id?: string;
      fields?: FeatureField[];
      geometryType?: string | null;
    }>;
  };
}

/** Layers What's Here can screen: visible data layers, in panel order. */
export function screenableMapLayers(layers: MapLayer[]): MapLayer[] {
  return layers.filter(
    (l) =>
      l.visible &&
      l.source.kind === 'data-layer' &&
      typeof l.source.layerKey === 'string' &&
      l.source.layerKey.length > 0,
  );
}

/**
 * The field that names a feature, for listing picked parcels by APN.
 * The author already said which one when they set up search or
 * labels; take that before guessing the first text field.
 */
function pickLabelField(l: MapLayer, fields: FeatureField[]): string | null {
  const known = new Set(fields.map((f) => f.name));
  const searched = l.search.enabled ? l.search.fields.find((f) => known.has(f)) : undefined;
  if (searched) return searched;
  // A label that is exactly one placeholder, {APN} or {{APN}}.
  const m = /^\s*\{\{?\s*([A-Za-z_][\w.]*)\s*\}?\}\s*$/.exec(l.labels.template);
  if (m && known.has(m[1]!)) return m[1]!;
  return fields.find((f) => f.type === 'string')?.name ?? null;
}

/**
 * Fields worth breaking a screen down by. Text, pick lists and yes/no:
 * the categories a land cover class or a fee zone is stored as. Not
 * numbers or dates, where every row is its own group.
 */
function categoryFields(fields: FeatureField[]): Array<{ name: string; label: string }> {
  return fields
    .filter((f) => f.type === 'string' || f.type === 'boolean' || f.domain?.type === 'coded-value' || f.domain?.type === 'coded-value-ref')
    .map((f) => ({ name: f.name, label: f.label?.trim() || f.name }));
}

/**
 * Resolve each screenable layer's schema: geometry, the fields a
 * result can be broken down by, and pick-list labels so a breakdown
 * reads "Rural Residential" rather than the stored code.
 *
 * One fetch per item, not per layer: sublayers share a document. The
 * item read goes through the BFF, which falls back to the public
 * mirror for a signed-out visitor, so this works on public maps too.
 */
export function useScreenLayers(mapLayers: MapLayer[], enabled: boolean): {
  layers: ScreenLayerInfo[];
  loading: boolean;
} {
  const candidates = useMemo(() => screenableMapLayers(mapLayers), [mapLayers]);
  // A stable key so a re-render with the same layers does not refetch.
  const key = candidates
    .map((l) => {
      const src = l.source as { itemId: string; layerKey: string };
      return `${l.id}|${src.itemId}|${src.layerKey}|${l.title}|${l.labels.template}|${l.search.fields.join(',')}`;
    })
    .join('\n');
  const [state, setState] = useState<{ key: string; layers: ScreenLayerInfo[] }>({
    key: '',
    layers: [],
  });

  useEffect(() => {
    if (!enabled) return;
    if (state.key === key) return;
    const controller = new AbortController();
    void (async () => {
      const itemIds = [
        ...new Set(candidates.map((l) => (l.source as { itemId: string }).itemId)),
      ];
      const docs = new Map<string, ItemDoc>();
      await Promise.all(
        itemIds.map(async (id) => {
          try {
            const res = await fetch(`/api/portal/items/${id}`, { signal: controller.signal });
            if (res.ok) docs.set(id, (await res.json()) as ItemDoc);
          } catch {
            /* unreadable item: the layer is left out below */
          }
        }),
      );
      // Pick lists referenced by any field, fetched once each.
      const pickListIds = new Set<string>();
      for (const doc of docs.values()) {
        for (const sub of doc.data?.layers ?? []) {
          for (const f of sub.fields ?? []) {
            if (f.domain?.type === 'coded-value-ref') pickListIds.add(f.domain.pickListItemId);
          }
        }
      }
      const pickLists = new Map<string, Record<string, string>>();
      await Promise.all(
        [...pickListIds].map(async (id) => {
          try {
            const res = await fetch(`/api/portal/items/${id}`, { signal: controller.signal });
            if (!res.ok) return;
            const item = (await res.json()) as {
              data?: { entries?: Array<{ code?: unknown; label?: unknown }> };
            };
            const map: Record<string, string> = {};
            for (const e of item.data?.entries ?? []) {
              if (typeof e.code === 'string' && typeof e.label === 'string') map[e.code] = e.label;
            }
            pickLists.set(id, map);
          } catch {
            /* labels fall back to the stored code */
          }
        }),
      );
      if (controller.signal.aborted) return;

      const out: ScreenLayerInfo[] = [];
      for (const l of candidates) {
        const src = l.source as { itemId: string; layerKey: string };
        const sub = docs.get(src.itemId)?.data?.layers?.find((s) => s.id === src.layerKey);
        // A layer whose document did not load is left out rather than
        // screened blind: without its geometry we cannot say what to
        // measure, and a row of zeros would read as "nothing here".
        if (!sub) continue;
        const gt = sub.geometryType;
        // Tables have no shape to test against an area.
        if (gt !== 'point' && gt !== 'line' && gt !== 'polygon') continue;
        const fields = sub.fields ?? [];
        const codeLabels: CodeLabels = {};
        for (const f of fields) {
          if (f.domain?.type === 'coded-value') {
            codeLabels[f.name] = Object.fromEntries(
              f.domain.values.map((v) => [String(v.code), v.label]),
            );
          } else if (f.domain?.type === 'coded-value-ref') {
            const labels = pickLists.get(f.domain.pickListItemId);
            if (labels) codeLabels[f.name] = labels;
          }
        }
        const labelField = pickLabelField(l, fields);
        out.push({
          mapLayerId: l.id,
          title: l.title,
          itemId: src.itemId,
          layerKey: src.layerKey,
          geometry: gt as ScreenGeometry,
          categoryFields: categoryFields(fields),
          labelField,
          codeLabels,
        });
      }
      setState({ key, layers: out });
    })();
    return () => controller.abort();
  }, [enabled, key, candidates, state.key]);

  return { layers: state.layers, loading: enabled && state.key !== key };
}
