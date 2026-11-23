// SPDX-License-Identifier: AGPL-3.0-or-later
import { evaluate, type FormSchema, type Question } from '@gratis-gis/form-schema';
import type { FeatureField } from '@gratis-gis/shared-types';

import { isFieldMapsMap, mapAreaToOfflineArea } from './field-maps-collection';
import { fieldMapsFormToSchema, type AgoFormInfo } from './field-maps-form';
import { mapAllowsEditing } from '../items/web-map-json-import.service';

const fields: FeatureField[] = [
  {
    name: 'status',
    label: 'Status',
    type: 'string',
    nullable: true,
    domain: {
      type: 'coded-value',
      values: [
        { code: 'open', label: 'Open' },
        { code: 'done', label: 'Done' },
      ],
    },
  },
  { name: 'height', label: 'Height', type: 'number', nullable: true },
  { name: 'notes', label: 'Notes', type: 'string', nullable: true },
  { name: 'inspected', label: 'Inspected', type: 'date', nullable: true },
  { name: 'tag', label: 'Tag', type: 'string', nullable: true },
];

function convert(formInfo: AgoFormInfo) {
  return fieldMapsFormToSchema({
    formInfo,
    dataLayerId: 'dl-1',
    layerKey: 'trees',
    layerTitle: 'Trees',
    fields,
    title: 'Survey: Trees',
  });
}

function find(form: FormSchema, id: string): Question {
  const walk = (qs: Question[]): Question | undefined => {
    for (const q of qs) {
      if (q.id === id) return q;
      if (q.type === 'group') {
        const hit = walk(q.children);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const q = walk(form.questions);
  if (!q) throw new Error(`no question ${id}`);
  return q;
}

describe('fieldMapsFormToSchema', () => {
  it('keeps the Field Maps order, labels, groups and controls', () => {
    const { form, warnings } = convert({
      title: 'Tree inspection',
      formElements: [
        {
          type: 'field',
          fieldName: 'HEIGHT',
          label: 'Height (ft)',
          description: 'Estimate is fine',
        },
        {
          type: 'group',
          label: 'Details',
          formElements: [
            { type: 'field', fieldName: 'status', inputType: { type: 'radio-buttons' } },
            { type: 'field', fieldName: 'notes', inputType: { type: 'text-area' } },
            { type: 'field', fieldName: 'tag', inputType: { type: 'barcode-scanner' } },
            {
              type: 'field',
              fieldName: 'inspected',
              inputType: { type: 'datetime-picker', includeTime: false },
            },
          ],
        },
        { type: 'text', text: '**Check the trunk**', textFormat: 'markdown' },
        { type: 'attachment', label: 'Photos' },
      ],
    });
    expect(form).not.toBeNull();
    expect(form!.title).toBe('Tree inspection');
    expect(form!.linkedLayerId).toBe('dl-1');
    expect(form!.questions.map((q) => q.type)).toEqual(['number', 'group', 'note']);
    const height = find(form!, 'height');
    expect(height.label).toBe('Height (ft)');
    expect(height.hint).toBe('Estimate is fine');
    expect(height.bindTo).toEqual({ layerKey: 'trees', column: 'height' });
    expect(find(form!, 'status')).toMatchObject({ type: 'select-one', appearance: 'radio' });
    expect(find(form!, 'notes').type).toBe('multiline');
    expect(find(form!, 'tag').type).toBe('barcode');
    expect(find(form!, 'inspected').type).toBe('date');
    expect(warnings.some((w) => w.includes('attachment element'))).toBe(true);
  });

  it('turns Arcade rules into form rules that evaluate', () => {
    const { form, warnings } = convert({
      expressionInfos: [
        { name: 'tall', expression: '$feature.height >= 50' },
        { name: 'open', expression: "$feature.status == 'open' && !IsEmpty($feature.notes)" },
        { name: 'locked', expression: "IIf($feature.status == 'done', false, true)" },
        { name: 'listed', expression: "Includes(['open', 'done'], $feature.status)" },
        { name: 'among', expression: "$feature.status IN ('open', 'done')" },
      ],
      formElements: [
        { type: 'field', fieldName: 'height' },
        { type: 'field', fieldName: 'notes', visibilityExpression: 'tall' },
        {
          type: 'field',
          fieldName: 'tag',
          requiredExpression: 'open',
          editableExpression: 'locked',
        },
        { type: 'field', fieldName: 'inspected', visibilityExpression: 'among' },
      ],
    });
    const notes = find(form!, 'notes');
    expect(evaluate(notes.visibleIf, { height: 60 })).toBe(true);
    expect(evaluate(notes.visibleIf, { height: 10 })).toBe(false);
    const tag = find(form!, 'tag');
    expect(evaluate(tag.required as never, { status: 'open', notes: 'x' })).toBe(true);
    expect(evaluate(tag.required as never, { status: 'open', notes: '' })).toBe(false);
    expect(evaluate(tag.readOnly as never, { status: 'done' })).toBe(true);
    expect(evaluate(tag.readOnly as never, { status: 'open' })).toBe(false);
    expect(evaluate(find(form!, 'inspected').visibleIf, { status: 'done' })).toBe(true);
    expect(evaluate(find(form!, 'inspected').visibleIf, { status: 'x' })).toBe(false);
    // `status` is read by a rule but not shown, so it rides along hidden.
    expect(find(form!, 'status').type).toBe('hidden');
    expect(warnings).toEqual([]);
  });

  it('drops a rule it cannot convert and says what happens instead', () => {
    const { form, warnings } = convert({
      expressionInfos: [
        { name: 'related', expression: "Count(FeatureSetByName($map, 'Visits')) > 0" },
      ],
      formElements: [{ type: 'field', fieldName: 'notes', requiredExpression: 'related' }],
    });
    expect(find(form!, 'notes').required).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/required rule .* It is optional\./);
    // The failed rule's fields are not carried as hidden questions.
    expect(form!.questions).toHaveLength(1);
  });

  it('carries a calculated value and makes the field read only', () => {
    const { form } = convert({
      expressionInfos: [
        { name: 'calc', expression: "Concatenate($feature.status, '-', $feature.tag)" },
      ],
      formElements: [{ type: 'field', fieldName: 'notes', valueExpression: 'calc' }],
    });
    const notes = find(form!, 'notes');
    expect(notes.readOnly).toBe(true);
    expect(evaluate(notes.calculate, { status: 'open', tag: 'A1' })).toBe('open-A1');
  });

  it('marks a field that Field Maps does not let crews edit as read only', () => {
    const { form } = convert({
      formElements: [{ type: 'field', fieldName: 'notes', editable: false }],
    });
    expect(find(form!, 'notes').readOnly).toBe(true);
  });

  it('returns no form when none of the listed fields exist', () => {
    const { form, warnings } = convert({ formElements: [{ type: 'field', fieldName: 'missing' }] });
    expect(form).toBeNull();
    expect(warnings[0]).toMatch(/"missing"/);
  });
});

describe('Field Maps map detection', () => {
  const editable = { dataLayerItemId: 'd', layerKey: 'k', title: 'T', editable: true };
  it('needs an editable layer and a sign of field use', () => {
    expect(isFieldMapsMap(['Collector'], [editable])).toBe(true);
    expect(isFieldMapsMap([], [{ ...editable, formInfo: {} }])).toBe(true);
    expect(isFieldMapsMap([], [editable])).toBe(false);
    expect(isFieldMapsMap(['Collector'], [{ ...editable, editable: false }])).toBe(false);
    expect(isFieldMapsMap(['Collector', 'FieldMapsDisabled'], [editable])).toBe(false);
  });

  it('reads web map editing overrides', () => {
    expect(mapAllowsEditing(undefined)).toBe(true);
    expect(mapAllowsEditing('Query')).toBe(false);
    expect(mapAllowsEditing('Create,Query,Update')).toBe(true);
  });

  it('turns a map area extent into an offline area', () => {
    const area = mapAreaToOfflineArea({
      title: 'North unit',
      extent: [
        [-117.2, 33.9],
        [-117.0, 34.1],
      ],
    });
    expect(area).toMatchObject({
      name: 'North unit',
      bbox: [-117.2, 33.9, -117.0, 34.1],
      minZoom: 0,
      maxZoom: 14,
    });
    expect(
      mapAreaToOfflineArea({
        extent: [
          [1, 2],
          [0, 3],
        ],
      }),
    ).toBeNull();
    expect(mapAreaToOfflineArea({ extent: 'nope' })).toBeNull();
  });
});
