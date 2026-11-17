// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Writes into a form response that stay correct when they land late.
 *
 * A photo, video or signature upload awaits the network and then
 * writes its answer. Inside a repeat group the write used to rebuild
 * the whole array from the render that started the upload, so notes
 * typed meanwhile (in that instance or another) were lost, and an
 * instance added or removed meanwhile came back or vanished. Every
 * write is now either a value or an updater of the latest value.
 * Answers are JSON, so a function is never a value in its own right.
 */
export type ValueUpdate = unknown;

type Answers = Record<string, unknown>;

export function applyValueUpdate(update: ValueUpdate, prev: unknown): unknown {
  return typeof update === 'function'
    ? (update as (p: unknown) => unknown)(prev)
    : update;
}

function asInstances(v: unknown): Answers[] {
  return Array.isArray(v) ? (v as Answers[]) : [];
}

/** Set one question inside one repeat instance, from the latest array. */
export function updateRepeatInstance(
  prev: unknown,
  index: number,
  questionId: string,
  update: ValueUpdate,
): Answers[] {
  const latest = asInstances(prev);
  // An instance removed while an upload for it was in flight is gone;
  // writing at its old index made a new, phantom instance.
  if (index < 0 || index >= latest.length) return latest;
  const next = latest.slice();
  const cur = next[index] ?? {};
  next[index] = { ...cur, [questionId]: applyValueUpdate(update, cur[questionId]) };
  return next;
}

export function removeRepeatInstance(prev: unknown, index: number): Answers[] {
  return asInstances(prev).filter((_, i) => i !== index);
}

export function addRepeatInstance(prev: unknown): Answers[] {
  return [...asInstances(prev), {}];
}

/** Set one question inside a non-repeating group, from the latest value. */
export function updateGroupAnswer(
  prev: unknown,
  questionId: string,
  update: ValueUpdate,
): Answers {
  const cur = (prev && typeof prev === 'object' ? prev : {}) as Answers;
  return { ...cur, [questionId]: applyValueUpdate(update, cur[questionId]) };
}

/**
 * Move one ranked item onto another's place. Dropping on an item means
 * taking its place, so dragging down by one or to the end works; the
 * old rule inserted before the target, which made both impossible.
 */
export function moveRankedItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) {
    return list.slice();
  }
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}
