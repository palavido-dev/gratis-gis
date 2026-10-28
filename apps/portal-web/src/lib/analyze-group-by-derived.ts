// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Group-by shortcut for the Analyze workbench
 * (R11-analyze-group-by-shortcut).
 *
 * Analyze never invents an in-browser rollup. It POSTs a
 * single-step `aggregate` derived_layer recipe with at most one
 * group key (empty = whole-layer) and one aggregation (count, or
 * sum/avg on a numeric field). Multi-key / multi-agg stay in the
 * derived-layer builder. Geometry is always ST_Union per group.
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type AggregateStep,
  type AggOp,
  type DerivedLayerData,
  type FeatureField,
} from '@gratis-gis/shared-types';

/** Shortcut ops only — full set remains on the builder. */
export type GroupByShortcutOp = 'count' | 'sum' | 'avg';

export const GROUP_BY_SHORTCUT_OPS: readonly GroupByShortcutOp[] = [
  'count',
  'sum',
  'avg',
] as const;

export interface GroupByGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  /** Empty string = whole-layer rollup (groupBy: []). */
  groupKey: string;
  op: GroupByShortcutOp;
  /** Required for sum/avg; ignored for count. */
  aggField: string;
  outputName: string;
}

export interface GroupByDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

export function groupableFields(
  fields: FeatureField[] | undefined,
): FeatureField[] {
  return (fields ?? []).filter(
    (f) =>
      f.type === 'string' ||
      f.type === 'number' ||
      f.type === 'boolean' ||
      f.type === 'date',
  );
}

export function numericFieldsForGroupBy(
  fields: FeatureField[] | undefined,
): FeatureField[] {
  return (fields ?? []).filter((f) => f.type === 'number');
}

/** Suggest a stable output column name for the single aggregate. */
export function defaultGroupByOutputName(
  op: GroupByShortcutOp,
  aggField: string,
): string {
  if (op === 'count') return 'count';
  const f = aggField.trim() || 'value';
  return `${op}_${f}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 63);
}

/**
 * Validate group-by shortcut params. Returns a plain-English reason
 * when unusable; null when ready. The Analyze guide overlays locale
 * strings.
 */
export function validateGroupByParams(
  groupKey: string,
  op: GroupByShortcutOp,
  aggField: string,
  outputName: string,
  fields: FeatureField[] | undefined,
): string | null {
  if (!GROUP_BY_SHORTCUT_OPS.includes(op)) {
    return 'Pick count, sum, or avg.';
  }
  const key = groupKey.trim();
  if (key) {
    const match = groupableFields(fields).find((f) => f.name === key);
    if (!match) {
      return `Group key "${key}" is not a field on this layer.`;
    }
  }
  const out = outputName.trim();
  if (!out || !/^[a-z_][a-z0-9_]*$/i.test(out)) {
    return 'Output name must be a letter/underscore field id.';
  }
  if (key && out === key) {
    return 'Output name must not collide with the group key.';
  }
  if (op === 'sum' || op === 'avg') {
    const f = aggField.trim();
    if (!f) {
      return 'Pick a numeric field for sum or avg.';
    }
    const num = numericFieldsForGroupBy(fields).find((x) => x.name === f);
    if (!num) {
      return `Field "${f}" is not a numeric field on this layer.`;
    }
  }
  return null;
}

/** Single-step aggregate recipe pointed at a data_layer source. */
export function buildGroupByDerivedLayerData(
  input: GroupByGuideInput,
): DerivedLayerData {
  const key = input.groupKey.trim();
  const op = input.op;
  const aggField = op === 'count' ? '' : input.aggField.trim();
  const outputName =
    input.outputName.trim() || defaultGroupByOutputName(op, aggField);
  const params: AggregateStep['params'] = {
    groupBy: key ? [key] : [],
    aggs: [
      {
        field: aggField,
        op: op as AggOp,
        outputName,
      },
    ],
  };
  const step: AggregateStep = { tool: 'aggregate', params };
  return {
    version: 1,
    source: {
      kind: 'data_layer',
      itemId: input.sourceItemId,
      ...(input.layerKey ? { layerKey: input.layerKey } : {}),
    },
    pipeline: [step],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Parcels · group by zoning count". */
export function defaultGroupByDerivedLayerTitle(
  sourceLabel: string,
  groupKey: string,
  op: GroupByShortcutOp,
  aggField: string,
): string {
  const label = sourceLabel.trim() || 'Layer';
  const key = groupKey.trim();
  const keyPart = key ? `group by ${key}` : 'whole layer';
  const aggPart =
    op === 'count' ? 'count' : `${op} ${aggField.trim() || 'field'}`;
  return `${label} · ${keyPart} ${aggPart}`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildGroupByDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
  groupKey: string;
  op: GroupByShortcutOp;
  aggField: string;
  outputName: string;
}): GroupByDerivedLayerCreatePayload {
  const title =
    args.title.trim() ||
    defaultGroupByDerivedLayerTitle(
      args.sourceLabel,
      args.groupKey,
      args.op,
      args.aggField,
    );
  const key = args.groupKey.trim();
  const keyNote = key
    ? `Grouped by "${key}" (NULL is its own group).`
    : 'Whole-layer rollup (empty groupBy).';
  return {
    type: 'derived_layer',
    title,
    description: `Server-side group-by aggregate (${args.op}) of "${args.sourceLabel}". ${keyNote} Geometry is always ST_Union per group. Created from the Analyze Group-by guide; multi-key / multi-agg stay in Create → Derived layer.`,
    tags: [],
    access: 'private',
    data: buildGroupByDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      groupKey: args.groupKey,
      op: args.op,
      aggField: args.aggField,
      outputName: args.outputName,
    }),
  };
}
