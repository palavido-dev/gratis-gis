// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FormSchema } from '@gratis-gis/form-schema';
import {
  pickRowTitle,
  withoutMapGeometryAnswer,
  withoutMapGeometryQuestion,
} from './field-form';

const form = {
  schemaVersion: 1,
  id: 'f1',
  title: 'Issue report',
  geometryQuestionId: 'location',
  questions: [
    { id: 'location', type: 'geopoint', label: 'Where?', required: true },
    { id: 'issue_type', type: 'text', label: 'Issue' },
    {
      id: 'more',
      type: 'group',
      label: 'More',
      children: [
        { id: 'nested_location', type: 'geopoint', label: 'Also where?' },
        { id: 'note', type: 'text', label: 'Note' },
      ],
    },
  ],
} as unknown as FormSchema;

describe('withoutMapGeometryQuestion', () => {
  it('drops the location question and keeps the rest', () => {
    const out = withoutMapGeometryQuestion(form);
    expect(out.questions.map((q) => q.id)).toEqual(['issue_type', 'more']);
    expect(out.geometryQuestionId).toBe('location');
    expect(form.questions).toHaveLength(3);
  });

  it('finds the location question inside a group', () => {
    const nested = { ...form, geometryQuestionId: 'nested_location' } as FormSchema;
    const out = withoutMapGeometryQuestion(nested);
    const group = out.questions.find((q) => q.id === 'more') as unknown as {
      children: Array<{ id: string }>;
    };
    expect(group.children.map((q) => q.id)).toEqual(['note']);
    expect(out.questions.map((q) => q.id)).toContain('location');
  });

  it('returns the same form when none is named', () => {
    const { geometryQuestionId: _g, ...plain } = form;
    void _g;
    expect(withoutMapGeometryQuestion(plain as FormSchema)).toBe(plain);
  });
});

describe('withoutMapGeometryAnswer', () => {
  it('drops the location answer', () => {
    const r = { location: { lat: 1, lon: 2 }, issue_type: 'washout' };
    expect(withoutMapGeometryAnswer(form, r)).toEqual({ issue_type: 'washout' });
  });

  it('returns the same response when there is nothing to drop', () => {
    const r = { issue_type: 'washout' };
    expect(withoutMapGeometryAnswer(form, r)).toBe(r);
  });
});

describe('pickRowTitle', () => {
  it('skips objects and arrays', () => {
    expect(
      pickRowTitle({ location: { lat: 1, lon: 2 }, photos: ['a'], issue_type: 'Washout' }),
    ).toBe('Washout');
  });

  it('skips system keys, blanks and UUIDs', () => {
    expect(
      pickRowTitle({
        _created_by: 'matt',
        parent_id: '3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
        blank: '  ',
        count: 4,
      }),
    ).toBe('4');
  });

  it('shortens long values and returns null when nothing fits', () => {
    expect(pickRowTitle({ d: 'x'.repeat(80) })).toBe(`${'x'.repeat(57)}...`);
    expect(pickRowTitle({ location: { lat: 1 } })).toBeNull();
  });
});
