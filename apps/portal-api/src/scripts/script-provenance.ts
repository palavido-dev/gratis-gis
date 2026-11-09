// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';
import { normalizeScriptSchedule } from '@gratis-gis/shared-types';

/**
 * Who wrote the code a scheduled run would execute.
 *
 * A scheduled run acts as the script's OWNER, with a key minted for the
 * owner. Anyone with edit access can change `data.source`, so without a
 * record of who last changed it an editor could write code and have it
 * run with the owner's authority on the next tick. That is the confused
 * deputy the manual-run rule exists to prevent.
 *
 * So the server stamps `data.sourceEditedBy` on every write of a
 * script's data, and the scheduler refuses to run code that someone
 * other than the owner wrote until the owner saves it again. The field
 * is server state: whatever a client sends for it is discarded.
 */
export const SOURCE_EDITED_BY = 'sourceEditedBy';

type Data = Record<string, unknown>;

function asData(v: unknown): Data {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {};
}

/**
 * The script data to store after `editorId` writes `nextData` over
 * `prevData`.
 *
 * - The owner saving the script marks the current code as the owner's,
 *   whether or not it changed. That is how an owner approves an
 *   editor's change.
 * - Anyone else who changes the source becomes its author.
 * - Anyone else who saves without changing the source keeps the
 *   previous author.
 */
export function stampScriptProvenance(input: {
  ownerId: string;
  editorId: string;
  prevData: unknown;
  nextData: unknown;
}): Data {
  const prev = asData(input.prevData);
  const next: Data = { ...asData(input.nextData) };
  delete next[SOURCE_EDITED_BY];

  if (input.editorId === input.ownerId) {
    next[SOURCE_EDITED_BY] = input.ownerId;
    return next;
  }
  const prevSource = typeof prev.source === 'string' ? prev.source : '';
  const nextSource = typeof next.source === 'string' ? next.source : '';
  if (nextSource !== prevSource) {
    next[SOURCE_EDITED_BY] = input.editorId;
  } else if (typeof prev[SOURCE_EDITED_BY] === 'string') {
    next[SOURCE_EDITED_BY] = prev[SOURCE_EDITED_BY];
  }
  return next;
}

/**
 * Only the owner may add or change a script's schedule, because a
 * scheduled run uses the owner's authority. Anyone with edit access may
 * still remove one: turning a schedule off cannot run anything.
 */
export function assertScheduleChangeAllowed(input: {
  ownerId: string;
  editorId: string;
  prevData: unknown;
  nextData: unknown;
}): void {
  if (input.editorId === input.ownerId) return;
  const active = (raw: unknown) => {
    const s = normalizeScriptSchedule(raw);
    return s && s.mode !== 'off' ? s : null;
  };
  const before = active(asData(input.prevData).schedule);
  const after = active(asData(input.nextData).schedule);
  if (!after) return;
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  throw new ForbiddenException(
    "Only the owner of a script can set or change its schedule, because scheduled runs use the owner's permissions.",
  );
}

/**
 * Why a scheduled run must not start, or null when it may.
 *
 * Code with no recorded author is NOT treated as the owner's. Scripts
 * saved before this check carry no stamp, and one of them may have been
 * written by somebody else or reassigned to its current owner, so the
 * owner has to save it once before it runs with their key on a timer.
 */
export function scheduledRunBlockedReason(item: {
  ownerId: string;
  data: unknown;
}): string | null {
  const editedBy = asData(item.data)[SOURCE_EDITED_BY];
  if (typeof editedBy !== 'string') {
    return "Skipped: the owner has not saved this script's code since scheduled runs started checking who wrote it. The owner needs to review and save the script before scheduled runs resume.";
  }
  if (editedBy !== item.ownerId) {
    return "Skipped: someone other than the owner changed this script's code since the owner last saved it. The owner needs to review and save the script before scheduled runs resume.";
  }
  return null;
}

/**
 * The data to store when a script changes owner. The code was not
 * written by the new owner, so the previous owner (or whoever the stamp
 * already names) stays its author until the new owner saves it.
 */
export function provenanceOnReassign(
  data: unknown,
  previousOwnerId: string,
): Data {
  const next: Data = { ...asData(data) };
  if (typeof next[SOURCE_EDITED_BY] !== 'string') {
    next[SOURCE_EDITED_BY] = previousOwnerId;
  }
  return next;
}
