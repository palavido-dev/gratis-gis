// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Random sample shortcut for the Analyze workbench
 * (R10-analyze-random-sample-shortcut).
 *
 * Mirrors Top N / Densify: Analyze never invents an in-browser
 * sample. It POSTs a single-step `derived_layer` recipe with
 * mode + value + seed (same as randomSampleGenerator).
 */
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  type DerivedLayerData,
} from '@gratis-gis/shared-types';

/** Same hard cap as the random-sample generator in count mode. */
export const MAX_RANDOM_SAMPLE_COUNT = 100_000;

export type RandomSampleMode = 'percentage' | 'count';

export interface RandomSampleGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  mode: RandomSampleMode;
  value: number;
  seed: number;
}

export interface RandomSampleDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Roll a nonzero seed in the generator's accepted range. */
export function rollRandomSampleSeed(): number {
  return Math.floor(Math.random() * 2147483646) + 1;
}

/**
 * Normalize seed the same way randomSampleGenerator.validate does:
 * floor abs mod 2^31-1, substitute 1 when degenerate.
 */
export function normalizeRandomSampleSeed(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  const seed = Math.floor(Math.abs(raw)) % 2147483647;
  return seed === 0 ? 1 : seed;
}

/**
 * Validate random-sample params. Returns a plain-English reason when
 * unusable; null when ready to submit. The Analyze guide overlays
 * locale strings.
 */
export function validateRandomSampleParams(
  mode: RandomSampleMode,
  value: number,
  seed: number,
): string | null {
  if (mode !== 'percentage' && mode !== 'count') {
    return 'Pick percentage or count mode.';
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 'Value must be a positive number.';
  }
  if (mode === 'percentage' && value > 100) {
    return 'Percentage must be at most 100.';
  }
  if (mode === 'count') {
    if (!Number.isInteger(value)) {
      return 'Count must be a positive integer.';
    }
    if (value > MAX_RANDOM_SAMPLE_COUNT) {
      return `Count must be at most ${MAX_RANDOM_SAMPLE_COUNT.toLocaleString('en-US')}.`;
    }
  }
  if (!Number.isFinite(seed) || normalizeRandomSampleSeed(seed) < 1) {
    return 'Seed must be a nonzero integer.';
  }
  return null;
}

/** Single-step random-sample recipe pointed at a data_layer source. */
export function buildRandomSampleDerivedLayerData(
  input: RandomSampleGuideInput,
): DerivedLayerData {
  return {
    version: 1,
    source: {
      kind: 'data_layer',
      itemId: input.sourceItemId,
      ...(input.layerKey ? { layerKey: input.layerKey } : {}),
    },
    pipeline: [
      {
        tool: 'random-sample',
        params: {
          mode: input.mode,
          value: input.value,
          seed: normalizeRandomSampleSeed(input.seed),
        },
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

/** Default title: "Parcels · random 10%" or "Parcels · random 100". */
export function defaultRandomSampleDerivedLayerTitle(
  sourceLabel: string,
  mode: RandomSampleMode,
  value: number,
): string {
  const label = sourceLabel.trim() || 'Layer';
  if (mode === 'percentage') {
    const pct = Number.isFinite(value) ? value : 10;
    return `${label} · random ${pct}%`;
  }
  const count = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
  return `${label} · random ${count}`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildRandomSampleDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
  mode: RandomSampleMode;
  value: number;
  seed: number;
}): RandomSampleDerivedLayerCreatePayload {
  const seed = normalizeRandomSampleSeed(args.seed);
  const title =
    args.title.trim() ||
    defaultRandomSampleDerivedLayerTitle(
      args.sourceLabel,
      args.mode,
      args.value,
    );
  const how =
    args.mode === 'percentage'
      ? `roughly ${args.value}% of rows`
      : `exactly ${args.value} rows`;
  return {
    type: 'derived_layer',
    title,
    description: `Server-side random sample (${how}, seed ${seed}) of "${args.sourceLabel}". Created from the Analyze Random sample guide; runs as a PostGIS derived-layer job. Deterministic via md5(global_id||seed), not Postgres random().`,
    tags: [],
    access: 'private',
    data: buildRandomSampleDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      mode: args.mode,
      value: args.value,
      seed,
    }),
  };
}
