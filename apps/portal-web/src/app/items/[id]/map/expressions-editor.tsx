// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Expression fields for a map layer: named values computed for every
 * feature, used like fields as `expr.<name>` in labels, popups,
 * styling and filters. On a data layer the server computes them into
 * the vector tiles, so they can read related records, other layers
 * and nearby features.
 */

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  EXPRESSION_FIELD_PREFIX,
  fieldRefTypeFor,
  LAYER_EXPRESSION_NAME_RE,
  MAX_LAYER_EXPRESSIONS,
  type FieldRef,
  type MapLayer,
  type MapLayerExpression,
} from '@gratis-gis/shared-types';
import { ExpressionBuilder } from '@/components/expression-builder';
import { useT } from '@/lib/i18n/locale-context';

/** Declared fields of the layer's data-layer source, typed. */
function useSourceFields(layer: MapLayer, fallback: string[]): FieldRef[] {
  const [fields, setFields] = useState<FieldRef[] | null>(null);
  const src = layer.source.kind === 'data-layer' ? layer.source : null;
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    fetch(`/api/portal/items/${encodeURIComponent(src.itemId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((item: { data?: { layers?: Array<{ id: string; fields?: Array<{ name: string; type: string; label?: string }> }> } } | null) => {
        if (cancelled || !item) return;
        const l = item.data?.layers?.find((x) => x.id === src.layerKey) ?? item.data?.layers?.[0];
        if (!l?.fields) return;
        setFields(
          l.fields.map((f) => {
            const t = f.type === 'number' || f.type === 'boolean' || f.type === 'date' || f.type === 'multi_select' ? f.type : 'string';
            const ref: FieldRef = { name: f.name, type: fieldRefTypeFor(t) };
            if (f.label) ref.label = f.label;
            return ref;
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [src?.itemId, src?.layerKey]);
  return useMemo(
    () =>
      fields ??
      fallback.filter((n) => !n.startsWith('_') && !n.startsWith(EXPRESSION_FIELD_PREFIX)).map((name) => ({ name, type: 'unknown' as const })),
    [fields, fallback],
  );
}

export function ExpressionsEditor({
  layer,
  fieldNames,
  onChange,
}: {
  layer: MapLayer;
  /** Property names known for the layer, used until the schema loads. */
  fieldNames: string[];
  onChange: (next: MapLayerExpression[]) => void;
}) {
  const t = useT();
  const items = layer.expressions ?? [];
  const fields = useSourceFields(layer, fieldNames);
  const target =
    layer.source.kind === 'data-layer' && layer.source.layerKey
      ? { itemId: layer.source.itemId, layerId: layer.source.layerKey }
      : undefined;

  function patch(i: number, next: Partial<MapLayerExpression>) {
    onChange(items.map((x, k) => (k === i ? { ...x, ...next } : x)));
  }

  function add() {
    let n = items.length + 1;
    while (items.some((x) => x.name === `value_${n}`)) n += 1;
    onChange([...items, { name: `value_${n}`, label: '', expression: '' }]);
  }

  return (
    <div className="space-y-3">
      <p className="text-2xs text-muted">{t('mapLayerExpressions.intro')}</p>
      {!target ? <p className="text-2xs text-warn">{t('mapLayerExpressions.dataLayerOnly')}</p> : null}
      {items.map((x, i) => {
        const nameOk = LAYER_EXPRESSION_NAME_RE.test(x.name);
        const dup = items.some((y, k) => k !== i && y.name === x.name);
        return (
          <div key={i} className="space-y-2 rounded-md border border-border p-2">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-2xs uppercase tracking-wide text-muted">{t('mapLayerExpressions.name')}</span>
                <input
                  value={x.name}
                  onChange={(e) => patch(i, { name: e.target.value })}
                  maxLength={41}
                  className={`h-8 w-40 rounded-md border bg-surface-1 px-2 font-mono text-xs focus:outline-hidden ${
                    nameOk && !dup ? 'border-border focus:border-accent' : 'border-danger'
                  }`}
                />
              </label>
              <label className="flex min-w-[8rem] flex-1 flex-col gap-1">
                <span className="text-2xs uppercase tracking-wide text-muted">{t('mapLayerExpressions.label')}</span>
                <input
                  value={x.label ?? ''}
                  onChange={(e) => patch(i, { label: e.target.value })}
                  maxLength={80}
                  placeholder={x.name}
                  className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden"
                />
              </label>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, k) => k !== i))}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-2xs text-ink-1 hover:bg-surface-2"
                aria-label={t('mapLayerExpressions.remove')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {!nameOk || dup ? (
              <p className="text-2xs text-danger">
                {dup ? t('mapLayerExpressions.duplicateName') : t('mapLayerExpressions.badName')}
              </p>
            ) : (
              <p className="text-2xs text-muted">
                {t('mapLayerExpressions.useAs', { token: `{{${EXPRESSION_FIELD_PREFIX}${x.name}}}` })}
              </p>
            )}
            <ExpressionBuilder
              value={x.expression}
              onChange={(expression) => patch(i, { expression })}
              fields={fields}
              layer={target}
              expect="any"
              rows={2}
              placeholder="count(related('inspections'))"
            />
          </div>
        );
      })}
      {items.length < MAX_LAYER_EXPRESSIONS ? (
        <button
          type="button"
          onClick={add}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs text-ink-1 hover:bg-surface-2"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('mapLayerExpressions.add')}
        </button>
      ) : null}
    </div>
  );
}

/** Field names an editor should offer, with the layer's expression fields added. */
export function withExpressionFields(fields: string[], layer: MapLayer): string[] {
  const extra = (layer.expressions ?? [])
    .filter((x) => LAYER_EXPRESSION_NAME_RE.test(x.name) && x.expression.trim() !== '')
    .map((x) => `${EXPRESSION_FIELD_PREFIX}${x.name}`);
  return extra.length ? [...fields.filter((f) => !extra.includes(f)), ...extra] : fields;
}
