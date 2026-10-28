// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided Calculate geometry shortcut for the Analyze workbench
 * (R9-analyze-calculate-geometry-shortcut).
 *
 * Mirrors Densify / Buffer: Analyze never invents expression
 * helpers like area_m2(). It POSTs a single-step
 * `calculate-geometry` derived_layer recipe (measurement + unit +
 * fieldName) that runs PostGIS geography measures on the server.
 * Calculate field ({{field}} expressions) stays a separate builder
 * path.
 */
import {
  AREA_UNITS,
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  LENGTH_UNITS,
  UNIT_LABELS,
  AREA_UNIT_LABELS,
  type AreaUnit,
  type CalculateGeometryParams,
  type DerivedLayerData,
  type LengthUnit,
} from '@gratis-gis/shared-types';

const MAX_FIELD_NAME_LENGTH = 60;
const RESERVED_FIELD_NAMES = new Set([
  '_global_id',
  '_created_by',
  '_created_at',
  '_edited_by',
  '_edited_at',
  '_observation_id',
  'global_id',
]);

export type CalculateGeometryMeasurement = 'length' | 'perimeter' | 'area';

export interface CalculateGeometryGuideInput {
  sourceItemId: string;
  /** v3 sublayer id when the source is a multi-layer data_layer. */
  layerKey?: string;
  measurement: CalculateGeometryMeasurement;
  unit: LengthUnit | AreaUnit;
  fieldName: string;
}

export interface CalculateGeometryDerivedLayerCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
}

/** Validate field name the same way the API generator does. */
export function validateCalculateGeometryFieldName(
  fieldName: string,
): string | null {
  const name = fieldName.trim();
  if (!name) return 'Enter a field name.';
  if (name.length > MAX_FIELD_NAME_LENGTH) {
    return `Field name must be ${MAX_FIELD_NAME_LENGTH} characters or fewer.`;
  }
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    return 'Field name must start with a letter or underscore and contain only letters, numbers, and underscores.';
  }
  if (RESERVED_FIELD_NAMES.has(name)) {
    return `Field name "${name}" is reserved.`;
  }
  return null;
}

export function validateCalculateGeometryParams(
  measurement: CalculateGeometryMeasurement,
  unit: LengthUnit | AreaUnit,
  fieldName: string,
): string | null {
  if (
    measurement !== 'length' &&
    measurement !== 'perimeter' &&
    measurement !== 'area'
  ) {
    return 'Pick length, perimeter, or area.';
  }
  if (measurement === 'area') {
    if (!AREA_UNITS.includes(unit as AreaUnit)) {
      return 'Pick an area unit.';
    }
  } else if (!LENGTH_UNITS.includes(unit as LengthUnit)) {
    return 'Pick a length unit.';
  }
  return validateCalculateGeometryFieldName(fieldName);
}

export function buildCalculateGeometryParams(
  measurement: CalculateGeometryMeasurement,
  unit: LengthUnit | AreaUnit,
  fieldName: string,
): CalculateGeometryParams {
  const name = fieldName.trim();
  if (measurement === 'area') {
    return {
      measurement: 'area',
      unit: unit as AreaUnit,
      fieldName: name,
    };
  }
  return {
    measurement,
    unit: unit as LengthUnit,
    fieldName: name,
  };
}

/** Single-step calculate-geometry recipe pointed at a data_layer. */
export function buildCalculateGeometryDerivedLayerData(
  input: CalculateGeometryGuideInput,
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
        tool: 'calculate-geometry',
        params: buildCalculateGeometryParams(
          input.measurement,
          input.unit,
          input.fieldName,
        ),
      },
    ],
    featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
    outputSchema: [],
    bbox: [],
  };
}

function unitLabel(unit: LengthUnit | AreaUnit): string {
  if (unit in UNIT_LABELS) return UNIT_LABELS[unit as LengthUnit];
  return AREA_UNIT_LABELS[unit as AreaUnit];
}

/** Default title: "Parcels · area (ac)". */
export function defaultCalculateGeometryDerivedLayerTitle(
  sourceLabel: string,
  measurement: CalculateGeometryMeasurement,
  unit: LengthUnit | AreaUnit,
): string {
  const label = sourceLabel.trim() || 'Layer';
  return `${label} · ${measurement} (${unitLabel(unit)})`;
}

/** Body for `POST /api/portal/items` creating the derived layer. */
export function buildCalculateGeometryDerivedLayerCreatePayload(args: {
  title: string;
  sourceLabel: string;
  sourceItemId: string;
  layerKey?: string;
  measurement: CalculateGeometryMeasurement;
  unit: LengthUnit | AreaUnit;
  fieldName: string;
}): CalculateGeometryDerivedLayerCreatePayload {
  const title =
    args.title.trim() ||
    defaultCalculateGeometryDerivedLayerTitle(
      args.sourceLabel,
      args.measurement,
      args.unit,
    );
  return {
    type: 'derived_layer',
    title,
    description: `Server-side calculate-geometry of "${args.sourceLabel}" (${args.measurement} in ${args.unit} → ${args.fieldName.trim()}) via PostGIS geography. Created from the Analyze Calculate geometry guide; runs as a derived-layer job. Not Calculate field expressions.`,
    tags: [],
    access: 'private',
    data: buildCalculateGeometryDerivedLayerData({
      sourceItemId: args.sourceItemId,
      ...(args.layerKey ? { layerKey: args.layerKey } : {}),
      measurement: args.measurement,
      unit: args.unit,
      fieldName: args.fieldName,
    }),
  };
}
