// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-question runtime state, computed once for a whole form.
 *
 * The web runtime asked the three questions a renderer needs (is this
 * visible, is it required, is it read-only) one question at a time
 * with the primitives in index.ts, and kept the read-only rule in its
 * own component. That was fine while every renderer was React and
 * imported this package. The native field client renders in Kotlin
 * and cannot import anything, so the decision has to be made here and
 * handed over as data, and the walk over repeat groups (instances
 * evaluated against their own object, paths like `g[0].child`) has to
 * be made here too or it gets reimplemented per platform.
 *
 * The walk mirrors `validate` exactly: same skip list, same repeat
 * handling, same path shape. If those ever disagree, validation
 * errors point at questions the renderer never showed.
 */

import type { Expression, FormSchema, Question, Response } from './index';
import { evaluate, isRequired, isVisible } from './index';

/**
 * Whether the respondent may edit the question. A calculated question,
 * whether the dedicated type or any type carrying `calculate`, is
 * always read-only: `applyCalculations` would overwrite an edit on the
 * next pass anyway.
 */
export function isReadOnly(q: Question, response: Response): boolean {
  if (q.type === 'calculated' || q.calculate) return true;
  if (q.readOnly === undefined || q.readOnly === false) return false;
  if (q.readOnly === true) return true;
  return Boolean(evaluate(q.readOnly as Expression, response));
}

export interface QuestionState {
  /** `<groupId>[<index>].` prefixes for repeat instances, else the id. */
  path: string;
  id: string;
  visible: boolean;
  required: boolean;
  readOnly: boolean;
}

export interface FormState {
  /** One entry per question occurrence, in render order. A repeat
   *  group's children appear once per instance. */
  questions: QuestionState[];
}

/**
 * Compute visibility, requiredness and read-only for every question
 * occurrence in the form against the in-progress response.
 *
 * Hidden groups still list their children, marked not visible, so a
 * renderer can key on the full set without diffing against the
 * schema. A repeat group whose `response[id]` is not an array lists
 * no instances.
 */
export function evaluateFormState(form: FormSchema, response: Response): FormState {
  const out: QuestionState[] = [];
  walk(form.questions, response, '', true, out);
  return { questions: out };
}

function walk(
  questions: Question[],
  response: Response,
  pathPrefix: string,
  parentVisible: boolean,
  out: QuestionState[],
): void {
  for (const q of questions) {
    const visible = parentVisible && isVisible(q, response);
    out.push({
      path: `${pathPrefix}${q.id}`,
      id: q.id,
      visible,
      required: isRequired(q, response),
      readOnly: isReadOnly(q, response),
    });
    if (q.type !== 'group') continue;
    if (q.repeat) {
      const instances = response[q.id];
      if (!Array.isArray(instances)) continue;
      for (let i = 0; i < instances.length; i += 1) {
        const inst = instances[i];
        const instObj: Response =
          inst && typeof inst === 'object' && !Array.isArray(inst) ? (inst as Response) : {};
        walk(q.children, instObj, `${pathPrefix}${q.id}[${i}].`, visible, out);
      }
      continue;
    }
    walk(q.children, response, pathPrefix, visible, out);
  }
}
