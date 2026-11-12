// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  evaluate,
  pruneHidden,
  walkQuestions,
} from '@gratis-gis/form-schema';
import type {
  Expression,
  FormSchema,
  Question,
  Response as FormResponse,
} from '@gratis-gis/form-schema';

/**
 * Builtins whose value depends on when they run. A submission can be
 * captured offline days before it reaches the server, so recomputing
 * these here would overwrite the capture-time value with the upload
 * time. Calculations that use them keep the value the client sent.
 */
const TIME_BUILTIN_RE = /"call"\s*:\s*"(?:now|today)"/;

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
  const calcs: Array<{ id: string; expr: Expression }> = [];
  for (const q of walkQuestions(form)) {
    const expr = q.type === 'calculated' ? q.calculate : q.calculate ?? undefined;
    if (!expr) continue;
    if (TIME_BUILTIN_RE.test(JSON.stringify(expr))) continue;
    calcs.push({ id: q.id, expr });
  }
  // Repeat until nothing changes, like the browser does by re-running
  // its effect. One pass would compute an answer that depends on
  // another calculated answer from the value the client sent, not
  // from the recomputed one. A chain is at most as long as the number
  // of calculations, so that bounds the loop (a cycle just stops).
  let next = response;
  for (let pass = 0; pass <= calcs.length; pass++) {
    let changed = false;
    for (const { id, expr } of calcs) {
      const computed = evaluate(expr, next);
      if (next[id] !== computed) {
        if (next === response) next = { ...response };
        next[id] = computed;
        changed = true;
      }
    }
    if (!changed) break;
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
