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
  const next = asInstances(prev).slice();
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
