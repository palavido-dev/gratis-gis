// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The field list each derived-layer step reads from.
 *
 * Steps change the schema: calculate-field, calculate-geometry,
 * nearest-neighbor, vertices and spatial-join add a column, aggregate,
 * contour, fishnet and dissolve replace them all. The server validates
 * each step against the schema coming out of the step before it. The
 * builder used to hand every step the SOURCE fields, so a later step
 * could not pick a field an earlier one made, and a valid expression
 * that used one was shown as an error.
 *
 * This mirrors each tool's `outputSchema` in
 * apps/portal-api/src/derived-layers/tools. Keep the two in step.
 */
import type { FeatureField, ToolStep } from '@gratis-gis/shared-types';

function added(
  input: FeatureField[],
  name: string,
  type: FeatureField['type'],
  nullable = true,
): FeatureField[] {
  return [...input, { name, label: name, type, nullable }];
}

export function stepOutputSchema(
  input: FeatureField[],
  step: ToolStep,
): FeatureField[] {
  switch (step.tool) {
    case 'calculate-field':
      return added(input, step.params.outputName, step.params.outputType);
    case 'calculate-geometry':
      return added(input, step.params.fieldName, 'number');
    case 'nearest-neighbor':
      return added(input, 'nearest_distance_m', 'number');
    case 'vertices':
      return added(input, 'vertex_index', 'number', false);
    case 'spatial-join': {
      const prefix = step.params.attrPrefix ?? 'joined_';
      if (step.params.attributeStrategy === 'count') {
        return added(input, `${prefix}count`, 'number', false);
      }
      return (step.params.attrsToKeep ?? []).reduce(
        (acc, a) => added(acc, `${prefix}${a}`, 'string'),
        input,
      );
    }
    case 'aggregate': {
      const out: FeatureField[] = [];
      for (const g of step.params.groupBy) {
        const src = input.find((f) => f.name === g);
        out.push(
          src ? { ...src } : { name: g, label: g, type: 'string', nullable: true },
        );
      }
      for (const a of step.params.aggs) {
        const src = input.find((f) => f.name === a.field);
        out.push({
          name: a.outputName,
          label: a.outputName,
          type: a.op === 'first' ? (src?.type ?? 'string') : 'number',
          nullable: a.op === 'first' || a.op === 'avg' || a.op === 'sum',
        });
      }
      return out;
    }
    case 'contour':
      return [{ name: 'level', label: 'Contour level', type: 'number', nullable: false }];
    case 'fishnet':
      return [
        { name: 'cell_row', label: 'Row', type: 'number', nullable: false },
        { name: 'cell_col', label: 'Column', type: 'number', nullable: false },
      ];
    case 'dissolve':
      return [];
    default:
      // Every other tool changes geometry or rows, not attributes.
      return input;
  }
}

/** Input schema for each step: index i gets what step i-1 produced. */
export function stepInputSchemas(
  source: FeatureField[],
  pipeline: readonly ToolStep[],
): FeatureField[][] {
  const out: FeatureField[][] = [];
  let current = source;
  for (const step of pipeline) {
    out.push(current);
    current = stepOutputSchema(current, step);
  }
  return out;
}
