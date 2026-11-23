// SPDX-License-Identifier: AGPL-3.0-or-later
import { importLabelsAndPopup } from './web-map-json-import.service.js';

describe('importing ArcGIS labels and popups', () => {
  it('turns an Arcade label into an expression field the label shows', () => {
    const warnings: string[] = [];
    const r = importLabelsAndPopup({
      labeling: [{ labelExpressionInfo: { expression: 'return $feature.NAME + " (" + Round($feature.ACRES, 1) + " ac)"' } }],
      popup: undefined,
      layerTitle: 'Parcels',
      expressionsAllowed: true,
      warnings,
    });
    expect(warnings).toEqual([]);
    expect(r.labels.enabled).toBe(true);
    expect(r.labels.template).toBe('{{expr.label}}');
    expect(r.expressions[0]!.expression).toBe("$feature.NAME + ' (' + round($feature.ACRES, 1) + ' ac)'");
  });

  it('keeps legacy [FIELD] labels as a template', () => {
    const r = importLabelsAndPopup({
      labeling: [{ labelExpression: '[NAME] - [TYPE]' }],
      popup: undefined,
      layerTitle: 'L',
      expressionsAllowed: false,
      warnings: [],
    });
    expect(r.labels.template).toBe('{{NAME}} - {{TYPE}}');
  });

  it('carries popup expressions, title tokens and visible fields', () => {
    const warnings: string[] = [];
    const r = importLabelsAndPopup({
      labeling: undefined,
      popup: {
        title: '{NAME}: {expression/expr0}',
        expressionInfos: [
          { name: 'expr0', title: 'Inspections', expression: "Count(FeatureSetByRelationshipName($feature, 'inspections'))" },
          { name: 'expr1', title: 'Loop', expression: 'var n = 0; for (var f in x) { n++ } return n' },
        ],
        fieldInfos: [
          { fieldName: 'NAME', visible: true },
          { fieldName: 'HIDDEN', visible: false },
          { fieldName: 'expression/expr0', visible: true },
          { fieldName: 'expression/expr1', visible: true },
        ],
      },
      layerTitle: 'Nests',
      expressionsAllowed: true,
      warnings,
    });
    expect(r.popup.titleTemplate).toBe('{{NAME}}: {{expr.expr0}}');
    expect(r.popup.mode).toBe('picked');
    expect(r.popup.fields).toEqual(['NAME', 'expr.expr0']);
    expect(r.expressions).toEqual([
      { name: 'expr0', label: 'Inspections', expression: "count(related('inspections'))" },
    ]);
    expect(warnings[0]).toMatch(/Loop.*not translated/);
  });

  it('reports Arcade on layers that cannot compute it', () => {
    const warnings: string[] = [];
    importLabelsAndPopup({
      labeling: [{ labelExpressionInfo: { expression: '$feature.NAME' } }],
      popup: undefined,
      layerTitle: 'Remote',
      expressionsAllowed: false,
      warnings,
    });
    expect(warnings[0]).toMatch(/only imports on layers stored in this portal/);
  });
});
