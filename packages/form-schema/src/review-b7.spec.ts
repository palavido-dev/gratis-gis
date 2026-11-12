// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  applyCalculations,
  evaluate,
  pruneHidden,
  validate,
  withEvaluationClock,
  type FormSchema,
} from './index.js';
import { generateFormFromLayer } from './from-layer.js';
import { importXlsForm } from './xlsform-import.js';

const form = (questions: unknown[]): FormSchema =>
  ({ schemaVersion: 1, id: 'f', title: 'F', questions }) as unknown as FormSchema;

describe('uploaded attachment answers', () => {
  it('accept the uploaded shape (url, no dataUrl) for file, audio and video', () => {
    const uploaded = [{ name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3, url: '/x', key: 'k' }];
    for (const type of ['file', 'audio', 'video']) {
      const r = validate(form([{ id: 'q', type, label: 'Q' }]), { q: uploaded });
      expect(r.ok).toBe(true);
    }
  });
});

describe('hidden non-repeat group', () => {
  const schema = form([
    { id: 'damage', type: 'boolean', label: 'Damage?' },
    {
      id: 'details',
      type: 'group',
      label: 'Details',
      visibleIf: { op: 'eq', left: { ref: 'damage' }, right: { value: true } },
      children: [{ id: 'detail', type: 'text', label: 'Detail', required: true }],
    },
  ]);

  it('does not validate or keep the children of a hidden group', () => {
    expect(validate(schema, { damage: false }).ok).toBe(true);
    expect(pruneHidden(schema, { damage: false, detail: 'stale' })).not.toHaveProperty('detail');
    expect(validate(schema, { damage: true }).ok).toBe(false);
  });
});

describe('comparisons against designer literals', () => {
  it('match a numeric literal against a string answer', () => {
    expect(evaluate({ op: 'eq', left: { ref: 'r' }, right: { value: 2 } } as never, { r: '2' })).toBe(true);
    expect(evaluate({ op: 'neq', left: { ref: 'r' }, right: { value: 2 } } as never, { r: '2' })).toBe(false);
    expect(evaluate({ op: 'gt', left: { ref: 'r' }, right: { value: 18 } } as never, { r: '100' })).toBe(true);
    expect(evaluate({ op: 'eq', left: { ref: 'r' }, right: { value: true } } as never, { r: 'true' })).toBe(true);
  });
});

describe('today() with an evaluation clock', () => {
  it('uses the capture moment and the respondent offset', () => {
    const expr = { op: 'eq', left: { call: 'today', args: [] }, right: { value: '2026-11-11' } } as never;
    // 01:00 UTC on the 12th is 17:00 on the 11th in California.
    const clock = { now: new Date('2026-11-12T01:00:00Z'), utcOffsetMinutes: -480 };
    expect(withEvaluationClock(clock, () => evaluate(expr, {}))).toBe(true);
    expect(withEvaluationClock({ ...clock, utcOffsetMinutes: 0 }, () => evaluate(expr, {}))).toBe(false);
  });
});

describe('url questions', () => {
  const schema = form([{ id: 'u', type: 'url', label: 'U', allowedProtocols: ['https'] }]);
  it('validates without the platform URL class', () => {
    const saved = (globalThis as { URL?: unknown }).URL;
    delete (globalThis as { URL?: unknown }).URL;
    try {
      expect(validate(schema, { u: 'https://example.org/a?b=1' }).ok).toBe(true);
      expect(validate(schema, { u: 'http://example.org' }).ok).toBe(false);
      expect(validate(schema, { u: 'not a url' }).ok).toBe(false);
      expect(validate(schema, { u: 'https://' }).ok).toBe(false);
    } finally {
      (globalThis as { URL?: unknown }).URL = saved;
    }
  });
});

describe('applyCalculations', () => {
  it('computes a calculation inside each repeat instance', () => {
    const schema = form([
      {
        id: 'rep',
        type: 'group',
        repeat: true,
        label: 'Lines',
        children: [
          { id: 'qty', type: 'number', label: 'Qty' },
          { id: 'tot', type: 'calculated', label: 'Total', calculate: { op: 'mul', left: { ref: 'qty' }, right: { value: 2 } } },
        ],
      },
    ]);
    const out = applyCalculations(schema, { rep: [{ qty: 3 }] });
    expect(out).toEqual({ rep: [{ qty: 3, tot: 6 }] });
  });

  it('takes a now() value once, so the response settles', () => {
    const schema = form([
      { id: 'at', type: 'calculated', label: 'At', calculate: { op: 'concat', operands: [{ call: 'now', args: [] }] } },
    ]);
    const first = applyCalculations(schema, {});
    expect(typeof first.at).toBe('string');
    expect(applyCalculations(schema, first)).toBe(first);
  });
});

describe('minor validation fixes', () => {
  it('name: a hidden Last name is not demanded', () => {
    const schema = form([{ id: 'n', type: 'name', label: 'N', required: true, components: ['first'] }]);
    expect(validate(schema, { n: { first: 'Ana' } }).ok).toBe(true);
  });

  it('acknowledge: unticked counts as unanswered, like untouched', () => {
    const schema = form([{ id: 'a', type: 'acknowledge', label: 'A', required: true }]);
    expect(validate(schema, {}).ok).toBe(false);
    expect(validate(schema, { a: { acknowledged: false } }).ok).toBe(false);
    expect(validate(schema, { a: { acknowledged: true } }).ok).toBe(true);
    const optional = form([{ id: 'a', type: 'acknowledge', label: 'A' }]);
    expect(validate(optional, { a: { acknowledged: false } }).ok).toBe(true);
  });

  it('malformed expressions read as no value instead of throwing', () => {
    expect(() => evaluate({ op: 'and' } as never, {})).not.toThrow();
    expect(() => evaluate({ op: 'eq', left: { ref: 'x' } } as never, {})).not.toThrow();
  });

  it('checks values the types promise', () => {
    const schema = form([
      { id: 's', type: 'select-one', label: 'S', choices: [{ value: 'a', label: 'A' }] },
      { id: 'r', type: 'rating', label: 'R', max: 5 },
      { id: 'sl', type: 'slider', label: 'Sl', min: 0, max: 10 },
      { id: 'd', type: 'date', label: 'D' },
      { id: 'g', type: 'geopoint', label: 'G' },
    ]);
    expect(validate(schema, { s: 'a', r: 4, sl: 5, d: '2026-11-12', g: { lat: 1, lng: 2 } }).ok).toBe(true);
    expect(validate(schema, { s: 'zz' }).ok).toBe(false);
    expect(validate(schema, { r: 999 }).ok).toBe(false);
    expect(validate(schema, { sl: 11 }).ok).toBe(false);
    expect(validate(schema, { d: 'not a date' }).ok).toBe(false);
    expect(validate(schema, { g: { any: 1 } }).ok).toBe(false);
  });

  it('generated layer forms skip server-stamped columns', () => {
    const f = generateFormFromLayer(
      {
        key: 'l',
        fields: [
          { name: 'submitted_at', type: 'date', nullable: false },
          { name: 'note', type: 'string' },
        ],
      } as never,
      { dataLayerId: 'x', formId: 'f' } as never,
    );
    const ids = JSON.stringify(f.questions);
    expect(ids).not.toContain('submitted_at');
    expect(ids).toContain('note');
  });

  it('XLSForm group relevant is kept and warned about', () => {
    const out = importXlsForm(
      {
        survey: [
          { type: 'begin_group', name: 'g', label: 'G', relevant: "${x} = 'yes'" },
          { type: 'text', name: 't', label: 'T' },
          { type: 'end_group' },
        ],
        choices: [],
        settings: [],
      } as never,
      { itemId: 'i' },
    );
    expect(JSON.stringify(out.schema.questions)).toContain('relevant');
    expect(out.warnings.join(' ')).toMatch(/group expressions/);
  });
});
