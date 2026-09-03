// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  describeViolations,
  validateFeatureProperties,
} from './feature-validate.js';
import type { FeatureField } from './data-layer.js';

/**
 * The cases that matter here are the ones where "reject" and "coerce"
 * are both defensible. Each of those has a comment naming the real
 * writer whose behaviour decided it, because the alternative reading
 * is not obviously wrong and someone will revisit this.
 */

const field = (over: Partial<FeatureField> & { name: string }): FeatureField => ({
  type: 'string',
  label: '',
  nullable: true,
  ...over,
});

const ok = (r: ReturnType<typeof validateFeatureProperties>) => {
  expect(r.violations.map((v) => `${v.field}:${v.code}`)).toEqual([]);
  expect(r.ok).toBe(true);
  return r.value;
};

describe('no schema', () => {
  it('passes everything through when the layer declares no fields', () => {
    const r = validateFeatureProperties(undefined, { anything: { deep: 1 } });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ anything: { deep: 1 } });
  });

  it('treats an empty field list the same way', () => {
    expect(validateFeatureProperties([], { a: 1 }).ok).toBe(true);
  });
});

describe('lossless coercion', () => {
  const fields = [
    field({ name: 'osm_id', type: 'string' }),
    field({ name: 'height_m', type: 'number' }),
    field({ name: 'open', type: 'boolean' }),
  ];

  it('numbers into a text field become text', () => {
    // The OSM save-as-layer path writes the raw numeric id into a
    // string-declared column; all 4,734 Elkins buildings look like
    // this. Rejecting would break a shipped importer over a difference
    // with exactly one sensible answer.
    const v = ok(validateFeatureProperties(fields, { osm_id: 310593699 }));
    expect(v.osm_id).toBe('310593699');
  });

  it('numeric text into a number field becomes a number', () => {
    expect(ok(validateFeatureProperties(fields, { height_m: ' 8.5 ' })).height_m).toBe(8.5);
  });

  it('refuses text a number field cannot read', () => {
    const r = validateFeatureProperties(fields, { height_m: '12abc' });
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.code).toBe('type');
  });

  it('refuses a boolean in a number field even though every language would cast it', () => {
    // true -> 1 does not preserve meaning, only syntax.
    expect(validateFeatureProperties(fields, { height_m: true }).ok).toBe(false);
  });

  it('refuses NaN and Infinity in a number field', () => {
    expect(validateFeatureProperties(fields, { height_m: Number.NaN }).ok).toBe(false);
    expect(validateFeatureProperties(fields, { height_m: '1e999' }).ok).toBe(false);
  });

  it('reads the usual spellings of yes and no', () => {
    for (const [raw, want] of [
      ['true', true],
      ['No', false],
      ['1', true],
      [0, false],
    ] as const) {
      expect(ok(validateFeatureProperties(fields, { open: raw })).open).toBe(want);
    }
    expect(validateFeatureProperties(fields, { open: 'maybe' }).ok).toBe(false);
  });

  it('refuses an object where text is declared', () => {
    // The water-quality measurements layer declares sample_date as
    // text and holds {day, year, month} in all 285,788 rows. There is
    // no honest coercion, so this stays a rejection and the data is a
    // repair job.
    const r = validateFeatureProperties(
      [field({ name: 'sample_date' })],
      { sample_date: { day: 1, year: 2000, month: 8 } },
    );
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.code).toBe('type');
  });
});

describe('dates', () => {
  const fields = [field({ name: 'submitted_at', type: 'date' })];

  it('keeps a readable ISO string as authored', () => {
    const v = ok(validateFeatureProperties(fields, { submitted_at: '2026-06-14T11:30:00.000Z' }));
    expect(v.submitted_at).toBe('2026-06-14T11:30:00.000Z');
  });

  it('normalises a Date instance to ISO', () => {
    const v = ok(validateFeatureProperties(fields, { submitted_at: new Date(0) }));
    expect(v.submitted_at).toBe('1970-01-01T00:00:00.000Z');
  });

  it('refuses an epoch number because seconds and milliseconds are indistinguishable', () => {
    expect(validateFeatureProperties(fields, { submitted_at: 1750000000 }).ok).toBe(false);
  });

  it('refuses unparseable text', () => {
    expect(validateFeatureProperties(fields, { submitted_at: 'last tuesday' }).ok).toBe(false);
  });
});

describe('multi_select', () => {
  const fields = [field({ name: 'tags', type: 'multi_select' })];

  it('accepts a list and stringifies entries', () => {
    expect(ok(validateFeatureProperties(fields, { tags: ['a', 2] })).tags).toEqual(['a', '2']);
  });

  it('splits comma-separated text, which is the documented export shape', () => {
    expect(ok(validateFeatureProperties(fields, { tags: 'a, b ,c' })).tags).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('refuses a nested object inside the list', () => {
    expect(validateFeatureProperties(fields, { tags: [{ a: 1 }] }).ok).toBe(false);
  });
});

describe('required', () => {
  const fields = [
    field({ name: 'name', nullable: false }),
    field({ name: 'notes' }),
  ];

  it('a patch is not judged on fields it does not mention', () => {
    expect(validateFeatureProperties(fields, { notes: 'x' }, { mode: 'patch' }).ok).toBe(true);
  });

  it('a create is judged on absence', () => {
    const r = validateFeatureProperties(fields, { notes: 'x' }, { mode: 'create' });
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.code).toBe('required');
  });

  it('blank text counts as no value, so a required field cannot be cleared with it', () => {
    expect(validateFeatureProperties(fields, { name: '   ' }).ok).toBe(false);
    expect(validateFeatureProperties(fields, { name: null }).ok).toBe(false);
  });

  it('clearing an optional field normalises blank text to null', () => {
    expect(ok(validateFeatureProperties(fields, { notes: '' })).notes).toBeNull();
  });
});

describe('domains', () => {
  const coded = field({
    name: 'severity',
    domain: { type: 'coded-value', values: [{ code: 'low', label: 'Low' }, { code: 'high', label: 'High' }] },
  });

  it('accepts a declared code and refuses anything else', () => {
    expect(validateFeatureProperties([coded], { severity: 'low' }).ok).toBe(true);
    const r = validateFeatureProperties([coded], { severity: 'urgent' });
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.code).toBe('domain');
  });

  it('compares numeric codes by their string form so 1 and "1" agree', () => {
    const numeric = field({
      name: 'grade',
      type: 'number',
      domain: { type: 'coded-value', values: [{ code: 1, label: 'One' }] },
    });
    expect(validateFeatureProperties([numeric], { grade: '1' }).ok).toBe(true);
  });

  it('checks every entry of a multi_select against the domain', () => {
    const multi = field({
      name: 'tags',
      type: 'multi_select',
      domain: { type: 'coded-value', values: [{ code: 'a', label: 'A' }] },
    });
    expect(validateFeatureProperties([multi], { tags: 'a' }).ok).toBe(true);
    expect(validateFeatureProperties([multi], { tags: 'a,b' }).ok).toBe(false);
  });

  it('resolves a coded-value-ref from the supplied pick lists', () => {
    const ref = field({
      name: 'kind',
      domain: { type: 'coded-value-ref', pickListItemId: 'pl-1' },
    });
    const pickLists = { 'pl-1': [{ code: 'tree' }] };
    expect(validateFeatureProperties([ref], { kind: 'tree' }, { pickLists }).ok).toBe(true);
    expect(validateFeatureProperties([ref], { kind: 'rock' }, { pickLists }).ok).toBe(false);
  });

  it('lists allowed codes for an inline domain but never for a pick-list reference', () => {
    // The layer schema the caller can read already contains inline
    // codes, so naming them is help. A referenced pick list is a
    // separate item the caller may not be able to open, and this
    // module resolves it with no share check; enumerating its codes
    // in a 400 would leak any pick list an author can name.
    const inline = validateFeatureProperties([coded], { severity: 'urgent' });
    expect(inline.violations[0]?.message).toContain('allowed: low, high');

    const ref = field({
      name: 'kind',
      domain: { type: 'coded-value-ref', pickListItemId: 'pl-1' },
    });
    const r = validateFeatureProperties(
      [ref],
      { kind: 'rock' },
      { pickLists: { 'pl-1': [{ code: 'tree' }, { code: 'shrub' }] } },
    );
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.message).not.toContain('tree');
    expect(r.violations[0]?.message).not.toContain('allowed');
  });

  it('leaves an unresolvable coded-value-ref unchecked rather than blocking every edit', () => {
    // A deleted or unreadable pick list must not make the layer
    // read-only by accident. Same reasoning as a missing geo_boundary
    // resolving to "no clip".
    const ref = field({
      name: 'kind',
      domain: { type: 'coded-value-ref', pickListItemId: 'gone' },
    });
    expect(validateFeatureProperties([ref], { kind: 'anything' }).ok).toBe(true);
  });

  it('enforces a numeric range', () => {
    const ranged = field({ name: 'ph', type: 'number', domain: { type: 'range', min: 0, max: 14 } });
    expect(validateFeatureProperties([ranged], { ph: 7.2 }).ok).toBe(true);
    const r = validateFeatureProperties([ranged], { ph: 15 });
    expect(r.violations[0]?.code).toBe('range');
  });
});

describe('storage hints', () => {
  it('enforces maxLength after coercion, not before', () => {
    const f = field({ name: 'code', storage: { maxLength: 3 } });
    expect(validateFeatureProperties([f], { code: 1234 }).violations[0]?.code).toBe('max-length');
    expect(validateFeatureProperties([f], { code: 12 }).ok).toBe(true);
  });

  it('enforces whole numbers on an integer field', () => {
    const f = field({ name: 'lanes', type: 'number', storage: { numberKind: 'integer' } });
    expect(validateFeatureProperties([f], { lanes: 2.5 }).violations[0]?.code).toBe('precision');
    expect(validateFeatureProperties([f], { lanes: '2' }).ok).toBe(true);
  });
});

describe('unknown keys', () => {
  const fields = [field({ name: 'issue_type' })];

  it('reports undeclared keys without rejecting or dropping them', () => {
    // The form runtime writes `location` plus a `_`-prefixed envelope
    // onto its submissions layer. Rejecting breaks the field app;
    // dropping loses the submission's coordinates.
    const r = validateFeatureProperties(fields, {
      issue_type: 'signage',
      location: { lat: 38.9, lng: -79.7 },
      _client_id: 'sample-sub-4',
    });
    expect(r.ok).toBe(true);
    expect(r.unknownFields).toEqual(['location']);
    expect(r.value.location).toEqual({ lat: 38.9, lng: -79.7 });
    expect(r.value._client_id).toBe('sample-sub-4');
  });
});

describe('hostile shapes', () => {
  it('refuses a field named __proto__ instead of re-pointing the result prototype', () => {
    // Spread treats __proto__ as an ordinary own key, but a bracket
    // assignment on a plain object invokes the Object.prototype
    // setter. A field name is author-editable item.data, so it is
    // untrusted here even though it is not request input.
    const f = field({ name: '__proto__', type: 'multi_select' });
    const r = validateFeatureProperties([f], { __proto__: ['x'] } as Record<string, unknown>);
    expect(r.ok).toBe(false);
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
  });

  it('caps a multi_select list rather than validating it unbounded', () => {
    const f = field({ name: 'tags', type: 'multi_select' });
    const r = validateFeatureProperties([f], { tags: Array.from({ length: 501 }, () => 'a') });
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.message).toContain('at most 500');
  });
});

describe('the returned value', () => {
  it('carries the coercions, so a caller that persists the input instead loses them', () => {
    const fields = [field({ name: 'n', type: 'number' })];
    const input = { n: '5' };
    const r = validateFeatureProperties(fields, input);
    expect(r.value.n).toBe(5);
    expect(input.n).toBe('5');
  });
});

describe('describeViolations', () => {
  it('is empty for a clean result and truncates a long one', () => {
    expect(describeViolations([])).toBe('');
    const many = Array.from({ length: 7 }, (_, i) => ({
      field: `f${i}`,
      code: 'type' as const,
      message: `m${i}`,
    }));
    expect(describeViolations(many)).toBe('m0 m1 m2 m3 m4 (and 2 more.)');
  });
});
