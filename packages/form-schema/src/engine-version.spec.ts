// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BUILTINS,
  BUILTIN_ENGINE_VERSION,
  ENGINE_VERSION,
  EXPRESSION_OP_ENGINE_VERSION,
  FORM_SCHEMA_ENGINE_VERSION,
  QUESTION_TYPES,
  QUESTION_TYPE_ENGINE_VERSION,
  CURRENT_FORM_SCHEMA_VERSION,
  engineRequirement,
  engineSupports,
  requiredEngineVersion,
  type FormSchema,
  type Question,
} from './index.js';

/**
 * These pin the contract a shipped native client relies on: every
 * feature the evaluator knows has a registered introduction version,
 * nothing is registered ahead of ENGINE_VERSION, and anything a form
 * carries that this build does not know resolves to "newer than me".
 */

function form(questions: Question[], over: Partial<FormSchema> = {}): FormSchema {
  return {
    schemaVersion: CURRENT_FORM_SCHEMA_VERSION,
    id: 'f',
    title: 'T',
    questions,
    ...over,
  };
}

const q = (over: Partial<Question> & { id: string }): Question =>
  ({ type: 'text', label: 'Q', ...over }) as Question;

describe('engine version tables', () => {
  it('registers every question type', () => {
    for (const t of QUESTION_TYPES) {
      expect(QUESTION_TYPE_ENGINE_VERSION[t]).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(QUESTION_TYPE_ENGINE_VERSION).sort()).toEqual(
      [...QUESTION_TYPES].sort(),
    );
  });

  it('registers every builtin', () => {
    for (const b of BUILTINS) {
      expect(BUILTIN_ENGINE_VERSION[b]).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(BUILTIN_ENGINE_VERSION).sort()).toEqual([...BUILTINS].sort());
  });

  it('registers the current form schema version', () => {
    expect(FORM_SCHEMA_ENGINE_VERSION[CURRENT_FORM_SCHEMA_VERSION]).toBeGreaterThanOrEqual(1);
  });

  it('never registers a feature ahead of ENGINE_VERSION', () => {
    // A table entry above ENGINE_VERSION would mean a feature shipped
    // without the bump that tells old clients to refuse it.
    const all = [
      ...Object.values(QUESTION_TYPE_ENGINE_VERSION),
      ...Object.values(EXPRESSION_OP_ENGINE_VERSION),
      ...Object.values(BUILTIN_ENGINE_VERSION),
      ...Object.values(FORM_SCHEMA_ENGINE_VERSION),
    ];
    expect(Math.max(...all)).toBeLessThanOrEqual(ENGINE_VERSION);
    expect(Number.isInteger(ENGINE_VERSION)).toBe(true);
    expect(ENGINE_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('requiredEngineVersion', () => {
  it('is 1 for an empty form', () => {
    expect(requiredEngineVersion(form([]))).toBe(1);
    expect(engineSupports(form([]))).toBe(true);
  });

  it('walks every expression slot on a question', () => {
    const f = form([
      q({
        id: 'a',
        type: 'number',
        visibleIf: { op: 'eq', left: { ref: 'b' }, right: { value: 1 } },
        required: { op: 'not', operand: { op: 'eq', left: { ref: 'b' }, right: { value: 2 } } },
        constraint: {
          op: 'between',
          value: { ref: 'a' },
          min: { value: 0 },
          max: { call: 'max_of', args: [{ value: 10 }, { ref: 'b' }] },
        },
        readOnly: { op: 'and', operands: [] },
        calculate: {
          op: 'if',
          condition: { op: 'or', operands: [] },
          then: { call: 'today' },
          else: { call: 'now' },
        },
      }),
    ]);
    const r = engineRequirement(f);
    expect(r.unknown).toEqual([]);
    expect(r.version).toBe(1);
  });

  it('walks into nested groups', () => {
    const f = form([
      {
        id: 'g',
        type: 'group',
        label: 'G',
        children: [
          {
            id: 'g2',
            type: 'group',
            label: 'G2',
            repeat: {},
            children: [q({ id: 'x', type: 'made-up' as 'text' })],
          },
        ],
      } as Question,
    ]);
    const r = engineRequirement(f);
    expect(r.unknown).toEqual(['question-type:made-up']);
    expect(r.version).toBe(ENGINE_VERSION + 1);
    expect(engineSupports(f)).toBe(false);
  });

  it('treats an unknown operator as newer than this build', () => {
    const f = form([
      q({
        id: 'a',
        visibleIf: { op: 'xor', operands: [] } as unknown as Question['visibleIf'],
      }),
    ]);
    const r = engineRequirement(f);
    expect(r.unknown).toEqual(['op:xor']);
    expect(r.version).toBe(ENGINE_VERSION + 1);
  });

  it('treats an unknown builtin as newer than this build, even nested', () => {
    const f = form([
      q({
        id: 'a',
        calculate: {
          op: 'concat',
          operands: [{ value: 'x' }, { call: 'sha256' as 'len', args: [{ ref: 'a' }] }],
        },
      }),
    ]);
    expect(engineRequirement(f).unknown).toEqual(['builtin:sha256']);
  });

  it('treats an unknown schema version as newer than this build', () => {
    const f = form([], { schemaVersion: 99 as 1 });
    const r = engineRequirement(f);
    expect(r.unknown).toEqual(['schema-version:99']);
    expect(engineSupports(f)).toBe(false);
  });

  it('reports each unknown feature once, sorted', () => {
    const f = form([
      q({ id: 'a', type: 'zzz' as 'text' }),
      q({ id: 'b', type: 'zzz' as 'text' }),
      q({ id: 'c', type: 'aaa' as 'text' }),
    ]);
    expect(engineRequirement(f).unknown).toEqual(['question-type:aaa', 'question-type:zzz']);
  });

  it('does not throw on malformed input', () => {
    expect(() =>
      engineRequirement({ questions: [null, 5, { type: 7 }] } as unknown as FormSchema),
    ).not.toThrow();
    expect(() => engineRequirement(undefined as unknown as FormSchema)).not.toThrow();
  });
});
