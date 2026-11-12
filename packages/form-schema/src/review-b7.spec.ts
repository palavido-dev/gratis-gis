// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  applyCalculations,
  evaluate,
  pruneHidden,
  validate,
  withEvaluationClock,
  type FormSchema,
} from './index.js';

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
