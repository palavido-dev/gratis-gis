// SPDX-License-Identifier: AGPL-3.0-or-later
// Question-tree helpers for the form designer.
//
// These used to live inside the designer page. They moved here so the
// move, share-row, rename and import arithmetic can be tested without
// a browser: the share-row gesture deleted the dragged question and
// nobody could see it without dragging cards around by hand.
import {
  collectIds,
  defaultQuestion,
  suggestQuestionId,
  uniqueQuestionId,
  type Expression,
  type FormSchema,
  type Operand,
  type Question,
  type QuestionId,
  type QuestionType,
} from '@gratis-gis/form-schema';
import { packIntoRows } from './form-layout-rows';

export function findById(qs: Question[], id: QuestionId): Question | null {
  for (const q of qs) {
    if (q.id === id) return q;
    if (q.type === 'group') {
      const inner = findById(q.children, id);
      if (inner) return inner;
    }
  }
  return null;
}

export function mutateContainer(
  form: FormSchema,
  containerId: QuestionId | null,
  fn: (list: Question[]) => Question[],
): FormSchema {
  if (containerId === null) {
    return { ...form, questions: fn(form.questions) };
  }
  return {
    ...form,
    questions: mapTree(form.questions, (q) => {
      if (q.type === 'group' && q.id === containerId) {
        return { ...q, children: fn(q.children) };
      }
      return q;
    }),
  };
}

export function mapTree(
  qs: Question[],
  fn: (q: Question) => Question,
): Question[] {
  return qs.map((q) => {
    const mapped = fn(q);
    if (mapped.type === 'group') {
      return { ...mapped, children: mapTree(mapped.children, fn) };
    }
    return mapped;
  });
}

export function updateInTree(
  form: FormSchema,
  id: QuestionId,
  fn: (q: Question) => Question,
): FormSchema {
  return {
    ...form,
    questions: mapTree(form.questions, (q) => (q.id === id ? fn(q) : q)),
  };
}

export function removeFromTree(form: FormSchema, id: QuestionId): FormSchema {
  function rec(list: Question[]): Question[] {
    return list
      .filter((q) => q.id !== id)
      .map((q) => (q.type === 'group' ? { ...q, children: rec(q.children) } : q));
  }
  return { ...form, questions: rec(form.questions) };
}

/**
 * Look up a container's children. `null` containerId means top
 * level. Returns an empty array if the container id doesn't resolve
 * (group was deleted while we were holding a reference).
 */
export function childrenOfContainer(
  f: FormSchema,
  containerId: QuestionId | null,
): Question[] {
  if (containerId === null) return f.questions;
  const g = findById(f.questions, containerId);
  if (g && g.type === 'group') return g.children;
  return [];
}

/**
 * Given a flat container's children list and a target question id,
 * return the row that contains the target as packIntoRows would
 * compute it. Used by the share-row gesture to know which siblings
 * to re-balance.
 */
export function rowContaining(list: Question[], targetId: QuestionId): Question[] {
  const rows = packIntoRows(list);
  for (const row of rows) {
    if (row.some((q) => q.id === targetId)) return row;
  }
  return [];
}

/**
 * Width to apply when a row gains its `count`-th cell. We support
 * up to 4 cells per row using the equal-share fractions; beyond
 * that the caller falls back to a new row.
 */
export function nextWidthFor(
  count: number,
): 'full' | 'half' | 'third' | 'quarter' | null {
  if (count <= 1) return 'full';
  if (count === 2) return 'half';
  if (count === 3) return 'third';
  if (count === 4) return 'quarter';
  return null;
}

/**
 * True for question types in the palette's "Layout" group: structural
 * or display-only kinds that don't capture a value from the responder.
 * The Properties panel uses this to hide controls that don't apply
 * (e.g. Required), and the QuestionRow's drop handler uses it to
 * decide between insert-before and share-row gestures.
 */
export function isLayoutType(t: QuestionType): boolean {
  return (
    t === 'note' ||
    t === 'divider' ||
    t === 'page' ||
    t === 'group' ||
    t === 'image-display' ||
    t === 'hidden'
  );
}

/** Locate the parent container + index for a given question id. */
export function locate(
  qs: Question[],
  id: QuestionId,
  parent: QuestionId | null = null,
): { containerId: QuestionId | null; index: number } | null {
  for (let i = 0; i < qs.length; i += 1) {
    const q = qs[i]!;
    if (q.id === id) return { containerId: parent, index: i };
    if (q.type === 'group') {
      const inner = locate(q.children, id, q.id);
      if (inner) return inner;
    }
  }
  return null;
}

export function moveInTree(
  form: FormSchema,
  sourceId: QuestionId,
  target: { containerId: QuestionId | null; index: number },
): FormSchema {
  // Reject moving a group into itself or any of its descendants.
  const moved = findById(form.questions, sourceId);
  if (!moved) return form;
  if (target.containerId !== null && isDescendant(moved, target.containerId)) {
    return form;
  }
  // Detach the source first so subsequent index math is consistent
  // with the post-detach tree.
  const src = locate(form.questions, sourceId);
  if (!src) return form;

  // Detach
  let next = removeFromTree(form, sourceId);

  // Adjust the target index if we removed an item before it from the
  // same container.
  let insertIndex = target.index;
  if (src.containerId === target.containerId && src.index < target.index) {
    insertIndex -= 1;
  }
  insertIndex = Math.max(0, insertIndex);

  next = mutateContainer(next, target.containerId, (list) => {
    const out = list.slice();
    out.splice(insertIndex, 0, moved);
    return out;
  });
  return next;
}

export function isDescendant(node: Question, candidateId: QuestionId): boolean {
  if (node.id === candidateId) return true;
  if (node.type !== 'group') return false;
  return node.children.some((c) => isDescendant(c, candidateId));
}

export type ShareRowSource =
  | { kind: 'new'; type: QuestionType }
  | { kind: 'existing'; id: QuestionId };

/**
 * "Share a row with this question" gesture. Triggered by dropping
 * a tile (new from palette OR an existing question being reordered)
 * directly onto another question's card body. Auto-balances the
 * widths of all questions in that row to the next equal fraction:
 *
 *   target alone  -> 1/2 + 1/2
 *   target in 2   -> 1/3 + 1/3 + 1/3
 *   target in 3   -> 1/4 + 1/4 + 1/4 + 1/4
 *   target in 4   -> row is full; new tile starts a new row at
 *                     full width below the target
 *
 * Same-row reorder (the dragged question is already in the target's
 * row) is treated as a plain reorder; widths stay as-is.
 *
 * `refuseMove` lets the caller veto moving an existing question into
 * the target's container (the attachment-subtree rule). A refused
 * move returns the form unchanged with `refused: true`.
 */
export function shareRowInTree(
  f: FormSchema,
  targetId: QuestionId,
  src: ShareRowSource,
  refuseMove?: (moved: Question, containerId: QuestionId | null) => boolean,
): { form: FormSchema; selectId?: QuestionId; refused?: boolean } {
  const targetLoc = locate(f.questions, targetId);
  if (!targetLoc) return { form: f };
  const targetParent = targetLoc.containerId;

  // Same-row reorder shortcut: if the existing source already
  // lives in the target's row, just reorder, leave widths alone.
  const initialContainer = childrenOfContainer(f, targetParent);
  const targetRow = rowContaining(initialContainer, targetId);
  if (src.kind === 'existing' && targetRow.some((q) => q.id === src.id)) {
    const idx = initialContainer.findIndex((q) => q.id === targetId);
    return {
      form: moveInTree(f, src.id, { containerId: targetParent, index: idx + 1 }),
    };
  }

  // Keep the dragged question itself before detaching it. Moving it
  // with moveInTree after the detach found nothing to move, so the
  // question (and a group's whole subtree) was simply deleted.
  let moved: Question | null = null;
  if (src.kind === 'existing') {
    moved = findById(f.questions, src.id);
    if (!moved) return { form: f };
    // A group dropped on one of its own descendants has nowhere to go.
    if (isDescendant(moved, targetId)) return { form: f };
    if (refuseMove?.(moved, targetParent)) return { form: f, refused: true };
  }

  // For an existing source coming from a different row / container,
  // detach first so width-update math sees the row at its true size.
  let next = f;
  if (src.kind === 'existing') next = removeFromTree(next, src.id);

  const containerNow = childrenOfContainer(next, targetParent);
  const rowNow = rowContaining(containerNow, targetId);
  const newWidth = nextWidthFor(rowNow.length + 1);

  // Insert the new/moved question right after the target.
  const insertAfterTarget = (q: Question): FormSchema => {
    const idx = childrenOfContainer(next, targetParent).findIndex(
      (x) => x.id === targetId,
    );
    return mutateContainer(next, targetParent, (list) => [
      ...list.slice(0, idx + 1),
      q,
      ...list.slice(idx + 1),
    ]);
  };
  const makeNew = (type: QuestionType): Question =>
    defaultQuestion(type, uniqueQuestionId(next, suggestQuestionId(type)));

  if (newWidth === null) {
    // Row already at the 4-cell cap. Drop in as a new row at
    // full width right below the target.
    const q = moved ? { ...moved, layout: undefined } : makeNew((src as { type: QuestionType }).type);
    next = insertAfterTarget(q as Question);
    return { form: next, ...(moved ? {} : { selectId: q.id }) };
  }

  // Apply the shared width to every existing row member.
  const layout = newWidth === 'full' ? undefined : { width: newWidth };
  for (const memberQ of rowNow) {
    next = updateInTree(next, memberQ.id, (qq) => ({ ...qq, layout }) as Question);
  }

  // Insert the source with the same width.
  const base = moved ?? makeNew((src as { type: QuestionType }).type);
  next = insertAfterTarget({ ...base, layout } as Question);
  return { form: next, ...(moved ? {} : { selectId: base.id }) };
}

/**
 * Rename a question and every reference to it. Conditions, required-
 * if, valid-if, read-only and calculations in other questions name
 * questions by id, so renaming only the question left them pointing
 * at an id that no longer exists and they quietly stopped working.
 */
export function renameQuestionInForm(
  form: FormSchema,
  oldId: QuestionId,
  newId: QuestionId,
): FormSchema {
  const renamed = mapTree(form.questions, (q) => {
    const out = { ...q } as Question & Record<string, unknown>;
    if (q.id === oldId) out.id = newId;
    for (const key of ['visibleIf', 'constraint', 'calculate', 'required', 'readOnly'] as const) {
      const v = out[key];
      if (v && typeof v === 'object') {
        out[key] = renameRefsInExpression(v as Expression, oldId, newId);
      }
    }
    return out as Question;
  });
  return { ...form, questions: renamed };
}

function renameRefsInExpression(
  e: Expression,
  oldId: QuestionId,
  newId: QuestionId,
): Expression {
  const op = (o: Operand): Operand => {
    if ('ref' in o) return o.ref === oldId ? { ref: newId } : o;
    if ('call' in o && Array.isArray(o.args)) {
      return { ...o, args: o.args.map(op) };
    }
    return o;
  };
  const ex = (x: Expression) => renameRefsInExpression(x, oldId, newId);
  switch (e.op) {
    case 'and':
    case 'or':
      return { ...e, operands: e.operands.map(ex) };
    case 'not':
      return { ...e, operand: ex(e.operand) };
    case 'between':
      return { ...e, value: op(e.value), min: op(e.min), max: op(e.max) };
    case 'concat':
      return { ...e, operands: e.operands.map(op) };
    case 'if':
      return { ...e, condition: ex(e.condition), then: op(e.then), else: op(e.else) };
    default:
      return { ...e, left: op(e.left), right: op(e.right) } as Expression;
  }
}

/**
 * Give generated questions ids that are unique against the form they
 * are added to and against each other. Layer import named every
 * question after its column, so a parent and a related table that
 * both had `notes` (or both had attachments, two `photo` questions)
 * produced duplicate ids, and the tree helpers then edited, moved
 * and deleted every question sharing the id. `bindTo.column` keeps
 * the real column name.
 */
export function uniquifyQuestionIds(
  form: FormSchema,
  qs: Question[],
): Question[] {
  const used = collectIds(form);
  const claim = (id: string): string => {
    let out = id;
    let i = 2;
    while (used.has(out)) {
      out = `${id}_${i}`;
      i += 1;
    }
    used.add(out);
    return out;
  };
  const rec = (list: Question[]): Question[] =>
    list.map((q) => {
      const id = claim(q.id);
      if (q.type === 'group') return { ...q, id, children: rec(q.children) };
      return id === q.id ? q : ({ ...q, id } as Question);
    });
  return rec(qs);
}

/** The part of a form that names its linked layer. */
export interface FormLink {
  linkedLayerId?: string;
  linkedLayerKey?: string;
  meta?: Record<string, unknown>;
}

/**
 * Copy the layer link (id, sublayer key and, when `from` has meta, the
 * remembered layer title) from `from` onto `form`. Used when an import
 * replaces the form, and after a save with the link the server kept.
 */
export function withFormLink(form: FormSchema, from: FormLink): FormSchema {
  const next: FormSchema = { ...form };
  delete next.linkedLayerId;
  delete next.linkedLayerKey;
  if (from.linkedLayerId) next.linkedLayerId = from.linkedLayerId;
  if (from.linkedLayerKey) next.linkedLayerKey = from.linkedLayerKey;
  if (from.meta !== undefined || form.meta !== undefined) {
    const meta: Record<string, unknown> = { ...(form.meta ?? {}) };
    const title = from.meta?.linkedLayerTitle;
    if (from.meta !== undefined) {
      if (from.linkedLayerId && typeof title === 'string') {
        meta.linkedLayerTitle = title;
      } else {
        delete meta.linkedLayerTitle;
      }
    } else if (!from.linkedLayerId) {
      delete meta.linkedLayerTitle;
    }
    next.meta = meta;
  }
  return next;
}

/**
 * Keep the current form's notification and response view settings on
 * a form an import is replacing it with. They are settings of this
 * form item (who gets emailed, what the Responses page shows), not
 * part of the questions a file carries, so an import used to wipe them
 * or bring in another form's recipients. A setting the current form
 * does not have is left unset.
 */
export function withFormSettings(
  form: FormSchema,
  from: Pick<FormSchema, 'notify' | 'responseView'>,
): FormSchema {
  const next: FormSchema = { ...form };
  delete next.notify;
  delete next.responseView;
  if (from.notify !== undefined) next.notify = from.notify;
  if (from.responseView !== undefined) next.responseView = from.responseView;
  return next;
}

/**
 * The link a form save ended with, read from the PATCH response body.
 * Falls back to `sent` when the body is not an item with data.
 */
export function savedFormLink(body: unknown, sent: FormLink): FormLink {
  const data =
    body && typeof body === 'object'
      ? (body as { data?: unknown }).data
      : undefined;
  if (!data || typeof data !== 'object') {
    return {
      ...(sent.linkedLayerId ? { linkedLayerId: sent.linkedLayerId } : {}),
      ...(sent.linkedLayerKey ? { linkedLayerKey: sent.linkedLayerKey } : {}),
    };
  }
  const d = data as { linkedLayerId?: unknown; linkedLayerKey?: unknown };
  return {
    ...(typeof d.linkedLayerId === 'string' ? { linkedLayerId: d.linkedLayerId } : {}),
    ...(typeof d.linkedLayerKey === 'string' ? { linkedLayerKey: d.linkedLayerKey } : {}),
  };
}

/**
 * Top-level repeat groups that would have nowhere to write their rows
 * on a form linked to an existing layer (not the form's own paired
 * layer). The submission mirror writes a group's rows into the related
 * table its `bindTo.layerKey` names, or else into a sublayer named
 * after the group (repeatGroupTargetSublayer in portal-api
 * forms.service.ts). On someone else's layer the designer does not
 * create sublayers, so a group matching neither would silently keep
 * its rows only inside the parent row. Returns the groups' labels.
 */
export function unboundRepeatGroups(
  questions: readonly Question[],
  sublayerIds: ReadonlySet<string>,
  parentLayerKey: string,
): string[] {
  const out: string[] = [];
  for (const q of questions) {
    if (q.type !== 'group' || !q.repeat) continue;
    const bound = q.bindTo?.layerKey;
    const ok =
      (typeof bound === 'string' && bound !== parentLayerKey && sublayerIds.has(bound)) ||
      (q.id !== parentLayerKey && sublayerIds.has(q.id));
    if (!ok) out.push(q.label || q.id);
  }
  return out;
}
