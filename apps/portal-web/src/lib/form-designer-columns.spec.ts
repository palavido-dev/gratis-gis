// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Question } from '@gratis-gis/form-schema';
import {
  validateFeatureProperties,
  type FeatureField,
} from '@gratis-gis/shared-types';
import {
  mergeQuestionFields,
  questionToFeatureField,
  type RawFeatureField,
} from './form-designer-columns';

const choices = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];

function valid(field: RawFeatureField, value: unknown): boolean {
  const out = validateFeatureProperties(
    [field as FeatureField],
    { [field.name]: value },
    { mode: 'create' },
  ) as { ok: boolean };
  return out.ok;
}

describe('questionToFeatureField', () => {
  it.each([
    { id: 'boxes', type: 'select-many', label: 'Boxes', choices },
    { id: 'rank', type: 'ranking', label: 'Rank', choices },
    {
      id: 'pics',
      type: 'image-choice',
      label: 'Pics',
      multi: true,
      choices: choices.map((c) => ({ ...c, imageUrl: 'x' })),
    },
  ])('gives $type a column that accepts the list the runtime sends', (q) => {
    const field = questionToFeatureField(q as unknown as Question)!;
    expect(field.type).toBe('multi_select');
    expect(valid(field, ['a', 'b'])).toBe(true);
    expect(valid(field, [])).toBe(true);
    expect(valid(field, ['zzz'])).toBe(false);
  });

  it('keeps single image-choice as text', () => {
    const q = { id: 'p', type: 'image-choice', label: 'P', choices: [] } as unknown as Question;
    expect(questionToFeatureField(q)?.type).toBe('string');
  });
});

describe('mergeQuestionFields', () => {
  it('turns an old text column for a checkbox question into multi_select', () => {
    const existing: RawFeatureField[] = [
      { name: 'boxes', type: 'string', domain: { type: 'coded-value', values: [{ code: 'a', label: 'A' }] } },
    ];
    const wanted = [
      questionToFeatureField({ id: 'boxes', type: 'select-many', label: 'Boxes', choices } as Question)!,
    ];
    const out = mergeQuestionFields(existing, wanted);
    expect(out.changed).toBe(true);
    expect(out.fields[0]!.type).toBe('multi_select');
    expect(valid(out.fields[0]!, ['a', 'b'])).toBe(true);
  });

  it('adds new dropdown choices to the stored list and keeps old ones', () => {
    const existing: RawFeatureField[] = [
      {
        name: 'status',
        type: 'string',
        domain: {
          type: 'coded-value',
          values: [
            { code: 'open', label: 'Open' },
            { code: 'closed', label: 'Closed' },
          ],
        },
      },
    ];
    const q = {
      id: 'status',
      type: 'select-one',
      label: 'Status',
      choices: [
        { value: 'open', label: 'Open now' },
        { value: 'pending', label: 'Pending' },
      ],
    } as Question;
    const out = mergeQuestionFields(existing, [questionToFeatureField(q)!]);
    expect(out.changed).toBe(true);
    expect(out.added).toEqual([]);
    const field = out.fields[0]!;
    expect(valid(field, 'pending')).toBe(true);
    expect(valid(field, 'closed')).toBe(true);
    expect(field.domain).toEqual({
      type: 'coded-value',
      values: [
        { code: 'open', label: 'Open now' },
        { code: 'closed', label: 'Closed' },
        { code: 'pending', label: 'Pending' },
      ],
    });
  });

  it('reports no change when nothing differs, and adds missing columns', () => {
    const q = { id: 'status', type: 'select-one', label: 'S', choices } as Question;
    const f = questionToFeatureField(q)!;
    expect(mergeQuestionFields([f], [f]).changed).toBe(false);
    const out = mergeQuestionFields([], [f]);
    expect(out.changed).toBe(true);
    expect(out.added).toEqual([f]);
  });

  it('leaves a pick-list column alone', () => {
    const existing: RawFeatureField[] = [
      { name: 'status', type: 'string', domain: { type: 'coded-value-ref', pickListItemId: 'p' } },
    ];
    const q = { id: 'status', type: 'select-one', label: 'S', choices } as Question;
    expect(mergeQuestionFields(existing, [questionToFeatureField(q)!]).changed).toBe(false);
  });
});
