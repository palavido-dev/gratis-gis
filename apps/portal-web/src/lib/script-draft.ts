// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  looksLikeNotebook,
  normalizeScriptSchedule,
  stripNotebookOutputs,
  type ScriptSchedule,
} from '@gratis-gis/shared-types';

/**
 * The fields of a script item the detail panel edits and saves
 * (script/panel.tsx). Kept here so the dirty rule can be tested.
 */
export interface ScriptDraft {
  source: string;
  notes: string;
  timeoutSeconds: number;
  schedule: ScriptSchedule;
}

function scheduleKey(s: ScriptSchedule): string {
  return JSON.stringify(normalizeScriptSchedule(s) ?? { mode: 'off' });
}

/**
 * True when the draft differs from what was last saved. Every saved
 * field counts, not just the code: a schedule, a time limit or a note
 * changed on its own is an unsaved change too.
 */
export function scriptDraftDirty(saved: ScriptDraft, draft: ScriptDraft): boolean {
  return (
    saved.source !== draft.source ||
    saved.notes.trim() !== draft.notes.trim() ||
    saved.timeoutSeconds !== draft.timeoutSeconds ||
    scheduleKey(saved.schedule) !== scheduleKey(draft.schedule)
  );
}

/**
 * The source text that is actually stored for what the editor holds.
 * A notebook is saved without its outputs, so comparisons against a
 * run's snapshot have to use this form, not the raw editor text.
 */
export function storedScriptSource(source: string): string {
  return looksLikeNotebook(source) ? stripNotebookOutputs(source) : source;
}
