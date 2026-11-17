// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  applyCalculations,
  pruneHidden,
  walkQuestions,
} from '@gratis-gis/form-schema';
import type {
  FormSchema,
  Question,
  Response as FormResponse,
} from '@gratis-gis/form-schema';


/**
 * Server copy of what the form runtime does before it posts:
 * recompute calculated answers, then keep only answers to questions
 * that are visible for this response. Keys that match no question are
 * dropped too, at the top level and inside each repeat-group instance.
 *
 * validate() skips hidden questions and ignores unknown keys, so
 * without this a stale tab or a hand-crafted request could store
 * values that were never checked.
 */
export function cleanSubmission(
  form: FormSchema,
  response: FormResponse,
): FormResponse {
  return pruneLevel(form, form.questions, recalculate(form, response));
}

function recalculate(form: FormSchema, response: FormResponse): FormResponse {
  // Repeat until nothing changes, like the browser does by re-running
  // its effect. A chain is at most as long as the number of
  // calculations, so that bounds the loop (a cycle just stops).
  // applyCalculations also computes questions inside repeat instances,
  // which the old flat walk left empty. Clock expressions keep the
  // value the client captured (skipClock).
  const bound = [...walkQuestions(form)].filter((q) =>
    q.type === 'calculated' ? q.calculate : q.calculate,
  ).length;
  let next = response;
  for (let pass = 0; pass <= bound; pass++) {
    const out = applyCalculations(form, next, { skipClock: true });
    if (out === next) break;
    next = out;
  }
  return next;
}

function pruneLevel(
  form: FormSchema,
  questions: Question[],
  response: FormResponse,
): FormResponse {
  const out = pruneHidden({ ...form, questions }, response);
  for (const group of repeatGroups(questions)) {
    const instances = out[group.id];
    if (!Array.isArray(instances)) continue;
    out[group.id] = instances.map((inst: unknown) =>
      inst && typeof inst === 'object' && !Array.isArray(inst)
        ? pruneLevel(form, group.children, inst as FormResponse)
        : {},
    );
  }
  return out;
}

/** Repeat groups at this level, looking through non-repeat groups,
 *  whose children answer at the same level (#288). */
function repeatGroups(
  questions: Question[],
): Array<Extract<Question, { type: 'group' }>> {
  const out: Array<Extract<Question, { type: 'group' }>> = [];
  for (const q of questions) {
    if (q.type !== 'group') continue;
    if (q.repeat) out.push(q);
    else out.push(...repeatGroups(q.children));
  }
  return out;
}
