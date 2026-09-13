// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import {
  ENGINE_VERSION,
  SURFACE_NAMES,
  call,
  type CallResult,
} from './index';

/**
 * The bundle is what ships, so the bundle is what gets tested. The
 * suite builds it, loads it into a bare `node:vm` context that has
 * only ES builtins (no console, no timers, no TextEncoder, no fetch),
 * and checks that every surface function answers through the string
 * entry point with the same result the TypeScript gives directly.
 * That is the closest Node gets to the embedded engine on the phone.
 */

const pkgDir = join(__dirname, '..');
const distFile = join(pkgDir, 'dist', 'gratis-field-engine.js');
const manifestFile = join(pkgDir, 'dist', 'engine-version.json');

interface EngineGlobal {
  call(name: string, argsJson: string): string;
  SURFACE_NAMES: string[];
  ENGINE_VERSION: number;
}

let engine: EngineGlobal;
let source: string;

beforeAll(() => {
  execFileSync(process.execPath, [join(pkgDir, 'build.mjs')], { stdio: 'pipe' });
  source = readFileSync(distFile, 'utf8');
  // A context created from an empty object has the ES builtins and
  // nothing else. If the bundle touches `console`, `setTimeout`,
  // `TextEncoder` or any host object, evaluation throws here.
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'gratis-field-engine.js' });
  engine = vm.runInContext('GratisFieldEngine', context) as EngineGlobal;
});

function viaBundle(name: string, args: unknown): CallResult {
  return JSON.parse(engine.call(name, JSON.stringify(args))) as CallResult;
}

function viaTs(name: string, args: unknown): CallResult {
  return JSON.parse(call(name, JSON.stringify(args))) as CallResult;
}

describe('bundle', () => {
  it('has no imports, requires, or platform globals', () => {
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\bconsole\./);
    expect(source).not.toMatch(/\bsetTimeout\b/);
    expect(source).not.toMatch(/\bTextEncoder\b/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/\bprocess\.env\b/);
  });

  it('exposes the same surface and version as the TypeScript', () => {
    expect(engine.ENGINE_VERSION).toBe(ENGINE_VERSION);
    expect([...engine.SURFACE_NAMES]).toEqual(SURFACE_NAMES);
  });

  it('writes a manifest that matches the file beside it', () => {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
      engineVersion: number;
      file: string;
      sha256: string;
      bytes: number;
    };
    expect(manifest.engineVersion).toBe(ENGINE_VERSION);
    expect(manifest.file).toBe('gratis-field-engine.js');
    const bytes = readFileSync(distFile);
    expect(manifest.bytes).toBe(bytes.length);
    expect(manifest.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('stays small', () => {
    // Guard against the bundle silently swallowing something large (a
    // whole package index, a data table). Raise deliberately.
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(200 * 1024);
  });
});

describe('call', () => {
  it('reports an unknown function as data, not an exception', () => {
    const r = viaBundle('nope', {});
    expect(r).toEqual({
      ok: false,
      error: { code: 'unknown-function', message: 'No such function: nope' },
    });
  });

  it('reports malformed JSON as data', () => {
    const r = JSON.parse(engine.call('engine.info', '{not json')) as CallResult;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('bad-argument');
  });

  it('rejects a non-object argument', () => {
    const r = JSON.parse(engine.call('engine.info', '[]')) as CallResult;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('bad-argument');
  });

  it('catches a throwing implementation', () => {
    // `form.validate` with a form whose questions is not an array
    // makes the walker throw; the host must get data back.
    const r = viaBundle('form.validate', { form: { questions: 5 }, response: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('threw');
  });
});

/**
 * One representative argument per surface function. The point is not
 * to test the implementations (their own packages do that) but to
 * prove each one is reachable through the bundle and agrees with the
 * TypeScript on the same input.
 */
const form = {
  schemaVersion: 1,
  id: 'f',
  title: 'T',
  questions: [
    { id: 'kind', type: 'select-one', label: 'Kind', required: true, choices: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ] },
    {
      id: 'count',
      type: 'integer',
      label: 'Count',
      visibleIf: { op: 'eq', left: { ref: 'kind' }, right: { value: 'a' } },
      constraint: { op: 'gte', left: { ref: 'count' }, right: { value: 0 } },
    },
    {
      id: 'double',
      type: 'calculated',
      label: 'Double',
      calculate: { op: 'mul', left: { ref: 'count' }, right: { value: 2 } },
    },
    {
      id: 'insp',
      type: 'group',
      label: 'Inspections',
      repeat: {},
      children: [{ id: 'note', type: 'text', label: 'Note', required: true }],
    },
  ],
};

const fields = [
  { name: 'kind', type: 'string', nullable: false },
  { name: 'count', type: 'integer' },
  { name: 'submitted_at', type: 'datetime' },
  { name: 'submitted_by', type: 'string' },
];

const row = {
  dataLayerId: 'dl',
  layerKey: 'pts',
  globalId: 'g1',
  queuedAt: '2026-09-13T10:00:00.000Z',
  syncStatus: 'failed',
  lastAttemptAt: '2026-09-13T10:00:10.000Z',
  retryCount: 2,
  ownerUserId: 'u1',
};

const cases: Array<[string, unknown]> = [
  ['engine.info', {}],
  ['form.requirement', { form }],
  ['form.validate', { form, response: { kind: 'a', count: -1, insp: [{}] } }],
  ['form.state', { form, response: { kind: 'b', insp: [{ note: 'x' }, {}] } }],
  ['form.applyCalculations', { form, response: { kind: 'a', count: 4 } }],
  ['form.pruneHidden', { form, response: { kind: 'b', count: 4, insp: [{ note: 'x' }] } }],
  [
    'form.fromLayer',
    {
      layer: { key: 'pts', label: 'Points', fields, popup: { hidden: ['count'] } },
      options: { dataLayerId: 'dl', formId: 'pts' },
    },
  ],
  [
    'feature.validate',
    { fields, properties: { kind: 'a', count: '7' }, options: { mode: 'create' } },
  ],
  [
    'feature.stamp',
    {
      fields,
      properties: { kind: 'a' },
      context: { userId: 'u1', capturedAt: '2026-09-13T09:00:00.000Z' },
    },
  ],
  ['feature.isServerStampedField', { name: 'submitted_by' }],
  [
    'filter.matches',
    {
      properties: { status: 'open' },
      filter: { combinator: 'all', clauses: [{ field: 'status', op: '!=', value: 'closed' }] },
    },
  ],
  [
    'queue.fold',
    {
      prior: { op: 'insert', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { a: 1 } },
      next: { op: 'update', geometry: null, properties: { b: 2 } },
    },
  ],
  [
    'queue.foldChain',
    {
      chain: [
        { op: 'insert', geometry: null, properties: { a: 1 } },
        { op: 'delete', geometry: null, properties: null },
      ],
    },
  ],
  ['queue.retryDelayMs', { retryCount: 3 }],
  ['queue.isClaimable', { row, nowMs: Date.parse('2026-09-13T10:00:20.000Z') }],
  [
    'queue.isClaimable',
    { row, nowMs: Date.parse('2026-09-13T10:00:20.000Z'), options: { ignoreBackoff: true } },
  ],
  ['queue.isOwnedBy', { row, currentUserId: 'u2' }],
  [
    'queue.chainHeads',
    {
      rows: [row, { ...row, queuedAt: '2026-09-13T09:00:00.000Z', syncStatus: 'pending', retryCount: 0, extra: 'kept' }],
      nowMs: Date.parse('2026-09-13T12:00:00.000Z'),
    },
  ],
  ['sync.outcome', { status: 404, op: 'delete' }],
  ['sync.outcome', { status: 422, op: 'insert' }],
  ['message.sanitize', { message: { code: 'sync.rejected', params: { status: 422 } } }],
  ['message.sanitize', { message: 'old client text' }],
];

describe('surface round-trips through the bundle', () => {
  it.each(cases)('%s', (name, args) => {
    const fromBundle = viaBundle(name, args);
    const fromTs = viaTs(name, args);
    expect(fromBundle.ok).toBe(true);
    expect(fromBundle).toEqual(fromTs);
  });

  it('covers every surface function', () => {
    const covered = new Set(cases.map(([name]) => name));
    expect([...covered].sort()).toEqual(SURFACE_NAMES);
  });

  it('produces the expected shapes on a few spot checks', () => {
    const v = viaBundle('form.validate', {
      form,
      response: { kind: 'a', count: -1, insp: [{}] },
    });
    expect(v.ok && v.result).toEqual({
      ok: false,
      errors: [
        { questionId: 'count', message: 'Value is not valid.' },
        { questionId: 'insp[0].note', message: 'This field is required.' },
      ],
    });

    const s = viaBundle('form.state', { form, response: { kind: 'b', insp: [{}, {}] } });
    expect(s.ok && s.result).toEqual({
      questions: [
        { path: 'kind', id: 'kind', visible: true, required: true, readOnly: false },
        { path: 'count', id: 'count', visible: false, required: false, readOnly: false },
        { path: 'double', id: 'double', visible: true, required: false, readOnly: true },
        { path: 'insp', id: 'insp', visible: true, required: false, readOnly: false },
        { path: 'insp[0].note', id: 'note', visible: true, required: true, readOnly: false },
        { path: 'insp[1].note', id: 'note', visible: true, required: true, readOnly: false },
      ],
    });

    const heads = viaBundle('queue.chainHeads', {
      rows: [row, { ...row, queuedAt: '2026-09-13T09:00:00.000Z', syncStatus: 'pending', retryCount: 0, extra: 'kept' }],
      nowMs: Date.parse('2026-09-13T12:00:00.000Z'),
    });
    // One head per feature, the oldest, with host fields carried through.
    expect(heads.ok && heads.result).toEqual([
      { ...row, queuedAt: '2026-09-13T09:00:00.000Z', syncStatus: 'pending', retryCount: 0, extra: 'kept' },
    ]);

    expect(viaBundle('sync.outcome', { status: 404, op: 'delete' })).toEqual({ ok: true, result: 'done' });
    expect(viaBundle('sync.outcome', { status: 422, op: 'insert' })).toEqual({ ok: true, result: 'rejected' });
  });
});
