// SPDX-License-Identifier: AGPL-3.0-or-later
import { scriptDraftDirty, storedScriptSource, type ScriptDraft } from './script-draft';

const base: ScriptDraft = {
  source: 'print(1)',
  notes: '',
  timeoutSeconds: 300,
  schedule: { mode: 'off' },
};

describe('scriptDraftDirty', () => {
  it('is clean when nothing changed', () => {
    expect(scriptDraftDirty(base, { ...base })).toBe(false);
  });

  it('counts a schedule change on its own', () => {
    expect(
      scriptDraftDirty(base, {
        ...base,
        schedule: { mode: 'daily', hour: 3, minute: 0 },
      }),
    ).toBe(true);
  });

  it('counts a time limit or a note change on its own', () => {
    expect(scriptDraftDirty(base, { ...base, timeoutSeconds: 120 })).toBe(true);
    expect(scriptDraftDirty(base, { ...base, notes: 'touches parcels' })).toBe(true);
  });

  it('ignores whitespace around notes, which save trims', () => {
    expect(scriptDraftDirty({ ...base, notes: 'x' }, { ...base, notes: ' x ' })).toBe(false);
  });
});

describe('storedScriptSource', () => {
  it('strips notebook outputs the way save does', () => {
    const nb = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          cell_type: 'code',
          source: ['print(1)'],
          metadata: {},
          execution_count: 3,
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
        },
      ],
    });
    const stored = storedScriptSource(nb);
    expect(stored).not.toBe(nb);
    expect(stored).not.toContain('stdout');
  });

  it('leaves plain Python alone', () => {
    expect(storedScriptSource('print(1)')).toBe('print(1)');
  });
});
