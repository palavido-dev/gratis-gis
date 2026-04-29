'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignLeft,
  BarChart3,
  Calculator,
  Calendar,
  CalendarClock,
  Camera,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Crosshair,
  Database,
  Download,
  Eye,
  EyeOff,
  FileText,
  Grid3x3,
  GripVertical,
  Hash,
  Home,
  Image,
  Link,
  ListOrdered,
  ListChecks,
  Loader2,
  Mail,
  MapPin,
  Minus,
  Phone,
  Plus,
  Regex,
  Search,
  ShieldCheck,
  Save,
  Sliders,
  SplitSquareHorizontal,
  Square,
  Star,
  Text as TextIcon,
  ToggleLeft,
  Trash2,
  Type,
  Upload,
  User,
  Workflow,
  X,
} from 'lucide-react';
import {
  collectIds,
  CURRENT_FORM_SCHEMA_VERSION,
  defaultQuestion,
  emptyForm,
  fromImportEnvelope,
  parseExportEnvelope,
  QUESTION_TYPES,
  suggestExportFilename,
  suggestQuestionId,
  toExportEnvelope,
  uniqueQuestionId,
  type Choice,
  type Expression,
  type FormSchema,
  type Question,
  type QuestionId,
  type QuestionType,
} from '@gratis-gis/form-schema';
import { useConfirm } from '@/components/dialog-provider';
import {
  FormRuntime,
  QuestionPreview,
  packIntoRows,
  widthToClass,
} from '@/components/form-runtime';

interface Props {
  itemId: string;
  initial: FormSchema | null;
  canEdit: boolean;
}

/**
 * Three-panel form designer (#131 / #141). Survey123-style layout:
 * palette / canvas / properties; a Preview tab swaps the canvas with
 * the live runtime so authors can sanity-check what respondents see.
 *
 * Tree model: questions live in a tree -- top-level array on the
 * form, plus `children` arrays on `group` questions. Every state
 * mutation (add / update / remove / move) takes a "container path":
 * `null` for the top level, or a group's question id. The Canvas is
 * a recursive component that renders the tree with proper drop
 * zones at each level so users can drop into a group, not just on
 * the top-level list.
 *
 * Drag-drop: HTML5 native (no extra deps). Drop targets stop event
 * propagation so a drop on a row doesn't double-fire on the parent
 * container. Tap-to-add is preserved for touch devices where DnD is
 * unreliable.
 *
 * Layer import: a "Start from a data layer" entry point on the
 * empty canvas (and a button always available in the form-level
 * properties panel) opens a picker, fetches the layer's columns,
 * and seeds the form with one question per column at compatible
 * types. Each generated question has `bindTo.column` set so the
 * Field-mode runtime can map submissions back to the layer
 * automatically.
 */
export function FormDesigner({ itemId, initial, canEdit }: Props) {
  const confirmDialog = useConfirm();
  const [form, setForm] = useState<FormSchema>(
    () => initial ?? emptyForm(itemId, 'Untitled form'),
  );
  const [selectedId, setSelectedId] = useState<QuestionId | null>(null);
  const [tab, setTab] = useState<'design' | 'preview'>('design');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [layerSchema, setLayerSchema] = useState<LayerSchema | null>(null);

  // Whenever the linked layer changes (initial load + import + unlink),
  // refresh our copy of the layer's full schema (parent columns +
  // related tables) so the canvas can render per-question link status
  // correctly even for questions inside related-table groups. Failure
  // is non-fatal: the designer still works, just without the colored
  // "matched / new column" badges.
  useEffect(() => {
    if (!form.linkedLayerId) {
      setLayerSchema(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const s = await fetchLayerSchema(form.linkedLayerId!, form.linkedLayerKey);
        if (!cancelled) setLayerSchema(s);
      } catch {
        if (!cancelled) setLayerSchema(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [form.linkedLayerId, form.linkedLayerKey]);

  const selected = useMemo(
    () => (selectedId ? findById(form.questions, selectedId) : null),
    [form.questions, selectedId],
  );

  /**
   * Add a fresh question. `containerId === null` puts it at the end
   * of the top-level questions; a non-null id puts it at the end of
   * that group's children.
   */
  const addQuestion = useCallback(
    (
      type: QuestionType,
      containerId: QuestionId | null = null,
      index?: number,
    ) => {
      const baseId = suggestQuestionId(type);
      setForm((f) => {
        const id = uniqueQuestionId(f, baseId);
        const q = defaultQuestion(type, id);
        // Insert at `index` when given (drop between two existing
        // questions); otherwise append to the container's end.
        const next = mutateContainer(f, containerId, (list) => {
          if (index === undefined || index >= list.length) {
            return [...list, q];
          }
          return [...list.slice(0, Math.max(0, index)), q, ...list.slice(index)];
        });
        // schedule selection on the next tick so the freshly-added
        // question is selectable immediately
        queueMicrotask(() => setSelectedId(id));
        return next;
      });
    },
    [],
  );

  const updateQuestion = useCallback(
    (id: QuestionId, patch: Partial<Question>) => {
      setForm((f) => updateInTree(f, id, (q) => ({ ...q, ...patch } as Question)));
    },
    [],
  );

  const removeQuestion = useCallback((id: QuestionId) => {
    setForm((f) => removeFromTree(f, id));
    setSelectedId(null);
  }, []);

  /**
   * Move an existing question. Supports the three transitions:
   *
   *   - reorder within the same container
   *   - move from top-level into a group's children
   *   - move from a group's children to top-level (drop on a top-
   *     level question or the empty footer)
   *
   * Drops on the dragged question itself are no-ops.
   */
  const moveQuestion = useCallback(
    (
      sourceId: QuestionId,
      target: { containerId: QuestionId | null; index: number },
    ) => {
      setForm((f) => {
        // Guard: refuse to land an already-repeating group (or a
        // group that contains any descendant repeating group) inside
        // an attachment group's subtree. The data model treats one
        // attachment row as one repeat instance, so a repeating group
        // here would imply attachment-of-attachment, which we don't
        // support. Silently stripping the repeat would surprise the
        // user; we surface an error instead and leave the form
        // untouched.
        if (
          containerIsInAttachmentSubtree(f, target.containerId, layerSchema)
        ) {
          const src = findById(f.questions, sourceId);
          if (src && groupContainsRepeat(src)) {
            setError(
              "Can't move a repeating group inside an attachment group. Each attachment is already one repeat instance, so a nested repeat here would mean attachment-of-attachment, which the data model doesn't support.",
            );
            return f;
          }
        }
        setError(null);
        return moveInTree(f, sourceId, target);
      });
    },
    [layerSchema],
  );

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
   */
  const shareRowWith = useCallback(
    (
      targetId: QuestionId,
      src:
        | { kind: 'new'; type: QuestionType }
        | { kind: 'existing'; id: QuestionId },
    ) => {
      setForm((f) => {
        const targetLoc = locate(f.questions, targetId);
        if (!targetLoc) return f;
        const targetParent = targetLoc.containerId;

        // Same-row reorder shortcut: if the existing source already
        // lives in the target's row, just reorder, leave widths alone.
        const initialContainer = childrenOfContainer(f, targetParent);
        const targetRow = rowContaining(initialContainer, targetId);
        if (
          src.kind === 'existing' &&
          targetRow.some((q) => q.id === src.id)
        ) {
          const idx = initialContainer.findIndex((q) => q.id === targetId);
          return moveInTree(f, src.id, {
            containerId: targetParent,
            index: idx + 1,
          });
        }

        // For an existing source coming from a different row / container,
        // detach first so width-update math sees the row at its true size.
        let next = f;
        if (src.kind === 'existing') next = removeFromTree(next, src.id);

        const containerNow = childrenOfContainer(next, targetParent);
        const rowNow = rowContaining(containerNow, targetId);
        const newWidth = nextWidthFor(rowNow.length + 1);

        // Helper: insert the new/moved question right after the target.
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

        if (newWidth === null) {
          // Row already at the 4-cell cap. Drop in as a new row at
          // full width right below the target.
          if (src.kind === 'new') {
            const id = uniqueQuestionId(
              next,
              suggestQuestionId(src.type),
            );
            const newQ = defaultQuestion(src.type, id);
            next = insertAfterTarget(newQ);
            queueMicrotask(() => setSelectedId(id));
          } else {
            const idx = childrenOfContainer(next, targetParent).findIndex(
              (x) => x.id === targetId,
            );
            next = moveInTree(next, src.id, {
              containerId: targetParent,
              index: idx + 1,
            });
          }
          return next;
        }

        // Apply the shared width to every existing row member.
        for (const memberQ of rowNow) {
          next = updateInTree(next, memberQ.id, (qq) => {
            const layout =
              newWidth === 'full' ? undefined : { width: newWidth };
            return { ...qq, layout } as Question;
          });
        }

        // Insert / move the source with the same width.
        if (src.kind === 'new') {
          const id = uniqueQuestionId(next, suggestQuestionId(src.type));
          const baseQ = defaultQuestion(src.type, id);
          const newQ: Question = {
            ...baseQ,
            layout: newWidth === 'full' ? undefined : { width: newWidth },
          };
          next = insertAfterTarget(newQ);
          queueMicrotask(() => setSelectedId(id));
        } else {
          const idx = childrenOfContainer(next, targetParent).findIndex(
            (x) => x.id === targetId,
          );
          next = moveInTree(next, src.id, {
            containerId: targetParent,
            index: idx + 1,
          });
          next = updateInTree(next, src.id, (qq) => ({
            ...qq,
            layout: newWidth === 'full' ? undefined : { width: newWidth },
          } as Question));
        }
        return next;
      });
    },
    [],
  );

  async function save() {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: form }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setSavedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  function exportForm() {
    const env = toExportEnvelope(form);
    const blob = new Blob([JSON.stringify(env, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestExportFilename(form);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importFormFile(file: File) {
    setError(null);
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      setError('That file is not valid JSON.');
      return;
    }
    const result = parseExportEnvelope(raw);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    // Confirm before clobbering existing work.
    const hasContent = form.questions.length > 0;
    if (hasContent) {
      const ok = await confirmDialog({
        title: 'Replace this form?',
        message: `Importing "${result.form.title}" will replace the current form (${form.questions.length} question${form.questions.length === 1 ? '' : 's'}). This can't be undone.`,
        confirmLabel: 'Replace',
        variant: 'danger',
      });
      if (!ok) return;
    }
    setForm(fromImportEnvelope(result, itemId));
    setSelectedId(null);
  }

  function applyImported(
    qs: Question[],
    layer: { id: string; title: string; layerKey?: string },
  ) {
    setForm((f) => ({
      ...f,
      questions: [...f.questions, ...qs],
      linkedLayerId: layer.id,
      ...(layer.layerKey !== undefined ? { linkedLayerKey: layer.layerKey } : {}),
      meta: { ...(f.meta ?? {}), linkedLayerTitle: layer.title },
    }));
    setImportOpen(false);
  }

  function unlinkLayer() {
    setForm((f) => {
      const next: FormSchema = { ...f };
      delete next.linkedLayerId;
      delete next.linkedLayerKey;
      // Drop bindTo from each question -- the user's choice to
      // unlink means the form is no longer authoritative against any
      // layer schema. Question content stays.
      next.questions = stripBindings(next.questions);
      const meta = { ...(next.meta ?? {}) } as Record<string, unknown>;
      delete meta.linkedLayerTitle;
      next.meta = meta;
      return next;
    });
  }

  return (
    <div className="rounded-lg border border-border bg-surface-1 shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={form.title}
            disabled={!canEdit}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className="rounded-md border border-border bg-surface-1 px-2 py-1 text-sm font-medium text-ink-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
          />
          <span className="text-[10px] uppercase tracking-wide text-muted">
            schema v{CURRENT_FORM_SCHEMA_VERSION}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setTab('design')}
              className={`px-2 py-1 ${
                tab === 'design'
                  ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                  : 'text-muted'
              }`}
            >
              Design
            </button>
            <button
              type="button"
              onClick={() => setTab('preview')}
              className={`px-2 py-1 ${
                tab === 'preview'
                  ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                  : 'text-muted'
              }`}
            >
              <Eye className="mr-1 inline h-3 w-3" />
              Preview
            </button>
          </div>
          <button
            type="button"
            onClick={exportForm}
            title="Download this form as a portable JSON file"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </button>
          {canEdit ? (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Replace this form with one from a .gratisgis-form.json file"
                className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2"
              >
                <Upload className="h-3.5 w-3.5" />
                Import
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFormFile(f);
                  // Reset so picking the same file twice still fires.
                  e.target.value = '';
                }}
              />
            </>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="border-b border-danger/40 bg-danger/5 px-4 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {savedAt && !error ? (
        <p className="border-b border-emerald-300 bg-emerald-50 px-4 py-1 text-[11px] text-emerald-800">
          Saved {savedAt.toLocaleTimeString()}.
        </p>
      ) : null}

      {tab === 'design' ? (
        // The grid hosts three independent columns. We use
        // `lg:items-start` so each column can be its own scroll
        // container without forcing the others to match height.
        // Palette + Properties get `lg:sticky lg:top-0
        // lg:max-h-screen lg:overflow-y-auto` (applied inside their
        // components) so scrolling within them doesn't drag the
        // page along. Canvas stays in normal flow -- it grows with
        // the form's content and the user scrolls the page to
        // navigate. Result: scrolling the palette to find a
        // question type doesn't take the canvas out of viewport.
        <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr_280px] lg:items-start">
          <Palette canEdit={canEdit} onAdd={(t) => addQuestion(t, null)} />
          <Canvas
            form={form}
            selectedId={selectedId}
            canEdit={canEdit}
            layerSchema={layerSchema}
            isLinked={Boolean(form.linkedLayerId)}
            onSelect={setSelectedId}
            onRemove={removeQuestion}
            onAddInto={addQuestion}
            onShareRow={shareRowWith}
            onMove={moveQuestion}
            onOpenImport={() => setImportOpen(true)}
          />
          <Properties
            form={form}
            question={selected}
            canEdit={canEdit}
            layerSchema={layerSchema}
            onUnlinkLayer={unlinkLayer}
            onChange={(patch) => {
              if (selected) updateQuestion(selected.id, patch);
            }}
            onRename={(newId) => {
              if (!selected) return;
              if (newId === selected.id) return;
              const ids = collectIds(form);
              ids.delete(selected.id);
              if (ids.has(newId)) {
                setError(`Question id "${newId}" is already used.`);
                return;
              }
              setError(null);
              setForm((f) =>
                updateInTree(f, selected.id, (q) => ({ ...q, id: newId } as Question)),
              );
              setSelectedId(newId);
            }}
            onUpdateForm={(patch) => setForm({ ...form, ...patch })}
            onOpenImport={() => setImportOpen(true)}
          />
        </div>
      ) : (
        <div className="border-t border-border bg-surface-0">
          {/* Preview is interactive: the author should be able to
              click radios, fill in fields, add repeat instances, hit
              the page-break Next button, and see conditional logic
              fire. onSubmit is a no-op so dummy data never lands
              anywhere. */}
          <FormRuntime
            form={form}
            onSubmit={async () => {
              /* preview discards submission */
            }}
          />
        </div>
      )}

      {importOpen ? (
        <LayerImportDialog onClose={() => setImportOpen(false)} onApply={applyImported} />
      ) : null}
    </div>
  );
}

// ---- Tree mutation helpers --------------------------------------

function findById(qs: Question[], id: QuestionId): Question | null {
  for (const q of qs) {
    if (q.id === id) return q;
    if (q.type === 'group') {
      const inner = findById(q.children, id);
      if (inner) return inner;
    }
  }
  return null;
}

function mutateContainer(
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

function mapTree(
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

function updateInTree(
  form: FormSchema,
  id: QuestionId,
  fn: (q: Question) => Question,
): FormSchema {
  return {
    ...form,
    questions: mapTree(form.questions, (q) => (q.id === id ? fn(q) : q)),
  };
}

function removeFromTree(form: FormSchema, id: QuestionId): FormSchema {
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
function childrenOfContainer(
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
function rowContaining(list: Question[], targetId: QuestionId): Question[] {
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
function nextWidthFor(
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
function isLayoutType(t: QuestionType): boolean {
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
function locate(
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

function moveInTree(
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

function isDescendant(node: Question, candidateId: QuestionId): boolean {
  if (node.id === candidateId) return true;
  if (node.type !== 'group') return false;
  return node.children.some((c) => isDescendant(c, candidateId));
}

// ---- Palette ----------------------------------------------------

type PaletteGroup =
  | 'text'
  | 'numeric'
  | 'choice'
  | 'matrix'
  | 'scale'
  | 'time'
  | 'identity'
  | 'media'
  | 'spatial'
  | 'logic'
  | 'layout';

interface PaletteEntry {
  type: QuestionType;
  label: string;
  icon: typeof Type;
  group: PaletteGroup;
}

/** Display order + label for each palette group. Layout sits at the
 *  top because authors typically scaffold a form (page breaks,
 *  groups, dividers, notes) before they add the actual questions.
 *  Logic and Geometry land at the bottom because they're either
 *  advanced (calculated, hidden, acknowledge) or specialized. */
const PALETTE_GROUPS: { id: PaletteGroup; label: string }[] = [
  { id: 'layout', label: 'Layout' },
  { id: 'text', label: 'Text' },
  { id: 'numeric', label: 'Numeric' },
  { id: 'choice', label: 'Choice' },
  { id: 'matrix', label: 'Matrix' },
  { id: 'scale', label: 'Scale' },
  { id: 'time', label: 'Date & time' },
  { id: 'identity', label: 'Identity' },
  { id: 'media', label: 'Media' },
  { id: 'spatial', label: 'Geometry' },
  { id: 'logic', label: 'Logic' },
];

const PALETTE: PaletteEntry[] = [
  { type: 'text', label: 'Short text', icon: Type, group: 'text' },
  { type: 'multiline', label: 'Long text', icon: AlignLeft, group: 'text' },
  { type: 'email', label: 'Email', icon: Mail, group: 'text' },
  { type: 'url', label: 'URL', icon: Link, group: 'text' },
  { type: 'phone', label: 'Phone', icon: Phone, group: 'text' },
  { type: 'regex', label: 'Pattern', icon: Regex, group: 'text' },
  { type: 'number', label: 'Number', icon: Hash, group: 'numeric' },
  { type: 'integer', label: 'Whole number', icon: Hash, group: 'numeric' },
  { type: 'boolean', label: 'Yes / No', icon: ToggleLeft, group: 'choice' },
  { type: 'select-one', label: 'Single choice', icon: Circle, group: 'choice' },
  { type: 'select-many', label: 'Multiple choice', icon: CheckSquare, group: 'choice' },
  { type: 'matrix-single', label: 'Matrix (single)', icon: Grid3x3, group: 'matrix' },
  { type: 'matrix-multi', label: 'Matrix (multi)', icon: Grid3x3, group: 'matrix' },
  { type: 'matrix-dropdown', label: 'Matrix (dropdown)', icon: Grid3x3, group: 'matrix' },
  { type: 'matrix-rating', label: 'Matrix (rating)', icon: Grid3x3, group: 'matrix' },
  { type: 'ranking', label: 'Ranking', icon: ListOrdered, group: 'choice' },
  { type: 'rating', label: 'Rating', icon: Star, group: 'scale' },
  { type: 'likert', label: 'Likert', icon: Sliders, group: 'scale' },
  { type: 'nps', label: 'NPS (0-10)', icon: BarChart3, group: 'scale' },
  { type: 'slider', label: 'Slider', icon: Sliders, group: 'scale' },
  { type: 'date', label: 'Date', icon: Calendar, group: 'time' },
  { type: 'time', label: 'Time', icon: Clock, group: 'time' },
  { type: 'datetime', label: 'Date + time', icon: CalendarClock, group: 'time' },
  { type: 'name', label: 'Full name', icon: User, group: 'identity' },
  { type: 'address', label: 'Address', icon: Home, group: 'identity' },
  { type: 'photo', label: 'Photo', icon: Camera, group: 'media' },
  { type: 'file', label: 'File', icon: FileText, group: 'media' },
  { type: 'image-choice', label: 'Image choice', icon: Image, group: 'media' },
  { type: 'image-display', label: 'Image', icon: Image, group: 'media' },
  { type: 'image-hotspot', label: 'Image hotspot', icon: Crosshair, group: 'media' },
  { type: 'signature', label: 'Signature', icon: Type, group: 'media' },
  { type: 'geopoint', label: 'Location', icon: MapPin, group: 'spatial' },
  { type: 'geotrace', label: 'Path', icon: SplitSquareHorizontal, group: 'spatial' },
  { type: 'geoshape', label: 'Area', icon: Square, group: 'spatial' },
  { type: 'calculated', label: 'Calculated', icon: Calculator, group: 'logic' },
  { type: 'note', label: 'Note', icon: TextIcon, group: 'layout' },
  { type: 'divider', label: 'Divider', icon: Minus, group: 'layout' },
  { type: 'acknowledge', label: 'Acknowledge', icon: ShieldCheck, group: 'logic' },
  { type: 'hidden', label: 'Hidden', icon: EyeOff, group: 'logic' },
  { type: 'page', label: 'Page break', icon: Workflow, group: 'layout' },
  { type: 'group', label: 'Group / Repeat', icon: ListChecks, group: 'layout' },
];

function Palette({
  canEdit,
  onAdd,
}: {
  canEdit: boolean;
  onAdd: (type: QuestionType) => void;
}) {
  // Search query filters the palette by label or type. When non-empty
  // we auto-expand every group so matches don't hide behind a closed
  // header.
  const [query, setQuery] = useState('');
  // Per-group collapsed state. Default: all open. We keep the state
  // keyed by group id so a new group added later doesn't accidentally
  // start collapsed.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Bucket entries by group, preserving the QUESTION_TYPES order
  // within each bucket so any new schema type slots in cleanly.
  const buckets = new Map<PaletteGroup, PaletteEntry[]>();
  for (const t of QUESTION_TYPES) {
    const entry = PALETTE.find((e) => e.type === t);
    if (!entry) continue;
    const list = buckets.get(entry.group) ?? [];
    list.push(entry);
    buckets.set(entry.group, list);
  }

  const trimmed = query.trim().toLowerCase();
  const isSearching = trimmed.length > 0;

  function matches(entry: PaletteEntry): boolean {
    if (!isSearching) return true;
    return (
      entry.label.toLowerCase().includes(trimmed) ||
      entry.type.toLowerCase().includes(trimmed)
    );
  }

  function toggleGroup(id: string) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <aside className="border-b border-border bg-surface-2/40 p-3 lg:sticky lg:top-0 lg:max-h-screen lg:overflow-y-auto lg:border-b-0 lg:border-r">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted">
        Add a question
      </p>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search question types"
          className="block h-8 w-full rounded-md border border-border bg-surface-1 pl-7 pr-7 text-xs text-ink-1 placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:bg-surface-2"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <div className="space-y-2">
        {PALETTE_GROUPS.map((g) => {
          const entries = buckets.get(g.id);
          if (!entries || entries.length === 0) return null;
          const visible = entries.filter(matches);
          // Hide a group entirely when searching and nothing matches.
          if (isSearching && visible.length === 0) return null;
          // While searching, force-open so matches are reachable.
          const isOpen = isSearching ? true : !collapsed[g.id];
          return (
            <div key={g.id}>
              <button
                type="button"
                onClick={() => toggleGroup(g.id)}
                disabled={isSearching}
                className="flex w-full items-center gap-1 px-0.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted/80 hover:text-ink-1 disabled:cursor-default disabled:opacity-90"
              >
                {isOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <span>{g.label}</span>
                <span className="ml-auto text-[10px] tabular-nums text-muted/60">
                  {isSearching ? `${visible.length}` : entries.length}
                </span>
              </button>
              {isOpen ? (
                <div className="mt-1 flex flex-wrap gap-1.5 lg:flex-col">
                  {visible.map((entry) => {
                    const Icon = entry.icon;
                    return (
                      <button
                        type="button"
                        key={entry.type}
                        draggable={canEdit}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/x-question-type', entry.type);
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        onClick={() => canEdit && onAdd(entry.type)}
                        disabled={!canEdit}
                        className="inline-flex w-full items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                      >
                        <Icon className="h-3.5 w-3.5 text-muted" />
                        <span className="truncate text-left">{entry.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
        {isSearching &&
        Array.from(buckets.values()).flat().filter(matches).length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted">
            No question types match &quot;{query}&quot;.
          </p>
        ) : null}
      </div>
    </aside>
  );
}

// ---- Canvas (recursive) -----------------------------------------

interface CanvasCallbacks {
  selectedId: QuestionId | null;
  canEdit: boolean;
  layerSchema: LayerSchema | null;
  isLinked: boolean;
  onSelect: (id: QuestionId) => void;
  onRemove: (id: QuestionId) => void;
  onAddInto: (
    type: QuestionType,
    containerId: QuestionId | null,
    index?: number,
  ) => void;
  onShareRow: (
    targetId: QuestionId,
    src:
      | { kind: 'new'; type: QuestionType }
      | { kind: 'existing'; id: QuestionId },
  ) => void;
  onMove: (
    sourceId: QuestionId,
    target: { containerId: QuestionId | null; index: number },
  ) => void;
}

function Canvas({
  form,
  onOpenImport,
  ...cb
}: { form: FormSchema; onOpenImport: () => void } & CanvasCallbacks) {
  // Last-resort drop target: anywhere in the canvas's whitespace.
  // Child drop slots stopPropagation so this only fires when the
  // user drops on empty area (e.g. below the last question, or in
  // the gutter after scrolling the palette to find a tile and the
  // form is short). Falls through to "append to top-level form".
  function onCanvasDrop(e: React.DragEvent<HTMLElement>) {
    if (!cb.canEdit) return;
    const newType = e.dataTransfer.getData('text/x-question-type');
    const sourceId = e.dataTransfer.getData('text/x-reorder-id');
    if (!newType && !sourceId) return;
    e.preventDefault();
    if (newType) {
      cb.onAddInto(newType as QuestionType, null);
    } else if (sourceId) {
      cb.onMove(sourceId, {
        containerId: null,
        index: form.questions.length,
      });
    }
  }
  return (
    <main
      className="min-h-[420px] border-b border-border bg-surface-0 p-4 lg:border-b-0"
      onDragOver={(e) => {
        if (!cb.canEdit) return;
        e.preventDefault();
      }}
      onDrop={onCanvasDrop}
    >
      {form.questions.length === 0 ? (
        <EmptyCanvas
          canEdit={cb.canEdit}
          onAddType={(t) => cb.onAddInto(t, null)}
          onMoveTop={(id) => cb.onMove(id, { containerId: null, index: 0 })}
          onOpenImport={onOpenImport}
        />
      ) : (
        <QuestionList list={form.questions} containerId={null} {...cb} />
      )}
    </main>
  );
}

function EmptyCanvas({
  canEdit,
  onAddType,
  onMoveTop,
  onOpenImport,
}: {
  canEdit: boolean;
  onAddType: (t: QuestionType) => void;
  onMoveTop: (id: QuestionId) => void;
  onOpenImport: () => void;
}) {
  return (
    <div
      className="flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-surface-1 text-center text-sm text-muted"
      onDragOver={(e) => {
        if (canEdit) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        // CRITICAL: stopPropagation is what prevents the same drop
        // event from also firing on the parent <main>'s onDrop, which
        // would call cb.onAddInto a second time and add the question
        // twice. Without it, a single drop on a blank form produces
        // two questions with sequential ids ("note", "note_2").
        e.stopPropagation();
        const newType = e.dataTransfer.getData('text/x-question-type');
        const sourceId = e.dataTransfer.getData('text/x-reorder-id');
        if (newType) onAddType(newType as QuestionType);
        else if (sourceId) onMoveTop(sourceId);
      }}
    >
      <Plus className="h-5 w-5" />
      <span>Drag a question type from the left, or tap one to add it.</span>
      {canEdit ? (
        <button
          type="button"
          onClick={onOpenImport}
          className="mt-1 inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
        >
          <Database className="h-3.5 w-3.5" />
          Or link to a data layer
        </button>
      ) : null}
    </div>
  );
}

function QuestionList({
  list,
  containerId,
  ...cb
}: { list: Question[]; containerId: QuestionId | null } & CanvasCallbacks) {
  // Mirror the runtime's row-packing so the design view shows
  // questions side-by-side when the author has set narrower widths.
  // Each row becomes a flex container; insert-before drop slots go
  // ABOVE each row (and there's a trailing drop slot at the bottom).
  // We don't offer drop targets between cells in the same row to
  // keep the drag-drop story simple -- if you need to insert a
  // question between two side-by-side ones, drop at the row above
  // and reorder, or temporarily widen one to break the row.
  const rows = packIntoRows(list);
  // We need each question's absolute index in the flat `list` for
  // the drop targets, not its index within the row.
  const indexOf = new Map(list.map((q, i) => [q.id, i]));
  return (
    <ul className="space-y-2">
      {rows.map((row, ri) => {
        const firstId = row[0]!.id;
        const firstIdx = indexOf.get(firstId) ?? 0;
        return (
          <li key={`row-${ri}-${firstId}`}>
            <DropSlot
              containerId={containerId}
              index={firstIdx}
              canEdit={cb.canEdit}
              onAddType={(t) => cb.onAddInto(t, containerId, firstIdx)}
              onMove={(id) =>
                cb.onMove(id, { containerId, index: firstIdx })
              }
            />
            {row.length === 1 ? (
              <QuestionRow
                q={row[0]!}
                index={firstIdx}
                containerId={containerId}
                {...cb}
              />
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch">
                {row.map((q) => {
                  const idx = indexOf.get(q.id) ?? 0;
                  return (
                    <div
                      key={q.id}
                      className={`min-w-0 ${widthToClass(q.layout?.width)}`}
                    >
                      <QuestionRow
                        q={q}
                        index={idx}
                        containerId={containerId}
                        {...cb}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </li>
        );
      })}
      <li>
        <DropSlot
          containerId={containerId}
          index={list.length}
          canEdit={cb.canEdit}
          onAddType={(t) => cb.onAddInto(t, containerId, list.length)}
          onMove={(id) => cb.onMove(id, { containerId, index: list.length })}
        />
      </li>
    </ul>
  );
}

function DropSlot({
  containerId: _containerId,
  index: _index,
  canEdit,
  onAddType,
  onMove,
}: {
  containerId: QuestionId | null;
  index: number;
  canEdit: boolean;
  onAddType: (t: QuestionType) => void;
  onMove: (sourceId: QuestionId) => void;
}) {
  const [over, setOver] = useState(false);
  if (!canEdit) return null;
  return (
    <div
      className={`h-3 rounded transition ${
        over ? 'bg-accent/30' : 'bg-transparent'
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const newType = e.dataTransfer.getData('text/x-question-type');
        const sourceId = e.dataTransfer.getData('text/x-reorder-id');
        if (newType) onAddType(newType as QuestionType);
        else if (sourceId) onMove(sourceId);
      }}
    />
  );
}

function QuestionRow({
  q,
  index,
  containerId,
  selectedId,
  canEdit,
  layerSchema,
  isLinked,
  onSelect,
  onRemove,
  onAddInto,
  onShareRow,
  onMove,
}: {
  q: Question;
  index: number;
  containerId: QuestionId | null;
} & CanvasCallbacks) {
  const [overTop, setOverTop] = useState(false);

  // Drop onto a question card. For "real" questions (anything that
  // accepts a value), the gesture means "share a row with this one":
  // the target and its existing row-mates get rebalanced to equal
  // fractions and the source slots in next to the target. For
  // structural / display-only types (group, page, note, divider,
  // hidden, image-display) sharing a row makes no sense, so we
  // preserve the older insert-before behavior.
  const isStructural =
    q.type === 'group' ||
    q.type === 'page' ||
    q.type === 'note' ||
    q.type === 'divider' ||
    q.type === 'hidden' ||
    q.type === 'image-display';

  function onTopDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setOverTop(false);
    const newType = e.dataTransfer.getData('text/x-question-type');
    const sourceId = e.dataTransfer.getData('text/x-reorder-id');
    if (isStructural) {
      // Drop onto a structural row -> insert immediately before it.
      if (newType) onAddInto(newType as QuestionType, containerId, index);
      else if (sourceId && sourceId !== q.id) {
        onMove(sourceId, { containerId, index });
      }
      return;
    }
    // Drop onto a real question -> share-row gesture.
    if (newType) {
      onShareRow(q.id, { kind: 'new', type: newType as QuestionType });
    } else if (sourceId && sourceId !== q.id) {
      onShareRow(q.id, { kind: 'existing', id: sourceId });
    }
  }

  return (
    <div
      className={`relative h-full rounded-md border ${
        q.id === selectedId
          ? 'border-accent ring-2 ring-accent/30'
          : 'border-border'
      } bg-surface-1 p-3 ${overTop ? 'border-accent' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(q.id);
        }}
        onDragOver={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          e.stopPropagation();
          setOverTop(true);
        }}
        onDragLeave={() => setOverTop(false)}
        onDrop={onTopDrop}
      >
        <div className="flex items-start gap-2">
          {canEdit ? (
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/x-reorder-id', q.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              className="cursor-grab text-muted hover:text-ink-0"
              aria-label="Drag to reorder"
            >
              <GripVertical className="h-4 w-4" />
            </button>
          ) : null}
          <div className="flex-1">
            <p className="text-xs uppercase tracking-wide text-muted">
              {q.type} · <span className="font-mono">{q.id}</span>
              {q.type === 'group' && q.repeat ? (
                <span className="ml-1.5 inline-flex rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-accent">
                  repeat
                </span>
              ) : null}
              {q.type === 'group' && isAttachmentGroup(q, layerSchema) ? (
                <span
                  title="This group binds to the layer's attachments. Each instance is one attached file plus any per-attachment fields you add."
                  className="ml-1.5 inline-flex rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-emerald-800"
                >
                  attachment
                </span>
              ) : null}
              <LinkStatusBadge status={questionLinkStatus(q, layerSchema, isLinked)} />
            </p>
            <p className="text-sm font-medium text-ink-0">{q.label}</p>
            {q.hint ? <p className="text-xs text-muted">{q.hint}</p> : null}
            {/* Inline preview of the question's input UI. Renders
                the same component the runtime would, wrapped in a
                pointer-events-none div so clicks still hit the
                row's selection handler. Authors see what their
                form looks like without flipping to Preview. */}
            {q.type !== 'group' && q.type !== 'page' && q.type !== 'hidden' ? (
              <div className="mt-2">
                <QuestionPreview q={q} />
              </div>
            ) : null}
          </div>
          {canEdit ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(q.id);
              }}
              className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
              aria-label="Remove question"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        {/* Group children rendered inside the row, so dropping on
            the group adds to its children, not to the parent. */}
      {q.type === 'group' ? (
        <div
          className="mt-3 rounded border border-dashed border-border bg-surface-2/30 p-2"
          onClick={(e) => e.stopPropagation()}
            onDragOver={(e) => {
              if (!canEdit) return;
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              if (!canEdit) return;
              e.preventDefault();
              e.stopPropagation();
              const newType = e.dataTransfer.getData('text/x-question-type');
              const sourceId = e.dataTransfer.getData('text/x-reorder-id');
              if (newType) onAddInto(newType as QuestionType, q.id);
              else if (sourceId && sourceId !== q.id) {
                onMove(sourceId, { containerId: q.id, index: q.children.length });
              }
            }}
          >
            {/* Hint inside attachment groups so authors understand
                that anything they add becomes a per-attachment field
                stored alongside the file (caption, taken-by, GPS at
                capture time, etc.) -- not a feature attribute. */}
            {isAttachmentGroup(q, layerSchema) ? (
              <p className="mb-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-900">
                Each value here is captured per attachment, alongside the
                file. Add per-attachment fields like caption, taken-by, or
                GPS-at-capture.
              </p>
            ) : null}
            {q.children.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-muted">
                Drop questions here.
              </p>
            ) : (
              <QuestionList
                list={q.children}
                containerId={q.id}
                selectedId={selectedId}
                canEdit={canEdit}
                layerSchema={layerSchema}
                isLinked={isLinked}
                onSelect={onSelect}
                onRemove={onRemove}
                onAddInto={onAddInto}
                onShareRow={onShareRow}
                onMove={onMove}
              />
            )}
        </div>
      ) : null}
    </div>
  );
}

// ---- Properties -------------------------------------------------

function Properties({
  form,
  question,
  canEdit,
  layerSchema,
  onChange,
  onRename,
  onUpdateForm,
  onOpenImport,
  onUnlinkLayer,
}: {
  form: FormSchema;
  question: Question | null;
  canEdit: boolean;
  layerSchema: LayerSchema | null;
  onChange: (patch: Partial<Question>) => void;
  onRename: (newId: string) => void;
  onUpdateForm: (patch: Partial<FormSchema>) => void;
  onOpenImport: () => void;
  onUnlinkLayer: () => void;
}) {
  if (!question) {
    return (
      <aside className="border-l border-border bg-surface-2/40 p-3 lg:sticky lg:top-0 lg:max-h-screen lg:overflow-y-auto">
        <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted">
          Form
        </p>
        <Field label="Description">
          <textarea
            rows={3}
            value={form.description ?? ''}
            disabled={!canEdit}
            onChange={(e) => onUpdateForm({ description: e.target.value })}
            className={inputCls}
          />
        </Field>
        {form.linkedLayerId ? (
          <LinkedLayerSummary
            form={form}
            layerSchema={layerSchema}
            canEdit={canEdit}
            onUnlinkLayer={onUnlinkLayer}
          />
        ) : canEdit ? (
          <button
            type="button"
            onClick={onOpenImport}
            className="mb-3 inline-flex h-8 w-full items-center justify-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            <Database className="h-3.5 w-3.5" />
            Link to a data layer
          </button>
        ) : null}
        <p className="mt-1 text-[11px] text-muted">
          Select a question on the left to edit it.
        </p>
      </aside>
    );
  }
  return (
    <aside className="border-l border-border bg-surface-2/40 p-3 lg:sticky lg:top-0 lg:max-h-screen lg:overflow-y-auto">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted">
        {question.type} properties
      </p>

      {/* Notes are display-only and the runtime renders just `label`,
          so for them we (a) relabel "Label" to "Note text" so authors
          stop hunting for a separate body field, (b) make it a
          multi-line textarea since note bodies are typically a
          paragraph, and (c) hide the Hint and Required fields below,
          which don't apply to a question that captures no value. */}
      {question.type === 'note' ? (
        <Field
          label="Note text"
          hint="Shown to the responder. The body of the note."
        >
          <textarea
            rows={4}
            value={question.label}
            disabled={!canEdit}
            onChange={(e) => onChange({ label: e.target.value })}
            className={inputCls}
          />
        </Field>
      ) : (
        <Field label="Label">
          <input
            type="text"
            value={question.label}
            disabled={!canEdit}
            onChange={(e) => onChange({ label: e.target.value })}
            className={inputCls}
          />
        </Field>
      )}

      <Field label="Question id" hint="Used as the column name in the layer schema.">
        <input
          type="text"
          value={question.id}
          disabled={!canEdit}
          onChange={(e) => onRename(e.target.value)}
          className={`${inputCls} font-mono`}
        />
      </Field>

      {question.type === 'note' ? null : (
        <Field label="Hint">
          <textarea
            rows={2}
            value={question.hint ?? ''}
            disabled={!canEdit}
            onChange={(e) => onChange({ hint: e.target.value || undefined })}
            className={inputCls}
          />
        </Field>
      )}

      {/* Layout / display-only types don't capture a value, so
          "Required" is meaningless for them. Hiding the checkbox
          keeps authors from setting a flag the runtime would
          silently ignore. Covers note + divider + page + group +
          image-display + hidden (the last is interesting because
          a hidden question CAN carry a calculated value, but
          enforcing required on something the user can't see is a
          footgun the runtime currently doesn't even check). */}
      {isLayoutType(question.type) ? null : (
        <label className="mb-2 inline-flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={Boolean(question.required)}
            disabled={!canEdit}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          <span>Required</span>
        </label>
      )}

      {question.type !== 'page' && question.type !== 'group' ? (
        <Field label="Width" hint="Width on desktop. Mobile collapses to full.">
          <select
            value={question.layout?.width ?? 'full'}
            disabled={!canEdit}
            onChange={(e) => {
              const v = e.target.value as
                | 'full'
                | 'half'
                | 'third'
                | 'two-thirds'
                | 'quarter'
                | 'three-quarters';
              onChange({
                layout: v === 'full' ? undefined : { width: v },
              });
            }}
            className={inputCls}
          >
            <option value="full">Full</option>
            <option value="half">1 / 2</option>
            <option value="third">1 / 3</option>
            <option value="two-thirds">2 / 3</option>
            <option value="quarter">1 / 4</option>
            <option value="three-quarters">3 / 4</option>
          </select>
        </Field>
      ) : null}

      {question.type === 'select-one' || question.type === 'select-many' ? (
        <ChoicesEditor
          choices={question.choices}
          canEdit={canEdit}
          onChange={(choices) => onChange({ choices } as Partial<Question>)}
        />
      ) : null}

      {question.type === 'matrix-single' || question.type === 'matrix-multi' ? (
        <MatrixEditor
          rows={question.rows}
          columns={question.columns}
          canEdit={canEdit}
          onChange={(patch) => onChange(patch as Partial<Question>)}
        />
      ) : null}

      {question.type === 'matrix-single' ? (
        <label className="mb-2 inline-flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={Boolean(question.perRowRequired)}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({ perRowRequired: e.target.checked } as Partial<Question>)
            }
          />
          <span>Require an answer for every row</span>
        </label>
      ) : null}

      {question.type === 'matrix-multi' ? (
        <div className="mb-2 grid grid-cols-2 gap-2">
          <Field label="Min per row">
            <input
              type="number"
              min={0}
              value={question.perRowMinSelected ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({
                  perRowMinSelected:
                    e.target.value === '' ? undefined : Number(e.target.value),
                } as Partial<Question>)
              }
              className={inputCls}
            />
          </Field>
          <Field label="Max per row">
            <input
              type="number"
              min={0}
              value={question.perRowMaxSelected ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({
                  perRowMaxSelected:
                    e.target.value === '' ? undefined : Number(e.target.value),
                } as Partial<Question>)
              }
              className={inputCls}
            />
          </Field>
        </div>
      ) : null}

      {question.type === 'matrix-dropdown' ? (
        <MatrixDropdownEditor
          rows={question.rows}
          columns={question.columns}
          canEdit={canEdit}
          onChange={(patch) => onChange(patch as Partial<Question>)}
        />
      ) : null}

      {question.type === 'matrix-rating' ? (
        <>
          <MatrixRowsEditor
            rows={question.rows}
            canEdit={canEdit}
            onChange={(rows) => onChange({ rows } as Partial<Question>)}
          />
          <div className="mb-2 grid grid-cols-2 gap-2">
            <Field label="Max stars">
              <input
                type="number"
                min={1}
                max={10}
                value={question.max ?? 5}
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({ max: Number(e.target.value) } as Partial<Question>)
                }
                className={inputCls}
              />
            </Field>
            <Field label="Shape">
              <select
                value={question.shape ?? 'star'}
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({
                    shape: e.target.value as 'star' | 'heart' | 'thumb',
                  } as Partial<Question>)
                }
                className={inputCls}
              >
                <option value="star">Star</option>
                <option value="heart">Heart</option>
                <option value="thumb">Thumb</option>
              </select>
            </Field>
          </div>
          <label className="mb-2 inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={Boolean(question.perRowRequired)}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({ perRowRequired: e.target.checked } as Partial<Question>)
              }
            />
            <span>Require an answer for every row</span>
          </label>
        </>
      ) : null}

      {question.type === 'ranking' ? (
        <>
          <ChoicesEditor
            choices={question.choices}
            canEdit={canEdit}
            onChange={(choices) => onChange({ choices } as Partial<Question>)}
          />
          <div className="mb-2 grid grid-cols-2 gap-2">
            <Field label="Min ranked">
              <input
                type="number"
                min={0}
                value={question.minRanked ?? ''}
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({
                    minRanked:
                      e.target.value === '' ? undefined : Number(e.target.value),
                  } as Partial<Question>)
                }
                className={inputCls}
              />
            </Field>
            <Field label="Max ranked">
              <input
                type="number"
                min={0}
                value={question.maxRanked ?? ''}
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({
                    maxRanked:
                      e.target.value === '' ? undefined : Number(e.target.value),
                  } as Partial<Question>)
                }
                className={inputCls}
              />
            </Field>
          </div>
        </>
      ) : null}

      {question.type === 'number' || question.type === 'integer' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Min">
            <input
              type="number"
              value={question.min ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({
                  min: e.target.value === '' ? undefined : Number(e.target.value),
                } as Partial<Question>)
              }
              className={inputCls}
            />
          </Field>
          <Field label="Max">
            <input
              type="number"
              value={question.max ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({
                  max: e.target.value === '' ? undefined : Number(e.target.value),
                } as Partial<Question>)
              }
              className={inputCls}
            />
          </Field>
        </div>
      ) : null}

      {question.type === 'text' ||
      question.type === 'multiline' ||
      question.type === 'email' ||
      question.type === 'url' ||
      question.type === 'regex' ? (
        <Field label="Max length">
          <input
            type="number"
            value={question.maxLength ?? ''}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({
                maxLength: e.target.value === '' ? undefined : Number(e.target.value),
              } as Partial<Question>)
            }
            className={inputCls}
          />
        </Field>
      ) : null}

      {question.type === 'regex' ? (
        <>
          <Field label="Pattern" hint="Regex applied with implicit ^...$ anchors.">
            <input
              type="text"
              value={question.pattern}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({ pattern: e.target.value } as Partial<Question>)
              }
              className={`${inputCls} font-mono`}
            />
          </Field>
          <Field label="Flags" hint='e.g. "i" for case-insensitive.'>
            <input
              type="text"
              value={question.flags ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({ flags: e.target.value || undefined } as Partial<Question>)
              }
              className={`${inputCls} font-mono`}
              maxLength={6}
            />
          </Field>
          <Field label="Error message">
            <input
              type="text"
              value={question.message ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({ message: e.target.value || undefined } as Partial<Question>)
              }
              className={inputCls}
            />
          </Field>
        </>
      ) : null}

      {question.type === 'group' ? (
        <GroupRepeatEditor
          q={question}
          canEdit={canEdit}
          {...(hasAttachmentAncestor(form, question.id, layerSchema)
            ? {
                lockedReason:
                  "This group is inside an attachment group. Each attachment is already one repeat instance, so a nested repeat here would mean attachment-of-attachment, which the data model doesn't support. Use this group as a non-repeating section instead.",
              }
            : {})}
          onChange={(repeat) => onChange({ repeat } as Partial<Question>)}
        />
      ) : null}

      {question.type === 'likert' ? (
        <>
          <Field label="Number of points" hint="Common: 5 (default) or 7.">
            <input
              type="number"
              min={2}
              max={10}
              value={question.points ?? 5}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({ points: Number(e.target.value) } as Partial<Question>)
              }
              className={inputCls}
            />
          </Field>
          <div className="mb-2 grid grid-cols-2 gap-2">
            <Field label="Left label">
              <input
                type="text"
                value={question.leftLabel ?? ''}
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({ leftLabel: e.target.value || undefined } as Partial<Question>)
                }
                className={inputCls}
              />
            </Field>
            <Field label="Right label">
              <input
                type="text"
                value={question.rightLabel ?? ''}
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({ rightLabel: e.target.value || undefined } as Partial<Question>)
                }
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="Center label" hint="Optional middle anchor (e.g. Neutral).">
            <input
              type="text"
              value={question.centerLabel ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({ centerLabel: e.target.value || undefined } as Partial<Question>)
              }
              className={inputCls}
            />
          </Field>
        </>
      ) : null}

      {question.type === 'nps' ? (
        <Field label="Caption" hint='e.g. "How likely are you to recommend us?"'>
          <input
            type="text"
            value={question.caption ?? ''}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({ caption: e.target.value || undefined } as Partial<Question>)
            }
            className={inputCls}
          />
        </Field>
      ) : null}

      {question.type === 'name' ? (
        <ComponentToggleEditor
          label="Components"
          allComponents={[
            { value: 'prefix', label: 'Prefix' },
            { value: 'first', label: 'First name' },
            { value: 'middle', label: 'Middle name' },
            { value: 'last', label: 'Last name' },
            { value: 'suffix', label: 'Suffix' },
          ]}
          components={question.components ?? ['first', 'last']}
          requiredComponents={question.requiredComponents}
          canEdit={canEdit}
          onChangeComponents={(components) =>
            onChange({ components } as Partial<Question>)
          }
          onChangeRequired={(requiredComponents) =>
            onChange({
              requiredComponents:
                requiredComponents.length === 0 ? undefined : requiredComponents,
            } as Partial<Question>)
          }
        />
      ) : null}

      {question.type === 'file' ? (
        <>
          <div className="mb-2 grid grid-cols-2 gap-2">
            <Field label="Max files">
              <input
                type="number"
                min={1}
                value={question.maxCount ?? 1}
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({
                    maxCount: Number(e.target.value),
                  } as Partial<Question>)
                }
                className={inputCls}
              />
            </Field>
            <Field label="Max bytes">
              <input
                type="number"
                min={0}
                value={question.maxBytes ?? ''}
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({
                    maxBytes:
                      e.target.value === '' ? undefined : Number(e.target.value),
                  } as Partial<Question>)
                }
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="Accept" hint='e.g. ".pdf,application/pdf"'>
            <input
              type="text"
              value={question.accept ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({
                  accept: e.target.value || undefined,
                } as Partial<Question>)
              }
              className={inputCls}
            />
          </Field>
        </>
      ) : null}

      {question.type === 'image-display' || question.type === 'image-hotspot' ? (
        <Field label="Image URL">
          <input
            type="url"
            value={question.imageUrl}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({ imageUrl: e.target.value } as Partial<Question>)
            }
            className={inputCls}
          />
        </Field>
      ) : null}

      {question.type === 'image-display' ? (
        <Field label="Caption">
          <input
            type="text"
            value={question.caption ?? ''}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({ caption: e.target.value || undefined } as Partial<Question>)
            }
            className={inputCls}
          />
        </Field>
      ) : null}

      {question.type === 'image-hotspot' ? (
        <Field label="Max points">
          <input
            type="number"
            min={1}
            max={50}
            value={question.maxPoints ?? 1}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({ maxPoints: Number(e.target.value) } as Partial<Question>)
            }
            className={inputCls}
          />
        </Field>
      ) : null}

      {question.type === 'divider' ? (
        <Field label="Caption">
          <input
            type="text"
            value={question.caption ?? ''}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({ caption: e.target.value || undefined } as Partial<Question>)
            }
            className={inputCls}
          />
        </Field>
      ) : null}

      {question.type === 'acknowledge' ? (
        <>
          <Field label="Body" hint="Long-form text shown above the checkbox.">
            <textarea
              rows={4}
              value={question.body}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({ body: e.target.value } as Partial<Question>)
              }
              className={inputCls}
            />
          </Field>
          <Field label="Agree label">
            <input
              type="text"
              value={question.agreeLabel ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({
                  agreeLabel: e.target.value || undefined,
                } as Partial<Question>)
              }
              className={inputCls}
            />
          </Field>
        </>
      ) : null}

      {question.type === 'hidden' ? (
        <Field label="Default value" hint="Used when prefill / calculate doesn't set a value.">
          <input
            type="text"
            value={
              question.defaultValue === null || question.defaultValue === undefined
                ? ''
                : String(question.defaultValue)
            }
            disabled={!canEdit}
            onChange={(e) =>
              onChange({
                defaultValue: e.target.value === '' ? undefined : e.target.value,
              } as Partial<Question>)
            }
            className={inputCls}
          />
        </Field>
      ) : null}

      {question.type === 'image-choice' ? (
        <>
          <label className="mb-2 inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={Boolean(question.multi)}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({ multi: e.target.checked } as Partial<Question>)
              }
            />
            <span>Allow multiple selections</span>
          </label>
          <ImageChoicesEditor
            choices={question.choices}
            canEdit={canEdit}
            onChange={(choices) => onChange({ choices } as Partial<Question>)}
          />
        </>
      ) : null}

      {question.type === 'address' ? (
        <ComponentToggleEditor
          label="Components"
          allComponents={[
            { value: 'street1', label: 'Street address' },
            { value: 'street2', label: 'Apt / suite' },
            { value: 'city', label: 'City' },
            { value: 'region', label: 'State / region' },
            { value: 'postal', label: 'Postal code' },
            { value: 'country', label: 'Country' },
          ]}
          components={
            question.components ?? [
              'street1',
              'street2',
              'city',
              'region',
              'postal',
              'country',
            ]
          }
          requiredComponents={question.requiredComponents}
          canEdit={canEdit}
          onChangeComponents={(components) =>
            onChange({ components } as Partial<Question>)
          }
          onChangeRequired={(requiredComponents) =>
            onChange({
              requiredComponents:
                requiredComponents.length === 0 ? undefined : requiredComponents,
            } as Partial<Question>)
          }
        />
      ) : null}

      <details className="mt-3 rounded-md border border-border bg-surface-1 p-2 text-xs">
        <summary className="cursor-pointer text-muted">Conditional logic</summary>
        <div className="mt-2 space-y-3">
          {/* `key` forces a fresh editor instance when the selected
              question changes. The editor holds local row state
              (so partially-filled rows survive across "Add
              condition" clicks); without the key, that local state
              would leak across questions. */}
          <ExpressionEditor
            key={`${question.id}:visibleIf`}
            label="Visible if"
            value={question.visibleIf}
            // Exclude the current question. A "visible if Species
            // equals X" expression on the Species question itself is
            // a self-reference: technically defined (it reads its own
            // captured value) but almost always an authoring mistake.
            // The legitimate use-case (hide a calculated read-only
            // field based on its own computed value) is rare enough
            // that we'd rather force the author to introduce a
            // helper field than expose the footgun by default.
            allFields={collectFieldRefs(form).filter(
              (f) => f.id !== question.id,
            )}
            disabled={!canEdit}
            onChange={(visibleIf) => onChange({ visibleIf })}
          />
          {/* Constraint (validation) -- new in #162 Slice 1. The
              schema has supported `constraint?: Expression` on
              QuestionBase for a while, but the designer never
              exposed it. Wired through the same row-based editor as
              Visible-if so the two affordances behave the same.
              Self-reference is fine here: a constraint OF COURSE
              reads the question's own value (it's "is this answer
              valid"). */}
          <ExpressionEditor
            key={`${question.id}:constraint`}
            label="Valid if"
            value={question.constraint}
            allFields={collectFieldRefs(form)}
            disabled={!canEdit}
            onChange={(constraint) =>
              onChange({ constraint } as Partial<Question>)
            }
          />
        </div>
      </details>
    </aside>
  );
}

/**
 * Richer field reference for pickers in the expression editor: id,
 * label, type, and the "parent path" (the chain of group labels
 * leading to the question, "/"-separated). Two questions sharing a
 * label are still distinguishable because the dropdown also shows
 * the id and the parent path. This replaces the older
 * `collectIdLabelPairs` which collapsed duplicate labels into an
 * indistinguishable mush in the visible-if dropdown -- the symptom
 * Matt called out (two "Group" / "Photo" entries sitting next to
 * each other with no way to tell them apart).
 */
interface FieldRef {
  id: string;
  label: string;
  type: QuestionType;
  parentPath: string; // empty for top-level questions
}

function collectFieldRefs(form: FormSchema): FieldRef[] {
  const out: FieldRef[] = [];
  function walk(qs: Question[], path: string[]) {
    for (const q of qs) {
      out.push({
        id: q.id,
        label: q.label,
        type: q.type,
        parentPath: path.join(' / '),
      });
      if (q.type === 'group') {
        walk(q.children, [...path, q.label || q.id]);
      }
    }
  }
  walk(form.questions, []);
  return out;
}


function GroupRepeatEditor({
  q,
  canEdit,
  lockedReason,
  onChange,
}: {
  q: Extract<Question, { type: 'group' }>;
  canEdit: boolean;
  /**
   * If set, the repeat toggle is force-disabled and the reason is
   * shown to the author. Used today to keep authors from making a
   * group repeat when it's nested inside an attachment group: the
   * data model treats one attachment row as one repeat instance,
   * and "repeat inside attachment" would imply attachment-of-
   * attachment, which isn't supported.
   */
  lockedReason?: string;
  onChange: (repeat: Extract<Question, { type: 'group' }>['repeat']) => void;
}) {
  const enabled = Boolean(q.repeat);
  const locked = Boolean(lockedReason);
  return (
    <div className="mt-2 rounded-md border border-border bg-surface-1 p-2 text-xs">
      <label className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canEdit || locked}
          onChange={(e) =>
            onChange(e.target.checked ? { min: 0, addLabel: 'Add another' } : undefined)
          }
        />
        <span>Repeat (capture multiple instances)</span>
      </label>
      {locked ? (
        <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
          {lockedReason}
        </p>
      ) : null}
      {enabled && q.repeat ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Field label="Min instances">
            <input
              type="number"
              min={0}
              value={q.repeat.min ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({
                  ...q.repeat,
                  min: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
              className={inputCls}
            />
          </Field>
          <Field label="Max instances">
            <input
              type="number"
              min={0}
              value={q.repeat.max ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({
                  ...q.repeat,
                  max: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
              className={inputCls}
            />
          </Field>
          <div className="col-span-2">
            <Field label='"Add another" button label'>
              <input
                type="text"
                value={q.repeat.addLabel ?? ''}
                disabled={!canEdit}
                placeholder="Add another"
                onChange={(e) =>
                  onChange({
                    ...q.repeat,
                    addLabel: e.target.value || undefined,
                  })
                }
                className={inputCls}
              />
            </Field>
          </div>
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-muted">
          Off: questions inside the group capture once. On: respondents can add
          multiple instances (a "child rows" pattern).
        </p>
      )}
    </div>
  );
}

const inputCls =
  'block w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-2 block text-xs">
      <span className="mb-0.5 block uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
      {hint ? <p className="mt-0.5 text-[11px] text-muted">{hint}</p> : null}
    </label>
  );
}

function ChoicesEditor({
  choices,
  canEdit,
  onChange,
}: {
  choices: Choice[];
  canEdit: boolean;
  onChange: (next: Choice[]) => void;
}) {
  return (
    <div className="mb-2">
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">Choices</p>
      <div className="space-y-1">
        {choices.map((c, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              type="text"
              value={c.value}
              placeholder="value"
              disabled={!canEdit}
              onChange={(e) =>
                onChange(
                  choices.map((cc, ii) =>
                    ii === i ? { ...cc, value: e.target.value } : cc,
                  ),
                )
              }
              className={`${inputCls} font-mono w-24`}
            />
            <input
              type="text"
              value={c.label}
              placeholder="label"
              disabled={!canEdit}
              onChange={(e) =>
                onChange(
                  choices.map((cc, ii) =>
                    ii === i ? { ...cc, label: e.target.value } : cc,
                  ),
                )
              }
              className={`${inputCls} flex-1`}
            />
            {canEdit ? (
              <button
                type="button"
                onClick={() => onChange(choices.filter((_, ii) => ii !== i))}
                className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                aria-label="Remove choice"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        ))}
        {canEdit ? (
          <button
            type="button"
            onClick={() =>
              onChange([
                ...choices,
                { value: `option_${choices.length + 1}`, label: `Option ${choices.length + 1}` },
              ])
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
          >
            <Plus className="h-3 w-3" />
            Add choice
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MatrixEditor({
  rows,
  columns,
  canEdit,
  onChange,
}: {
  rows: { id: string; label: string }[];
  columns: { value: string; label: string }[];
  canEdit: boolean;
  onChange: (
    patch: { rows?: typeof rows; columns?: typeof columns },
  ) => void;
}) {
  return (
    <div className="mb-3 space-y-3">
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">
          Rows
        </p>
        <div className="space-y-1">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="text"
                value={r.id}
                placeholder="row id"
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({
                    rows: rows.map((rr, ii) =>
                      ii === i ? { ...rr, id: e.target.value } : rr,
                    ),
                  })
                }
                className={`${inputCls} font-mono w-20`}
              />
              <input
                type="text"
                value={r.label}
                placeholder="row label"
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({
                    rows: rows.map((rr, ii) =>
                      ii === i ? { ...rr, label: e.target.value } : rr,
                    ),
                  })
                }
                className={`${inputCls} flex-1`}
              />
              {canEdit ? (
                <button
                  type="button"
                  onClick={() =>
                    onChange({ rows: rows.filter((_, ii) => ii !== i) })
                  }
                  className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                  aria-label="Remove row"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          ))}
          {canEdit ? (
            <button
              type="button"
              onClick={() =>
                onChange({
                  rows: [
                    ...rows,
                    {
                      id: `row_${rows.length + 1}`,
                      label: `Statement ${rows.length + 1}`,
                    },
                  ],
                })
              }
              className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
            >
              <Plus className="h-3 w-3" />
              Add row
            </button>
          ) : null}
        </div>
      </div>

      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">
          Columns
        </p>
        <div className="space-y-1">
          {columns.map((c, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="text"
                value={c.value}
                placeholder="value"
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({
                    columns: columns.map((cc, ii) =>
                      ii === i ? { ...cc, value: e.target.value } : cc,
                    ),
                  })
                }
                className={`${inputCls} font-mono w-20`}
              />
              <input
                type="text"
                value={c.label}
                placeholder="label"
                disabled={!canEdit}
                onChange={(e) =>
                  onChange({
                    columns: columns.map((cc, ii) =>
                      ii === i ? { ...cc, label: e.target.value } : cc,
                    ),
                  })
                }
                className={`${inputCls} flex-1`}
              />
              {canEdit ? (
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      columns: columns.filter((_, ii) => ii !== i),
                    })
                  }
                  className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                  aria-label="Remove column"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          ))}
          {canEdit ? (
            <button
              type="button"
              onClick={() =>
                onChange({
                  columns: [
                    ...columns,
                    {
                      value: `option_${columns.length + 1}`,
                      label: `Option ${columns.length + 1}`,
                    },
                  ],
                })
              }
              className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
            >
              <Plus className="h-3 w-3" />
              Add column
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MatrixRowsEditor({
  rows,
  canEdit,
  onChange,
}: {
  rows: { id: string; label: string }[];
  canEdit: boolean;
  onChange: (next: typeof rows) => void;
}) {
  return (
    <div className="mb-3">
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">
        Rows
      </p>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              type="text"
              value={r.id}
              placeholder="row id"
              disabled={!canEdit}
              onChange={(e) =>
                onChange(
                  rows.map((rr, ii) =>
                    ii === i ? { ...rr, id: e.target.value } : rr,
                  ),
                )
              }
              className={`${inputCls} font-mono w-20`}
            />
            <input
              type="text"
              value={r.label}
              placeholder="row label"
              disabled={!canEdit}
              onChange={(e) =>
                onChange(
                  rows.map((rr, ii) =>
                    ii === i ? { ...rr, label: e.target.value } : rr,
                  ),
                )
              }
              className={`${inputCls} flex-1`}
            />
            {canEdit ? (
              <button
                type="button"
                onClick={() => onChange(rows.filter((_, ii) => ii !== i))}
                className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                aria-label="Remove row"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        ))}
        {canEdit ? (
          <button
            type="button"
            onClick={() =>
              onChange([
                ...rows,
                {
                  id: `row_${rows.length + 1}`,
                  label: `Item ${rows.length + 1}`,
                },
              ])
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
          >
            <Plus className="h-3 w-3" />
            Add row
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Editor for `matrix-dropdown` columns. Each column has its own
 * choices, so the component is a stack of {column header, column
 * choices editor} blocks rather than the flat list MatrixEditor uses.
 */
function MatrixDropdownEditor({
  rows,
  columns,
  canEdit,
  onChange,
}: {
  rows: { id: string; label: string }[];
  columns: { value: string; label: string; choices: Choice[] }[];
  canEdit: boolean;
  onChange: (
    patch: { rows?: typeof rows; columns?: typeof columns },
  ) => void;
}) {
  return (
    <div className="mb-3 space-y-3">
      <MatrixRowsEditor
        rows={rows}
        canEdit={canEdit}
        onChange={(next) => onChange({ rows: next })}
      />
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">
          Columns (each with its own choices)
        </p>
        <div className="space-y-2">
          {columns.map((c, i) => (
            <div key={i} className="rounded-md border border-border bg-surface-1 p-2">
              <div className="mb-1 flex items-center gap-1">
                <input
                  type="text"
                  value={c.value}
                  placeholder="value"
                  disabled={!canEdit}
                  onChange={(e) =>
                    onChange({
                      columns: columns.map((cc, ii) =>
                        ii === i ? { ...cc, value: e.target.value } : cc,
                      ),
                    })
                  }
                  className={`${inputCls} font-mono w-20`}
                />
                <input
                  type="text"
                  value={c.label}
                  placeholder="label"
                  disabled={!canEdit}
                  onChange={(e) =>
                    onChange({
                      columns: columns.map((cc, ii) =>
                        ii === i ? { ...cc, label: e.target.value } : cc,
                      ),
                    })
                  }
                  className={`${inputCls} flex-1`}
                />
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() =>
                      onChange({ columns: columns.filter((_, ii) => ii !== i) })
                    }
                    className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                    aria-label="Remove column"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
              <ChoicesEditor
                choices={c.choices}
                canEdit={canEdit}
                onChange={(choices) =>
                  onChange({
                    columns: columns.map((cc, ii) =>
                      ii === i ? { ...cc, choices } : cc,
                    ),
                  })
                }
              />
            </div>
          ))}
          {canEdit ? (
            <button
              type="button"
              onClick={() =>
                onChange({
                  columns: [
                    ...columns,
                    {
                      value: `col_${columns.length + 1}`,
                      label: `Column ${columns.length + 1}`,
                      choices: [
                        { value: 'option_1', label: 'Option 1' },
                        { value: 'option_2', label: 'Option 2' },
                      ],
                    },
                  ],
                })
              }
              className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
            >
              <Plus className="h-3 w-3" />
              Add column
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Toggle which components a composite question (name / address)
 * surfaces, plus which of those are required. Two checkboxes per
 * row: "Show" and "Required". Required implies Show.
 */
/**
 * Variant of ChoicesEditor that exposes an `imageUrl` per choice
 * (and optional alt text). Same value/label inputs sit on the top
 * row, image URL underneath.
 */
function ImageChoicesEditor({
  choices,
  canEdit,
  onChange,
}: {
  choices: { value: string; label: string; imageUrl: string; alt?: string }[];
  canEdit: boolean;
  onChange: (next: typeof choices) => void;
}) {
  return (
    <div className="mb-2">
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">
        Image choices
      </p>
      <div className="space-y-2">
        {choices.map((c, i) => (
          <div key={i} className="rounded-md border border-border bg-surface-1 p-2">
            <div className="mb-1 flex items-center gap-1">
              <input
                type="text"
                value={c.value}
                placeholder="value"
                disabled={!canEdit}
                onChange={(e) =>
                  onChange(
                    choices.map((cc, ii) =>
                      ii === i ? { ...cc, value: e.target.value } : cc,
                    ),
                  )
                }
                className={`${inputCls} font-mono w-24`}
              />
              <input
                type="text"
                value={c.label}
                placeholder="label"
                disabled={!canEdit}
                onChange={(e) =>
                  onChange(
                    choices.map((cc, ii) =>
                      ii === i ? { ...cc, label: e.target.value } : cc,
                    ),
                  )
                }
                className={`${inputCls} flex-1`}
              />
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => onChange(choices.filter((_, ii) => ii !== i))}
                  className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                  aria-label="Remove choice"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            <input
              type="url"
              value={c.imageUrl}
              placeholder="https://example.com/image.jpg"
              disabled={!canEdit}
              onChange={(e) =>
                onChange(
                  choices.map((cc, ii) =>
                    ii === i ? { ...cc, imageUrl: e.target.value } : cc,
                  ),
                )
              }
              className={inputCls}
            />
          </div>
        ))}
        {canEdit ? (
          <button
            type="button"
            onClick={() =>
              onChange([
                ...choices,
                {
                  value: `option_${choices.length + 1}`,
                  label: `Option ${choices.length + 1}`,
                  imageUrl: '',
                },
              ])
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
          >
            <Plus className="h-3 w-3" />
            Add choice
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ComponentToggleEditor<T extends string>({
  label,
  allComponents,
  components,
  requiredComponents,
  canEdit,
  onChangeComponents,
  onChangeRequired,
}: {
  label: string;
  allComponents: { value: T; label: string }[];
  components: T[];
  requiredComponents: T[] | undefined;
  canEdit: boolean;
  onChangeComponents: (next: T[]) => void;
  onChangeRequired: (next: T[]) => void;
}) {
  const shown = new Set(components);
  const required = new Set(requiredComponents ?? []);
  return (
    <div className="mb-3">
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">
        {label}
      </p>
      <div className="space-y-1">
        {allComponents.map((c) => (
          <div key={c.value} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex-1 truncate">{c.label}</span>
            <label className="inline-flex items-center gap-1 text-[11px]">
              <input
                type="checkbox"
                checked={shown.has(c.value)}
                disabled={!canEdit}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChangeComponents([
                      ...allComponents
                        .map((x) => x.value)
                        .filter((v) => shown.has(v) || v === c.value),
                    ]);
                  } else {
                    onChangeComponents(components.filter((v) => v !== c.value));
                    if (required.has(c.value)) {
                      onChangeRequired(
                        Array.from(required).filter((v) => v !== c.value),
                      );
                    }
                  }
                }}
              />
              <span>Show</span>
            </label>
            <label className="inline-flex items-center gap-1 text-[11px]">
              <input
                type="checkbox"
                checked={required.has(c.value)}
                disabled={!canEdit || !shown.has(c.value)}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChangeRequired([...Array.from(required), c.value]);
                  } else {
                    onChangeRequired(
                      Array.from(required).filter((v) => v !== c.value),
                    );
                  }
                }}
              />
              <span>Required</span>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Operators the inline editor exposes for a single condition row.
 * Mirrors the AST opcodes in `Expression`. We list the comparable
 * subset (no `and`/`or`/`not`/arithmetic/concat/if): those are
 * structural and live at the row-list level, not inside a row. The
 * label is what shows in the dropdown; the AST opcode is what we
 * persist.
 *
 * Numeric-only operators (gt/gte/lt/lte/between) still appear on
 * any field type; the runtime evaluator coerces strings to numbers
 * where it can. The author's choice of operator is more reliable
 * than us trying to guess based on field type, especially when a
 * "text" field actually holds numeric content.
 */
const COMPARISON_OPERATORS: ReadonlyArray<{
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'between';
  label: string;
  /** True when the right-hand side is a single value, false when
   *  this op uses a different shape (in: list-ish; between: min+max). */
  rhsKind: 'value' | 'list' | 'range';
}> = [
  { op: 'eq', label: 'equals', rhsKind: 'value' },
  { op: 'neq', label: 'does not equal', rhsKind: 'value' },
  { op: 'gt', label: 'greater than', rhsKind: 'value' },
  { op: 'gte', label: 'greater than or equal', rhsKind: 'value' },
  { op: 'lt', label: 'less than', rhsKind: 'value' },
  { op: 'lte', label: 'less than or equal', rhsKind: 'value' },
  { op: 'in', label: 'contains', rhsKind: 'value' },
  { op: 'between', label: 'between', rhsKind: 'range' },
];
type ComparisonOp = (typeof COMPARISON_OPERATORS)[number]['op'];

/**
 * One row in the inline editor. Always references a question on the
 * left; `op` picks one of the comparison operators above; the right
 * side is either a single value or, for `between`, a {min, max} pair.
 *
 * We keep `value` typed as a primitive string in the row even when
 * the left field is numeric -- on render we coerce via `Number(...)`
 * before composing the AST, so the user can type freely without the
 * input flickering between empty and 0.
 */
interface ConditionRow {
  ref: string;
  op: ComparisonOp;
  value: string;
  min: string;
  max: string;
}

const DEFAULT_ROW = (): ConditionRow => ({
  ref: '',
  op: 'eq',
  value: '',
  min: '',
  max: '',
});

/**
 * Try to break an Expression into a list of comparison rows joined
 * by AND or OR. Best-effort: if the expression uses ops we don't
 * model in the inline editor (calls, arithmetic, nested and/or, etc.)
 * we return null and the editor falls back to a "complex expression"
 * banner with a clear-and-start-over button. This keeps the UI
 * predictable -- we don't try to round-trip something we couldn't
 * faithfully render.
 */
function decomposeExpression(expr: Expression | undefined): {
  combinator: 'and' | 'or';
  rows: ConditionRow[];
} | null {
  if (!expr) return { combinator: 'and', rows: [] };
  // Single comparison row at the top level: treat as one-row AND.
  const single = decomposeRow(expr);
  if (single) return { combinator: 'and', rows: [single] };
  // and / or of comparisons.
  if (expr.op === 'and' || expr.op === 'or') {
    const rows: ConditionRow[] = [];
    for (const op of expr.operands) {
      const r = decomposeRow(op);
      if (!r) return null; // bail on first non-row operand
      rows.push(r);
    }
    return { combinator: expr.op, rows };
  }
  return null;
}

/**
 * If `expr` is one of our supported comparison shapes, return the
 * matching row. Otherwise null.
 */
function decomposeRow(expr: Expression): ConditionRow | null {
  if (
    expr.op === 'eq' ||
    expr.op === 'neq' ||
    expr.op === 'gt' ||
    expr.op === 'gte' ||
    expr.op === 'lt' ||
    expr.op === 'lte' ||
    expr.op === 'in'
  ) {
    if ('ref' in expr.left && 'value' in expr.right) {
      const v = expr.right.value;
      return {
        ...DEFAULT_ROW(),
        ref: expr.left.ref,
        op: expr.op,
        value: v === null || v === undefined ? '' : String(v),
      };
    }
    return null;
  }
  if (expr.op === 'between') {
    if (
      'ref' in expr.value &&
      'value' in expr.min &&
      'value' in expr.max
    ) {
      return {
        ...DEFAULT_ROW(),
        ref: expr.value.ref,
        op: 'between',
        min:
          expr.min.value === null || expr.min.value === undefined
            ? ''
            : String(expr.min.value),
        max:
          expr.max.value === null || expr.max.value === undefined
            ? ''
            : String(expr.max.value),
      };
    }
    return null;
  }
  return null;
}

/**
 * Compose rows + combinator back into an Expression. Returns
 * undefined when the result would be empty (no rows, or the only
 * row has no field picked). undefined is the schema's "no condition"
 * value, which is what we want for unset visibleIf / constraint.
 */
function composeExpression(
  combinator: 'and' | 'or',
  rows: ConditionRow[],
): Expression | undefined {
  const valid = rows.filter((r) => r.ref);
  if (valid.length === 0) return undefined;
  const exprs = valid.map(rowToExpression);
  if (exprs.length === 1) return exprs[0];
  return { op: combinator, operands: exprs };
}

function rowToExpression(r: ConditionRow): Expression {
  if (r.op === 'between') {
    return {
      op: 'between',
      value: { ref: r.ref },
      min: { value: coerceLiteral(r.min) },
      max: { value: coerceLiteral(r.max) },
    };
  }
  return {
    op: r.op,
    left: { ref: r.ref },
    right: { value: coerceLiteral(r.value) },
  } as Expression;
}

/**
 * Coerce a string-typed input value into the literal we persist on
 * the AST. We're permissive: numeric strings become numbers,
 * "true"/"false" become booleans, empty becomes empty string. Anything
 * else stays as a string. The runtime evaluator does its own
 * coercions for comparison, so this is mostly cosmetic -- the AST is
 * cleaner when "5" persists as 5.
 */
function coerceLiteral(s: string): string | number | boolean {
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  // Strict numeric: string must parse cleanly and round-trip.
  const n = Number(s);
  if (!Number.isNaN(n) && String(n) === s) return n;
  return s;
}

/**
 * Inline expression editor (Slice 1 of #162). Row-based. Each row is
 * a single comparison (`field op value`); rows join with AND or OR.
 * Composes/decomposes against the AST `Expression` type. For shapes
 * the editor doesn't model (function calls, nested and/or, etc.) we
 * fall back to a "complex expression" banner so we never silently
 * destroy an expression we can't round-trip.
 *
 * Slice 2 brings a modal Expression Builder reachable from the
 * "Builder" button next to the heading; Slices 3+ extend to
 * calculate / default / readOnly / quick-start shortcuts.
 */
function ExpressionEditor({
  label,
  value,
  allFields,
  disabled,
  onChange,
}: {
  label: string;
  value: Expression | undefined;
  allFields: FieldRef[];
  disabled: boolean;
  onChange: (next: Expression | undefined) => void;
}) {
  // Local state for the row list. We can't derive this from `value`
  // on every render because composeExpression intentionally drops
  // rows whose `ref` is empty -- a freshly-added row has no ref yet,
  // so it would never persist back through `value` and the "Add
  // condition" button would appear to do nothing.
  //
  // The parent wraps each ExpressionEditor in a `key` keyed by
  // question id + slot, so when the user selects a different
  // question the component remounts and re-initialises from the new
  // `value`. That keeps state per-question without us having to
  // diff `value` against local state in an effect.
  const initial = decomposeExpression(value);
  const [rows, setRows] = useState<ConditionRow[]>(initial?.rows ?? []);
  const [combinator, setCombinator] = useState<'and' | 'or'>(
    initial?.combinator ?? 'and',
  );
  // "Complex fallback" stays sticky for the lifetime of the component
  // unless the user explicitly clears. Local state so the banner
  // doesn't flicker on each re-render.
  const [showComplexFallback, setShowComplexFallback] = useState(
    initial === null,
  );
  // Slice 2 (#163): Modal builder for expressions richer than the
  // inline can model -- nested groups, future function calls, etc.
  // Stays closed by default; opening it always works regardless of
  // whether the inline or the complex fallback is showing.
  const [builderOpen, setBuilderOpen] = useState(false);

  const update = (
    nextRows: ConditionRow[],
    nextCombinator: 'and' | 'or' = combinator,
  ) => {
    setRows(nextRows);
    setCombinator(nextCombinator);
    onChange(composeExpression(nextCombinator, nextRows));
  };

  // Save handler used by the modal builder. The modal returns an
  // Expression (or undefined). We try to round-trip it through the
  // simpler inline view; if it fits the inline shape we drop the
  // complex fallback, otherwise we keep the fallback so the inline
  // doesn't lie about the saved structure.
  const saveFromBuilder = (next: Expression | undefined) => {
    onChange(next);
    setBuilderOpen(false);
    const d = decomposeExpression(next);
    if (d) {
      setRows(d.rows);
      setCombinator(d.combinator);
      setShowComplexFallback(false);
    } else {
      setShowComplexFallback(true);
    }
  };

  if (showComplexFallback) {
    return (
      <div>
        <div className="mb-0.5 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wide text-muted">
            {label}
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setBuilderOpen(true)}
            className="text-[10px] text-accent hover:underline disabled:opacity-50"
          >
            Builder
          </button>
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
          <p className="mb-1">
            This expression uses features the inline editor can&apos;t
            visualize yet (nested groups, functions). Open the Builder
            to edit it visually, or clear and start over.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setRows([]);
              setCombinator('and');
              setShowComplexFallback(false);
              onChange(undefined);
            }}
            className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 text-[11px] hover:bg-amber-100 disabled:opacity-50"
          >
            Clear and start over
          </button>
        </div>
        {builderOpen ? (
          <ExpressionBuilderModal
            label={label}
            initial={value}
            allFields={allFields}
            onClose={() => setBuilderOpen(false)}
            onSave={saveFromBuilder}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
        <div className="flex items-center gap-2">
          {rows.length >= 2 ? (
            <select
              value={combinator}
              disabled={disabled}
              onChange={(e) =>
                update(rows, e.target.value as 'and' | 'or')
              }
              className="rounded border border-border bg-surface-1 px-1 py-0.5 text-[10px]"
            >
              <option value="and">all match</option>
              <option value="or">any match</option>
            </select>
          ) : null}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setBuilderOpen(true)}
            className="text-[10px] text-accent hover:underline disabled:opacity-50"
          >
            Builder
          </button>
        </div>
      </div>
      <ul className="space-y-1">
        {rows.length === 0 ? (
          <li className="rounded border border-dashed border-border bg-surface-2/40 px-2 py-1.5 text-[11px] text-muted">
            No conditions. Always shown.
          </li>
        ) : (
          rows.map((row, idx) => (
            <li key={idx}>
              <ConditionRowEditor
                row={row}
                allFields={allFields}
                disabled={disabled}
                onChange={(next) => {
                  const r = rows.slice();
                  r[idx] = next;
                  update(r);
                }}
                onRemove={() => {
                  const r = rows.slice();
                  r.splice(idx, 1);
                  update(r);
                }}
              />
            </li>
          ))
        )}
      </ul>
      <button
        type="button"
        disabled={disabled}
        onClick={() => update([...rows, DEFAULT_ROW()])}
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent hover:underline disabled:opacity-50"
      >
        <Plus className="h-3 w-3" />
        Add condition
      </button>
      {builderOpen ? (
        <ExpressionBuilderModal
          label={label}
          initial={value}
          allFields={allFields}
          onClose={() => setBuilderOpen(false)}
          onSave={saveFromBuilder}
        />
      ) : null}
    </div>
  );
}

function ConditionRowEditor({
  row,
  allFields,
  disabled,
  onChange,
  onRemove,
}: {
  row: ConditionRow;
  allFields: FieldRef[];
  disabled: boolean;
  onChange: (next: ConditionRow) => void;
  onRemove: () => void;
}) {
  const opMeta =
    COMPARISON_OPERATORS.find((o) => o.op === row.op) ??
    COMPARISON_OPERATORS[0]!;
  return (
    <div className="grid grid-cols-[1fr_auto] gap-1">
      <div className="space-y-1">
        <FieldPicker
          value={row.ref}
          allFields={allFields}
          disabled={disabled}
          onChange={(ref) => onChange({ ...row, ref })}
        />
        <div className="grid grid-cols-[auto_1fr] gap-1">
          <select
            value={row.op}
            disabled={disabled}
            onChange={(e) =>
              onChange({ ...row, op: e.target.value as ComparisonOp })
            }
            className="rounded border border-border bg-surface-1 px-1 py-0.5 text-[11px]"
          >
            {COMPARISON_OPERATORS.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
          {opMeta.rhsKind === 'range' ? (
            <div className="grid grid-cols-2 gap-1">
              <input
                type="text"
                value={row.min}
                placeholder="min"
                disabled={disabled || !row.ref}
                onChange={(e) => onChange({ ...row, min: e.target.value })}
                className={inputCls}
              />
              <input
                type="text"
                value={row.max}
                placeholder="max"
                disabled={disabled || !row.ref}
                onChange={(e) => onChange({ ...row, max: e.target.value })}
                className={inputCls}
              />
            </div>
          ) : (
            <input
              type="text"
              value={row.value}
              placeholder="value"
              disabled={disabled || !row.ref}
              onChange={(e) => onChange({ ...row, value: e.target.value })}
              className={inputCls}
            />
          )}
        </div>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label="Remove condition"
        className="self-start rounded p-1 text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-50"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Field picker (dropdown of question references). Resolves the
 * duplicate-label issue by:
 *
 *   - Always showing the id alongside the label, so two questions
 *     labeled "Photo" can be told apart by id ("photo" vs "photo_2").
 *   - Grouping by parent path via <optgroup>, so a question inside
 *     a group is visually scoped to that group.
 *
 * Selection is by id. The runtime AST also stores ids -- this is
 * never lossy because every form has a unique-id invariant.
 */
function FieldPicker({
  value,
  allFields,
  disabled,
  onChange,
}: {
  value: string;
  allFields: FieldRef[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  // Group fields by parentPath. Top-level (parentPath === '') goes
  // first un-grouped; everything else gets an <optgroup>.
  const topLevel: FieldRef[] = [];
  const byPath = new Map<string, FieldRef[]>();
  for (const f of allFields) {
    if (f.parentPath === '') topLevel.push(f);
    else {
      const list = byPath.get(f.parentPath) ?? [];
      list.push(f);
      byPath.set(f.parentPath, list);
    }
  }
  const renderOption = (f: FieldRef) => (
    <option key={f.id} value={f.id}>
      {(f.label || '(unlabeled)') + ` · ${f.type} · ${f.id}`}
    </option>
  );
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={inputCls}
    >
      <option value="">Pick a question…</option>
      {topLevel.map(renderOption)}
      {Array.from(byPath.entries()).map(([path, fs]) => (
        <optgroup key={path} label={path}>
          {fs.map(renderOption)}
        </optgroup>
      ))}
    </select>
  );
}

// ---- Expression builder modal (#163, Slice 2) -----------------
//
// The inline ExpressionEditor handles a flat list of comparison rows
// joined by AND or OR. Some forms need more than that: nested groups
// like `(A or B) and (C or D)`, or function calls (planned for Slice
// 4). This modal builder gives authors a richer visual surface for
// those cases. It produces the same `Expression` AST the runtime
// already evaluates -- no string parser, no separate format.
//
// Data model for the modal: a `Rule` is either a single ConditionRow
// or a nested `RuleGroup`. `RuleTree` is the top level (a combinator
// + a list of rules). Mapping to the AST is straightforward: a tree
// emits `{ op: combinator, operands: [...] }` (or a single comparison
// when there's one rule).

type Rule =
  | { kind: 'row'; row: ConditionRow }
  | { kind: 'group'; combinator: 'and' | 'or'; rules: Rule[] };

interface RuleTree {
  combinator: 'and' | 'or';
  rules: Rule[];
}

/**
 * Decode an Expression into the modal's RuleTree shape. Best-effort:
 * comparison ops, in, between become rows; and/or become groups; we
 * recurse one level (deeper nesting is preserved).
 *
 * Anything we can't model (function calls, arithmetic, concat, if)
 * becomes an empty row -- the alternative is silently dropping the
 * expression on Save, which is worse. Slice 4 lifts this restriction
 * by extending the row + group vocabulary to cover calls.
 */
function treeFromExpression(expr: Expression | undefined): RuleTree {
  if (!expr) return { combinator: 'and', rules: [] };
  if (expr.op === 'and' || expr.op === 'or') {
    return {
      combinator: expr.op,
      rules: expr.operands.map(operandToRule),
    };
  }
  const row = decomposeRow(expr);
  if (row) return { combinator: 'and', rules: [{ kind: 'row', row }] };
  return { combinator: 'and', rules: [] };
}

function operandToRule(expr: Expression): Rule {
  if (expr.op === 'and' || expr.op === 'or') {
    return {
      kind: 'group',
      combinator: expr.op,
      rules: expr.operands.map(operandToRule),
    };
  }
  const row = decomposeRow(expr);
  if (row) return { kind: 'row', row };
  return { kind: 'row', row: DEFAULT_ROW() };
}

function treeToExpression(tree: RuleTree): Expression | undefined {
  const exprs: Expression[] = [];
  for (const rule of tree.rules) {
    const e = ruleToExpression(rule);
    if (e !== undefined) exprs.push(e);
  }
  if (exprs.length === 0) return undefined;
  if (exprs.length === 1) return exprs[0];
  return { op: tree.combinator, operands: exprs };
}

function ruleToExpression(rule: Rule): Expression | undefined {
  if (rule.kind === 'row') {
    if (!rule.row.ref) return undefined;
    return rowToExpression(rule.row);
  }
  return treeToExpression({
    combinator: rule.combinator,
    rules: rule.rules,
  });
}

/**
 * Modal "Expression Builder" reachable via the "Builder" link on
 * each ExpressionEditor heading. Two-column body: tree editor on
 * the left, reference panel (Fields / Operators / Functions) on
 * the right. Done writes back through `onSave(Expression | undefined)`.
 *
 * Only the Fields tab is interactive in Slice 2 -- it has search,
 * but click-to-insert lands in Slice 4 alongside the function
 * library. Operators and Functions tabs are reference-only for now
 * so the panel architecture is in place when Slice 4 turns it on.
 */
function ExpressionBuilderModal({
  label,
  initial,
  allFields,
  onClose,
  onSave,
}: {
  label: string;
  initial: Expression | undefined;
  allFields: FieldRef[];
  onClose: () => void;
  onSave: (next: Expression | undefined) => void;
}) {
  const [tree, setTree] = useState<RuleTree>(() => treeFromExpression(initial));
  const [tab, setTab] = useState<'fields' | 'operators' | 'functions'>(
    'fields',
  );
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-0/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="grid h-[80vh] max-h-[640px] w-full max-w-4xl grid-rows-[auto_1fr_auto] overflow-hidden rounded-lg border border-border bg-surface-0 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border bg-surface-1 px-4 py-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted">
              Expression builder
            </p>
            <h2 className="text-sm font-medium text-ink-0">{label}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="grid grid-cols-[1fr_280px] divide-x divide-border overflow-hidden">
          <div className="overflow-auto p-4">
            <RuleTreeEditor
              tree={tree}
              allFields={allFields}
              onChange={setTree}
            />
          </div>
          <aside className="flex min-h-0 flex-col bg-surface-1">
            <nav className="flex border-b border-border text-xs">
              {(
                [
                  ['fields', 'Fields'],
                  ['operators', 'Operators'],
                  ['functions', 'Functions'],
                ] as const
              ).map(([key, lbl]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`flex-1 px-3 py-2 ${
                    tab === key
                      ? 'border-b-2 border-accent text-ink-0'
                      : 'text-muted hover:text-ink-1'
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
              {tab === 'fields' ? (
                <FieldsReferencePanel allFields={allFields} />
              ) : tab === 'operators' ? (
                <OperatorsReferencePanel />
              ) : (
                <FunctionsReferencePanel />
              )}
            </div>
          </aside>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border bg-surface-1 px-4 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-0 px-3 py-1 text-xs hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(treeToExpression(tree))}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90"
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Recursive editor for a RuleTree. Renders the tree's combinator
 * selector + each rule. Rules are either condition rows (rendered
 * via ConditionRowEditor) or nested groups (rendered via
 * RuleTreeEditor again, indented). Two add buttons at every level:
 * "+ Condition" and "+ Group".
 */
function RuleTreeEditor({
  tree,
  allFields,
  onChange,
  depth = 0,
}: {
  tree: RuleTree;
  allFields: FieldRef[];
  onChange: (next: RuleTree) => void;
  depth?: number;
}) {
  const update = (rules: Rule[], combinator = tree.combinator) => {
    onChange({ combinator, rules });
  };
  return (
    <div
      className={
        depth === 0
          ? ''
          : 'rounded-md border border-dashed border-border bg-surface-1/40 p-2'
      }
    >
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
        <span className="uppercase tracking-wide">When</span>
        <select
          value={tree.combinator}
          onChange={(e) =>
            update(tree.rules, e.target.value as 'and' | 'or')
          }
          className="rounded border border-border bg-surface-1 px-1 py-0.5"
        >
          <option value="and">all match</option>
          <option value="or">any match</option>
        </select>
        <span>of:</span>
      </div>
      <ul className="space-y-2">
        {tree.rules.length === 0 ? (
          <li className="rounded border border-dashed border-border bg-surface-2/40 px-2 py-2 text-[11px] text-muted">
            No conditions in this group.
          </li>
        ) : (
          tree.rules.map((rule, idx) => (
            <li key={idx} className="grid grid-cols-[1fr_auto] gap-2">
              {rule.kind === 'row' ? (
                <ConditionRowEditor
                  row={rule.row}
                  allFields={allFields}
                  disabled={false}
                  onChange={(row) => {
                    const r = tree.rules.slice();
                    r[idx] = { kind: 'row', row };
                    update(r);
                  }}
                  onRemove={() => {
                    const r = tree.rules.slice();
                    r.splice(idx, 1);
                    update(r);
                  }}
                />
              ) : (
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <RuleTreeEditor
                    tree={{
                      combinator: rule.combinator,
                      rules: rule.rules,
                    }}
                    allFields={allFields}
                    depth={depth + 1}
                    onChange={(next) => {
                      const r = tree.rules.slice();
                      r[idx] = {
                        kind: 'group',
                        combinator: next.combinator,
                        rules: next.rules,
                      };
                      update(r);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const r = tree.rules.slice();
                      r.splice(idx, 1);
                      update(r);
                    }}
                    aria-label="Remove group"
                    className="self-start rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {rule.kind === 'row' ? null : null}
            </li>
          ))
        )}
      </ul>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() =>
            update([...tree.rules, { kind: 'row', row: DEFAULT_ROW() }])
          }
          className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
        >
          <Plus className="h-3 w-3" />
          Condition
        </button>
        <button
          type="button"
          onClick={() =>
            update([
              ...tree.rules,
              {
                kind: 'group',
                combinator: tree.combinator === 'and' ? 'or' : 'and',
                rules: [{ kind: 'row', row: DEFAULT_ROW() }],
              },
            ])
          }
          className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
        >
          <Plus className="h-3 w-3" />
          Group
        </button>
      </div>
    </div>
  );
}

/**
 * Right-panel reference: list of fields with search. Pure reference
 * for Slice 2 -- click-to-insert lands in Slice 4. The list itself
 * is still useful: authors looking for a field can scan here without
 * scrolling the row's dropdown.
 */
function FieldsReferencePanel({ allFields }: { allFields: FieldRef[] }) {
  const [q, setQ] = useState('');
  const filtered = q
    ? allFields.filter(
        (f) =>
          f.label.toLowerCase().includes(q.toLowerCase()) ||
          f.id.toLowerCase().includes(q.toLowerCase()),
      )
    : allFields;
  return (
    <div>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search fields…"
        className={inputCls}
      />
      <ul className="mt-2 space-y-1">
        {filtered.length === 0 ? (
          <li className="px-2 py-1 text-[11px] text-muted">No fields match.</li>
        ) : (
          filtered.map((f) => (
            <li
              key={f.id}
              className="rounded border border-border bg-surface-0 px-2 py-1"
            >
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-surface-2 px-1 py-px font-mono text-[9px] uppercase text-muted">
                  {f.type}
                </span>
                <span className="truncate text-[12px] text-ink-0">
                  {f.label || '(unlabeled)'}
                </span>
              </div>
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
                {f.id}
                {f.parentPath ? ` · ${f.parentPath}` : ''}
              </p>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/** Operators reference panel: pure list, informational. Slice 4 turns
 *  this into click-to-wrap-current-rule. */
function OperatorsReferencePanel() {
  const groups: Array<{ heading: string; ops: Array<[string, string]> }> = [
    {
      heading: 'Comparison',
      ops: [
        ['equals', 'value matches another'],
        ['does not equal', 'value differs'],
        ['greater than / >=', 'numeric / date comparison'],
        ['less than / <=', 'numeric / date comparison'],
        ['contains', 'string or list contains a value'],
        ['between', 'value falls in a range'],
      ],
    },
    {
      heading: 'Logical',
      ops: [
        ['all match (and)', 'every condition must hold'],
        ['any match (or)', 'at least one condition holds'],
      ],
    },
  ];
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.heading}>
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
            {g.heading}
          </p>
          <ul className="space-y-1">
            {g.ops.map(([name, hint]) => (
              <li
                key={name}
                className="rounded border border-border bg-surface-0 px-2 py-1"
              >
                <p className="text-[12px] text-ink-0">{name}</p>
                <p className="text-[10px] text-muted">{hint}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Functions reference panel: lists the existing 8 BUILTINS, with
 *  copy describing each. Slice 4 expands the registry and makes
 *  these clickable to insert call-shaped operands. */
function FunctionsReferencePanel() {
  const fns: Array<{ name: string; sig: string; hint: string }> = [
    { name: 'today', sig: 'today()', hint: 'current date as YYYY-MM-DD' },
    { name: 'now', sig: 'now()', hint: 'current ISO datetime' },
    { name: 'len', sig: 'len(text)', hint: 'string length' },
    { name: 'sum', sig: 'sum(a, b, …)', hint: 'numeric sum of refs / values' },
    {
      name: 'count',
      sig: 'count(field)',
      hint: 'number of selected choices in a select-many',
    },
    { name: 'coalesce', sig: 'coalesce(a, b, …)', hint: 'first non-null value' },
    { name: 'lower', sig: 'lower(text)', hint: 'lowercase' },
    { name: 'upper', sig: 'upper(text)', hint: 'uppercase' },
  ];
  return (
    <div>
      <p className="mb-2 text-[10px] text-muted">
        Slice 4 adds click-to-insert and many more functions (regex,
        contains, substr, selected, …). For now this is a reference of
        what the runtime evaluator supports.
      </p>
      <ul className="space-y-1">
        {fns.map((f) => (
          <li
            key={f.name}
            className="rounded border border-border bg-surface-0 px-2 py-1"
          >
            <p className="font-mono text-[12px] text-ink-0">{f.sig}</p>
            <p className="text-[10px] text-muted">{f.hint}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Layer import dialog ----------------------------------------

interface LayerListItem {
  id: string;
  title: string;
}

function LayerImportDialog({
  onClose,
  onApply,
}: {
  onClose: () => void;
  onApply: (
    qs: Question[],
    layer: { id: string; title: string; layerKey?: string },
  ) => void;
}) {
  const [layers, setLayers] = useState<LayerListItem[] | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [pickedTitle, setPickedTitle] = useState<string | null>(null);
  const [schema, setSchema] = useState<LayerSchema | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          '/api/portal/items?lite=1&type=data_layer',
        );
        if (!res.ok) throw new Error(`${res.status}`);
        const items = (await res.json()) as Array<{ id: string; title: string }>;
        setLayers(items);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not load layers.');
      }
    })();
  }, []);

  async function loadColumns(layerId: string, title: string) {
    setBusy(true);
    setErr(null);
    setSchema(null);
    try {
      const s = await fetchLayerSchema(layerId);
      setSchema(s);
      setPickedId(layerId);
      setPickedTitle(title);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load layer schema.');
    } finally {
      setBusy(false);
    }
  }

  function generate() {
    if (!schema || !pickedId || !pickedTitle) return;
    const qs: Question[] = [];
    qs.push(...questionsForColumns(schema.columns));
    if (schema.attachmentsEnabled) {
      // Top-level attachments live on the parent layer. The form's
      // linkedLayerId already addresses it, so the inner photo
      // question doesn't need a layerKey/layerItemId stamp.
      qs.push(buildAttachmentsGroup('photos', 'Photos', { kind: 'parent' }));
    }
    for (const rel of schema.related) {
      qs.push(buildRelatedGroup(rel));
    }
    onApply(qs, { id: pickedId, title: pickedTitle });
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-surface-1 shadow-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight text-ink-0">
            Link to a data layer
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-surface-2"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-4 py-3 text-sm">
          {err ? (
            <p className="rounded-md border border-danger/40 bg-danger/5 px-2 py-1 text-xs text-danger">
              {err}
            </p>
          ) : null}
          {!pickedId ? (
            <div>
              <p className="mb-2 text-xs text-muted">
                Pick a data layer to link this form to. We&apos;ll generate one
                question per column at the most compatible question type, and
                submissions to this form will land in the picked layer.
              </p>
              {layers === null ? (
                <p className="text-xs text-muted">Loading layers...</p>
              ) : layers.length === 0 ? (
                <p className="text-xs text-muted">No data layers in this org yet.</p>
              ) : (
                <ul className="max-h-72 space-y-1 overflow-y-auto">
                  {layers.map((l) => (
                    <li key={l.id}>
                      <button
                        type="button"
                        onClick={() => void loadColumns(l.id, l.title)}
                        disabled={busy}
                        className="flex w-full items-center justify-between rounded-md border border-border bg-surface-1 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-50"
                      >
                        <span className="truncate">{l.title}</span>
                        <span className="text-[10px] uppercase tracking-wide text-muted">
                          data layer
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <ImportPreview schema={schema} />
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            Cancel
          </button>
          {pickedId ? (
            <button
              type="button"
              onClick={generate}
              disabled={!schema}
              className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              Generate questions
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function humanise(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Preview the shape of the form we'll generate from a layer's
 * schema. Top-level columns are listed flat; related tables are
 * shown as collapsed groups; attachments-enabled flags get a
 * "+ Photos" line.
 */
function ImportPreview({ schema }: { schema: LayerSchema | null }) {
  if (!schema) {
    return <p className="text-xs text-muted">Loading layer schema...</p>;
  }
  const visibleCols = schema.columns.filter(
    (c) => !SKIP_PREFIX_RE.test(c.name) && !SKIP_EXACT.has(c.name.toLowerCase()),
  );
  const total =
    visibleCols.length +
    (schema.attachmentsEnabled ? 1 : 0) +
    schema.related.length;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Will generate {total} top-level{' '}
        {total === 1 ? 'question' : 'questions'}.
      </p>
      <div className="rounded border border-border bg-surface-2/40 p-2 text-xs">
        <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">
          This layer
        </p>
        <ul className="space-y-0.5">
          {visibleCols.map((c) => (
            <li key={c.name} className="flex justify-between">
              <span className="font-mono text-ink-1">{c.name}</span>
              <span className="text-muted">{c.type}</span>
            </li>
          ))}
          {visibleCols.length === 0 ? (
            <li className="text-muted">(no editable columns)</li>
          ) : null}
          {schema.attachmentsEnabled ? (
            <li className="mt-1 flex items-center justify-between border-t border-border/50 pt-1">
              <span className="text-ink-1">+ Photos</span>
              <span className="text-[10px] uppercase tracking-wide text-accent">
                repeat
              </span>
            </li>
          ) : null}
        </ul>
      </div>
      {schema.related.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-wide text-muted">
            Related tables (each becomes a repeat group)
          </p>
          {schema.related.map((rel, i) => {
            const cols = rel.columns.filter(
              (c) =>
                !SKIP_PREFIX_RE.test(c.name) &&
                !SKIP_EXACT.has(c.name.toLowerCase()),
            );
            return (
              <div
                key={`${rel.layerKeyOrItemId}-${i}`}
                className="rounded border border-border bg-surface-2/40 p-2 text-xs"
              >
                <p className="mb-1 flex items-center justify-between">
                  <span className="font-medium text-ink-0">{rel.label}</span>
                  <span className="inline-flex rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-accent">
                    repeat
                  </span>
                </p>
                <ul className="space-y-0.5">
                  {cols.map((c) => (
                    <li key={c.name} className="flex justify-between">
                      <span className="font-mono text-ink-1">{c.name}</span>
                      <span className="text-muted">{c.type}</span>
                    </li>
                  ))}
                  {rel.attachmentsEnabled ? (
                    <li className="mt-1 flex items-center justify-between border-t border-border/50 pt-1">
                      <span className="text-ink-1">+ Photos</span>
                      <span className="text-[10px] uppercase tracking-wide text-accent">
                        repeat
                      </span>
                    </li>
                  ) : null}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// System / Esri-y columns the form designer treats as noise. The
// data_layer keeps them; the form just doesn't surface them as
// questions.
const SKIP_PREFIX_RE = /^_/;
const SKIP_EXACT = new Set([
  'global_id',
  'object_id',
  'objectid',
  'fid',
  'gid',
  'shape',
  'geom',
  'geometry',
  'parent_global_id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'edited_at',
  'edited_by',
]);

/**
 * Where a column lives in the data_layer hierarchy. Stamped on each
 * generated question's `bindTo` so the Field-mode runtime knows
 * which table to route a captured value into, and so the designer
 * can resolve link-status against the right column set.
 *
 *  - `parent`: top-level form columns. Routing falls back to the
 *    form's `linkedLayerId` / `linkedLayerKey`.
 *  - `sublayer`: a v3 child sublayer in the SAME data_layer item.
 *    The runtime addresses it by layerKey.
 *  - `item`: a separate data_layer item linked through a cross-item
 *    relationship. Addressed by layerItemId.
 */
type LayerContext =
  | { kind: 'parent' }
  | { kind: 'sublayer'; layerKey: string }
  | { kind: 'item'; layerItemId: string };

/** Build a BindTo for a column under a given layer context. */
function bindToForColumn(
  ctx: LayerContext,
  column: string,
): { layerKey?: string; layerItemId?: string; column: string } {
  if (ctx.kind === 'sublayer') return { layerKey: ctx.layerKey, column };
  if (ctx.kind === 'item') return { layerItemId: ctx.layerItemId, column };
  return { column };
}

/**
 * Convert a flat list of layer columns into questions, snapping each
 * to the most compatible question type. Stamps `bindTo` so the Field-
 * mode runtime can route values back to the right column on the right
 * table. The optional `ctx` qualifies the binding when the columns
 * belong to a related sublayer or cross-item relationship; without it
 * the questions bind to the form's top-level linked layer.
 */
function questionsForColumns(
  cols: LayerColumn[],
  ctx: LayerContext = { kind: 'parent' },
): Question[] {
  const qs: Question[] = [];
  for (const col of cols) {
    if (SKIP_PREFIX_RE.test(col.name)) continue;
    if (SKIP_EXACT.has(col.name.toLowerCase())) continue;
    const t = (col.type ?? '').toLowerCase();
    const id = col.name;
    const label = col.label ?? humanise(col.name);
    const required = col.nullable === false;
    const base = {
      id,
      label,
      required,
      bindTo: bindToForColumn(ctx, col.name),
    };

    // Domain-bound columns become a select-one regardless of
    // underlying type. Pick-list-backed columns also carry the
    // source `pickListItemId` so the question can refresh choices
    // later if the list changes. We default to dropdown appearance
    // because pick lists tend to be longer than 4-5 entries (radio
    // buttons would scroll).
    if (col.choices && col.choices.length > 0) {
      const q: Question = {
        ...base,
        type: 'select-one',
        appearance: 'dropdown',
        choices: col.choices,
      };
      if (col.pickListItemId) q.pickListId = col.pickListItemId;
      qs.push(q);
      continue;
    }

    if (/text|varchar|char|string/.test(t) || t === '') {
      qs.push({ ...base, type: 'text' });
    } else if (/int|smallint|bigint/.test(t)) {
      qs.push({ ...base, type: 'integer' });
    } else if (/numeric|float|double|real|decimal|number/.test(t)) {
      qs.push({ ...base, type: 'number' });
    } else if (/bool/.test(t)) {
      qs.push({ ...base, type: 'boolean' });
    } else if (t.includes('time') && t.includes('date')) {
      qs.push({ ...base, type: 'datetime' });
    } else if (t.includes('time')) {
      qs.push({ ...base, type: 'time' });
    } else if (t.includes('date')) {
      qs.push({ ...base, type: 'date' });
    } else if (/point/.test(t)) {
      qs.push({ ...base, type: 'geopoint', capture: 'auto' });
    } else if (/line/.test(t)) {
      qs.push({ ...base, type: 'geotrace' });
    } else if (/polygon/.test(t)) {
      qs.push({ ...base, type: 'geoshape' });
    } else {
      qs.push({ ...base, type: 'text' });
    }
  }
  return qs;
}

/**
 * Build a repeating group named for a related table. Each instance
 * captures one related row, so e.g. a "Nest" with related "Nest
 * Inspections" generates a "Nest Inspections" repeat group with
 * one question per inspection column. If the related layer has
 * attachments enabled, an inner "Attachments" repeat group is
 * appended so each inspection can carry photos.
 */
function buildRelatedGroup(rel: RelatedTable): Question {
  // The repeat group itself binds to the related TABLE (a sublayer
  // or a cross-item layer), not to a column. Each captured repeat
  // instance becomes one row in that table, so the right shape is
  // bindTo: { layerKey } or { layerItemId }, never { column }.
  const ctx: LayerContext = rel.sameItem
    ? { kind: 'sublayer', layerKey: rel.layerKeyOrItemId }
    : { kind: 'item', layerItemId: rel.layerKeyOrItemId };
  const inner = questionsForColumns(rel.columns, ctx);
  if (rel.attachmentsEnabled) {
    // Pass the related-table context through so the inner photo's
    // bindTo points at the right layer and the link-status check
    // can resolve attachmentsEnabled against the right table.
    inner.push(
      buildAttachmentsGroup(`${rel.layerKeyOrItemId}_photos`, 'Photos', ctx),
    );
  }
  const id = suggestQuestionId(rel.label || 'related');
  const groupBindTo: { layerKey?: string; layerItemId?: string } = rel.sameItem
    ? { layerKey: rel.layerKeyOrItemId }
    : { layerItemId: rel.layerKeyOrItemId };
  return {
    id,
    type: 'group',
    label: rel.label,
    repeat: { addLabel: `Add another ${rel.label}` },
    bindTo: groupBindTo,
    children: inner,
  };
}

/**
 * Build a repeating group dedicated to attachments. Phase 1 ships
 * one photo question per instance so a respondent can capture N
 * images; future iterations may add captions / files / etc.
 *
 * The inner photo question is stamped with the target layer's
 * context (layerKey for a v3 sublayer, layerItemId for a cross-item
 * relationship, neither for top-level / parent) so the link-status
 * check can find the layer at render time and confirm attachments
 * are enabled on it.
 */
function buildAttachmentsGroup(
  idHint: string,
  label: string,
  ctx: LayerContext = { kind: 'parent' },
): Question {
  const layerBinding =
    ctx.kind === 'sublayer'
      ? { layerKey: ctx.layerKey }
      : ctx.kind === 'item'
        ? { layerItemId: ctx.layerItemId }
        : null;
  const inner: Extract<Question, { type: 'photo' }> = {
    id: 'photo',
    type: 'photo',
    label: 'Photo',
    maxCount: 1,
  };
  if (layerBinding) inner.bindTo = layerBinding;
  const group: Extract<Question, { type: 'group' }> = {
    id: suggestQuestionId(idHint),
    type: 'group',
    label,
    repeat: { addLabel: 'Add another photo' },
    children: [inner],
  };
  if (layerBinding) group.bindTo = layerBinding;
  return group;
}

/**
 * Detect whether a group binds to an attachments-enabled layer.
 *
 * Detection is structural: the group has at least one media child
 * (photo / file / signature) AND its bindTo target -- a related
 * sublayer (layerKey), a cross-item layer (layerItemId), or the
 * parent (no layer addressing) -- is reported as attachmentsEnabled
 * by the resolved schema.
 *
 * The structural check (must have a media child) keeps the affordance
 * from firing on a generic group that happens to live on an
 * attachments-enabled layer. False positives are harmless (the hint is
 * only encouragement, not enforcement) but the noise would be
 * confusing.
 */
function isAttachmentGroup(
  q: Question,
  layerSchema: LayerSchema | null,
): boolean {
  if (q.type !== 'group') return false;
  if (!layerSchema) return false;
  const hasMediaChild = q.children.some(
    (c) => c.type === 'photo' || c.type === 'file' || c.type === 'signature',
  );
  if (!hasMediaChild) return false;
  if (q.bindTo?.layerKey) {
    return Boolean(
      layerSchema.related.find(
        (r) => r.layerKeyOrItemId === q.bindTo!.layerKey,
      )?.attachmentsEnabled,
    );
  }
  if (q.bindTo?.layerItemId) {
    return Boolean(
      layerSchema.related.find(
        (r) => r.layerKeyOrItemId === q.bindTo!.layerItemId,
      )?.attachmentsEnabled,
    );
  }
  return Boolean(layerSchema.attachmentsEnabled);
}

/**
 * True if `id` (or any of its ancestor groups) is an attachment group.
 * Used to enforce "no repeating groups inside attachment groups": the
 * data model can't represent attachment-of-attachment cleanly, so the
 * Properties panel hides the repeat toggle for groups in this position
 * and the drag-drop layer refuses to land an already-repeating group
 * here.
 *
 * Walks the tree from the root. Returns false if the id isn't found
 * (shouldn't happen for a real selected question, but be defensive).
 */
function hasAttachmentAncestor(
  form: FormSchema,
  id: QuestionId,
  layerSchema: LayerSchema | null,
): boolean {
  if (!layerSchema) return false;
  type Frame = { qs: Question[]; ancestorAttachment: boolean };
  const stack: Frame[] = [{ qs: form.questions, ancestorAttachment: false }];
  while (stack.length > 0) {
    const { qs, ancestorAttachment } = stack.pop()!;
    for (const q of qs) {
      if (q.id === id) return ancestorAttachment;
      if (q.type === 'group') {
        const nextAncestor =
          ancestorAttachment || isAttachmentGroup(q, layerSchema);
        stack.push({ qs: q.children, ancestorAttachment: nextAncestor });
      }
    }
  }
  return false;
}

/**
 * True if `q` is a repeating group, or contains one anywhere in its
 * descendants. Used by the move guard so that moving an outer non-
 * repeating wrapper that contains a repeating group still triggers
 * the attachment-subtree refusal.
 */
function groupContainsRepeat(q: Question): boolean {
  if (q.type !== 'group') return false;
  if (q.repeat) return true;
  for (const c of q.children) {
    if (groupContainsRepeat(c)) return true;
  }
  return false;
}

/**
 * True if dropping a question into `containerId`'s children would
 * land it inside an attachment group's subtree (or directly inside
 * one). `null` means the top-level form, which can't be inside any
 * group, so the answer is always false there.
 */
function containerIsInAttachmentSubtree(
  form: FormSchema,
  containerId: QuestionId | null,
  layerSchema: LayerSchema | null,
): boolean {
  if (containerId === null) return false;
  if (!layerSchema) return false;
  // Look up the container itself; it's "in the subtree" if it IS an
  // attachment group, or any of its ancestors is. Use the same walker
  // as hasAttachmentAncestor but compare inclusively.
  type Frame = { qs: Question[]; ancestorAttachment: boolean };
  const stack: Frame[] = [{ qs: form.questions, ancestorAttachment: false }];
  while (stack.length > 0) {
    const { qs, ancestorAttachment } = stack.pop()!;
    for (const q of qs) {
      if (q.type !== 'group') continue;
      const here = ancestorAttachment || isAttachmentGroup(q, layerSchema);
      if (q.id === containerId) return here;
      stack.push({ qs: q.children, ancestorAttachment: here });
    }
  }
  return false;
}

// ---- Link-status badge on each canvas row ----------------------

function LinkStatusBadge({ status }: { status: LinkStatus }) {
  if (status.kind === 'unbound') return null;
  if (status.kind === 'matched') {
    // Synthetic attachment match: surface "bound" with an attachment-
    // specific tooltip so users know the value goes to the layer's
    // attachment store rather than a regular column.
    const isAttachment = status.column.type === 'attachment';
    const tip = isAttachment
      ? "Bound to the layer's attachments."
      : `Bound to column "${status.column.name}" (${status.column.type})`;
    return (
      <span
        title={tip}
        className="ml-1.5 inline-flex rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-emerald-800"
      >
        bound
      </span>
    );
  }
  if (status.kind === 'will-add') {
    return (
      <span
        title="No matching column on the layer yet. Will be added on save."
        className="ml-1.5 inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-900"
      >
        new column
      </span>
    );
  }
  return (
    <span
      title={`The layer no longer has column "${status.column}". Submissions for this question won't reach the layer.`}
      className="ml-1.5 inline-flex rounded-full bg-danger/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-danger"
    >
      orphaned
    </span>
  );
}

// ---- Linked-layer summary panel ---------------------------------

function LinkedLayerSummary({
  form,
  layerSchema,
  canEdit,
  onUnlinkLayer,
}: {
  form: FormSchema;
  layerSchema: LayerSchema | null;
  canEdit: boolean;
  onUnlinkLayer: () => void;
}) {
  const linkedTitle =
    typeof form.meta?.linkedLayerTitle === 'string'
      ? (form.meta.linkedLayerTitle as string)
      : 'data layer';
  // Tally per-question status so the user sees at a glance how the
  // form lines up against the layer's current schema. The status
  // walker resolves each question against the right column set
  // (parent layer or related table).
  let matched = 0;
  let willAdd = 0;
  for (const q of walkAll(form.questions)) {
    if (q.type === 'note' || q.type === 'page' || q.type === 'group') continue;
    const s = questionLinkStatus(q, layerSchema, true);
    if (s.kind === 'matched') matched += 1;
    else if (s.kind === 'will-add') willAdd += 1;
  }
  return (
    <div className="mb-3 rounded-md border border-accent/40 bg-accent/5 p-2 text-xs">
      <div className="mb-1 flex items-center gap-1.5">
        <Database className="h-3.5 w-3.5 text-accent" />
        <span className="font-medium text-ink-0">Linked to:</span>
        <span className="truncate text-ink-1">{linkedTitle}</span>
      </div>
      <p className="text-[11px] text-muted">
        {layerSchema === null
          ? 'Loading layer schema...'
          : `${matched} matched · ${willAdd} new column${willAdd === 1 ? '' : 's'} on save`}
      </p>
      <p className="mt-1 text-[11px] text-muted">
        Submissions go to this layer. New questions land as additive columns
        the next time someone submits.
      </p>
      {canEdit ? (
        <button
          type="button"
          onClick={onUnlinkLayer}
          className="mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-[11px] font-medium text-ink-1 hover:bg-surface-2"
        >
          Unlink
        </button>
      ) : null}
    </div>
  );
}

function* walkAll(qs: Question[]): Iterable<Question> {
  for (const q of qs) {
    yield q;
    if (q.type === 'group') yield* walkAll(q.children);
  }
}

// ---- Linked-layer helpers ---------------------------------------

export interface LayerColumn {
  name: string;
  type: string;
  nullable?: boolean;
  /** Display label from the layer's FeatureField, when present. */
  label?: string;
  /**
   * Resolved domain choices when the field has a coded-value
   * constraint (inline `coded-value` or via a referenced pick list).
   * Pre-resolved by `fetchLayerSchema` so `questionsForColumns` can
   * stay sync. The form then renders this column as a single-choice
   * dropdown rather than a free-text input.
   */
  choices?: { value: string; label: string }[];
  /** When the choices came from a referenced pick_list, the source
   *  item id is preserved here so the generated select-one question
   *  can carry `pickListId` for round-trip / future refresh. */
  pickListItemId?: string;
}

/**
 * A related table the form should mirror as a repeating group.
 * Comes from one of three sources:
 *   - v3 child layer inside the SAME data_layer item (parent has
 *     `childLayerIds` referencing other sublayers).
 *   - Cross-item relationship registered on the parent item's
 *     `data.relationships`.
 *   - Cross-item relationship registered on the child item's
 *     `data.parentRelationship` -- detected when the form imports
 *     a parent that doesn't have its own `relationships` list yet.
 */
export interface RelatedTable {
  label: string;
  /** Column id stamped on each generated question's bindTo so the
   *  Field-mode runtime can route a repeat instance back to the
   *  related table. */
  layerKeyOrItemId: string;
  /** True when the relationship lives in the same data_layer item
   *  (a v3 sublayer). False when the related rows live in a
   *  separate item. */
  sameItem: boolean;
  columns: LayerColumn[];
  /** True when the related layer/table has attachments enabled.
   *  The generator nests an "Attachments" repeat group inside the
   *  related table's group with a single photo question. */
  attachmentsEnabled?: boolean;
}

export interface LayerSchema {
  /** Top-level columns (the parent's own attributes). */
  columns: LayerColumn[];
  /** Zero or more related tables to render as repeating groups. */
  related: RelatedTable[];
  /** Whether the parent layer itself has attachments enabled. The
   *  generator appends an "Attachments" repeat group at the top
   *  level when true. */
  attachmentsEnabled?: boolean;
}

interface RawFeatureField {
  name: string;
  type?: string;
  label?: string;
  nullable?: boolean;
  /** Optional value-constraint. Mirrors shared-types FieldDomain --
   *  inline coded-values OR a reference to a pick_list item.
   *  fetchLayerSchema resolves the reference into LayerColumn.choices. */
  domain?:
    | {
        type: 'coded-value';
        values: Array<{ code: string | number; label: string }>;
      }
    | { type: 'coded-value-ref'; pickListItemId: string }
    | { type: 'range'; min: number; max: number };
}

interface RawSublayer {
  id?: string;
  key?: string;
  name?: string;
  label?: string;
  geometryType?: string | null;
  fields?: RawFeatureField[];
  attachmentsEnabled?: boolean;
  childLayerIds?: string[];
  parentLayerId?: string;
  /** Legacy shape: schema.columns pre-v3. Tolerated for safety. */
  schema?: { columns?: LayerColumn[] };
}

interface RawDataLayerItem {
  id: string;
  title: string;
  data?: {
    version?: number;
    layers?: RawSublayer[];
    fields?: RawFeatureField[];
    schema?: { columns?: LayerColumn[] };
    relationships?: Array<{
      id: string;
      label: string;
      relatedItemId: string;
      fkColumn: string;
    }>;
  };
}

function fieldsToColumns(fields: RawFeatureField[] | undefined): LayerColumn[] {
  if (!fields) return [];
  return fields.map((f) => {
    const col: LayerColumn = {
      name: f.name,
      type: f.type ?? 'string',
    };
    if (f.label !== undefined) col.label = f.label;
    if (f.nullable !== undefined) col.nullable = f.nullable;
    // Inline coded-value domain: snap directly to choices. The
    // form-schema's Choice.value is a string, so number codes are
    // stringified at this boundary.
    if (f.domain && f.domain.type === 'coded-value') {
      col.choices = f.domain.values.map((v) => ({
        value: String(v.code),
        label: v.label,
      }));
    }
    // Coded-value-ref: just stash the id; fetchLayerSchema resolves
    // the entries by fetching the pick_list item.
    if (f.domain && f.domain.type === 'coded-value-ref') {
      col.pickListItemId = f.domain.pickListItemId;
    }
    return col;
  });
}

/** Pick the columns out of a v3 sublayer in any reasonable shape:
 *  v3 `fields[]`, legacy `schema.columns[]`, or empty. */
function sublayerColumns(layer: RawSublayer): LayerColumn[] {
  if (layer.fields && layer.fields.length > 0) {
    return fieldsToColumns(layer.fields);
  }
  return layer.schema?.columns ?? [];
}

async function fetchItem(id: string): Promise<RawDataLayerItem | null> {
  try {
    const res = await fetch(`/api/portal/items/${id}`);
    if (!res.ok) return null;
    return (await res.json()) as RawDataLayerItem;
  } catch {
    return null;
  }
}

/**
 * Full schema fetch for a data_layer: parent columns plus any
 * related tables (same-item child layers and cross-item
 * relationships). Used by the import dialog to generate questions
 * that mirror the layer's structure -- a repeating group per
 * related table -- and by the canvas to compute per-question link
 * status.
 *
 * Tolerant of v1, v2, v3 layouts and legacy shapes.
 */
export async function fetchLayerSchema(
  layerId: string,
  layerKey?: string,
): Promise<LayerSchema> {
  const item = await fetchItem(layerId);
  if (!item) return { columns: [], related: [] };
  const data = item.data ?? {};

  // Identify the picked sublayer in v3, or the synthetic single-
  // layer in v1/v2.
  const layers = data.layers ?? [];
  let picked: RawSublayer | null = null;
  if (layers.length > 0) {
    if (layerKey) {
      picked =
        layers.find((l) => l.key === layerKey || l.id === layerKey) ?? null;
    }
    if (!picked) picked = layers[0] ?? null;
  }

  const columns: LayerColumn[] = picked
    ? sublayerColumns(picked)
    : fieldsToColumns(data.fields) || data.schema?.columns || [];

  const related: RelatedTable[] = [];

  // Same-item v3 child layers: a layer that lists other layer ids in
  // `childLayerIds`, OR layers that name `picked` as their `parentLayerId`.
  if (picked) {
    const childIds = new Set(picked.childLayerIds ?? []);
    for (const l of layers) {
      const isChildById = l.id !== undefined && childIds.has(l.id);
      const isChildByParent =
        l.parentLayerId !== undefined && l.parentLayerId === picked.id;
      if ((isChildById || isChildByParent) && l !== picked) {
        related.push({
          label: l.label ?? l.name ?? l.id ?? 'Related table',
          layerKeyOrItemId: l.key ?? l.id ?? '',
          sameItem: true,
          columns: sublayerColumns(l),
          attachmentsEnabled: Boolean(l.attachmentsEnabled),
        });
      }
    }
  }

  // Cross-item relationships registered on the parent.
  for (const rel of data.relationships ?? []) {
    const child = await fetchItem(rel.relatedItemId);
    if (!child) continue;
    const childLayer = child.data?.layers?.[0];
    const cols = childLayer
      ? sublayerColumns(childLayer)
      : fieldsToColumns(child.data?.fields) ?? [];
    related.push({
      label: rel.label ?? child.title ?? 'Related table',
      layerKeyOrItemId: rel.relatedItemId,
      sameItem: false,
      columns: cols,
      attachmentsEnabled: Boolean(childLayer?.attachmentsEnabled),
    });
  }

  // Resolve every pick_list reference across parent + related table
  // columns in parallel. Once we have the entries we patch them onto
  // the column.choices in place; questionsForColumns is sync and
  // can then snap-bind to a select-one with real choices.
  await resolvePickListChoices([
    ...columns,
    ...related.flatMap((r) => r.columns),
  ]);

  return {
    columns,
    related,
    attachmentsEnabled: Boolean(picked?.attachmentsEnabled),
  };
}

/**
 * For every column with a `pickListItemId` set but no `choices` yet,
 * fetch the referenced pick_list item once (deduped) and copy its
 * entries onto the column. Failure is silent: if a pick list 404s
 * or the user can't see it, the column simply falls through to its
 * type-based default question (text, number, etc).
 */
async function resolvePickListChoices(cols: LayerColumn[]): Promise<void> {
  const ids = new Set<string>();
  for (const c of cols) {
    if (c.pickListItemId && !c.choices) ids.add(c.pickListItemId);
  }
  if (ids.size === 0) return;

  const cache = new Map<string, { value: string; label: string }[]>();
  await Promise.all(
    Array.from(ids).map(async (id) => {
      try {
        const res = await fetch(`/api/portal/items/${id}`);
        if (!res.ok) return;
        const item = (await res.json()) as {
          data?: { entries?: Array<{ code?: unknown; label?: unknown }> };
        };
        const entries = item.data?.entries ?? [];
        const choices = entries
          .map((e) => ({
            value: String(e.code ?? ''),
            label: typeof e.label === 'string' ? e.label : String(e.code ?? ''),
          }))
          .filter((c) => c.value !== '');
        cache.set(id, choices);
      } catch {
        // Network / parse failure -- leave choices unset.
      }
    }),
  );

  for (const c of cols) {
    if (c.pickListItemId && !c.choices) {
      const resolved = cache.get(c.pickListItemId);
      if (resolved && resolved.length > 0) c.choices = resolved;
    }
  }
}

/**
 * Back-compat shim: the canvas only needs the parent columns to
 * compute per-question link status; the import path uses the full
 * schema. Kept as a thin wrapper so old call sites don't break.
 */
export async function fetchLayerColumns(
  layerId: string,
  layerKey?: string,
): Promise<LayerColumn[]> {
  const s = await fetchLayerSchema(layerId, layerKey);
  return s.columns;
}

/** Strip every question's bindTo. Called when the user unlinks a
 *  form from its layer so the questions don't carry stale bindings. */
export function stripBindings(qs: Question[]): Question[] {
  return qs.map((q) => {
    const next: Question = { ...q };
    delete next.bindTo;
    if (next.type === 'group') {
      next.children = stripBindings(next.children);
    }
    return next;
  });
}

export type LinkStatus =
  | { kind: 'matched'; column: LayerColumn }
  | { kind: 'will-add' } // bindTo set but column not on layer; safe additive on save
  | { kind: 'orphaned'; column: string } // bindTo column was removed from layer
  | { kind: 'unbound' }; // form not linked OR question has no bindTo

/**
 * Compute per-question status against the linked layer's columns.
 * The designer uses this to render badges on each question card and
 * a summary in the form-level properties panel.
 */
export function questionLinkStatus(
  q: Question,
  schema: LayerSchema | null,
  isLinked: boolean,
): LinkStatus {
  if (!isLinked || schema === null) return { kind: 'unbound' };
  // Pure-display + structural types don't bind to a column; group
  // status is implied by its children, and we render a separate
  // "REPEAT" tag for repeating groups elsewhere.
  if (q.type === 'note' || q.type === 'page' || q.type === 'group') {
    return { kind: 'unbound' };
  }

  // Resolve which column set this question targets:
  //   - bindTo.layerKey points at a v3 same-item sublayer
  //   - bindTo.layerItemId points at a separate data_layer item
  //   - otherwise: the parent's columns
  let cols: LayerColumn[] | null = null;
  let attachmentsEnabled = false;
  if (q.bindTo?.layerKey) {
    const rel = schema.related.find(
      (r) => r.layerKeyOrItemId === q.bindTo!.layerKey,
    );
    cols = rel?.columns ?? null;
    attachmentsEnabled = Boolean(rel?.attachmentsEnabled);
  } else if (q.bindTo?.layerItemId) {
    const rel = schema.related.find(
      (r) => r.layerKeyOrItemId === q.bindTo!.layerItemId,
    );
    cols = rel?.columns ?? null;
    attachmentsEnabled = Boolean(rel?.attachmentsEnabled);
  } else {
    cols = schema.columns;
    attachmentsEnabled = Boolean(schema.attachmentsEnabled);
  }

  // Attachment-bearing question types (photo / signature / file)
  // don't bind to a regular column. They bind to the layer's
  // attachments capability, which we surface with a synthetic
  // column so the existing "matched" UI works without a new status.
  if (
    (q.type === 'photo' || q.type === 'signature' || q.type === 'file') &&
    attachmentsEnabled &&
    !q.bindTo?.column
  ) {
    return {
      kind: 'matched',
      column: { name: 'attachment', type: 'attachment' },
    };
  }

  if (cols === null) {
    // Question is tagged for a related table the schema doesn't know
    // about (the relationship was removed, or the layer changed).
    return { kind: 'orphaned', column: q.bindTo?.column ?? q.id };
  }

  const colName = q.bindTo?.column ?? q.id;
  const match = cols.find((c) => c.name === colName);
  if (match) return { kind: 'matched', column: match };
  if (q.bindTo?.column) {
    // Explicit binding to a column the target table doesn't have.
    // Could be either "we'll add it on save" (the user just made the
    // question) or "the layer dropped that column" (orphaned). We
    // can't tell the two apart from schema alone, so we surface
    // "will-add" by default and rely on the layer's column-history
    // to flag orphaned bindings in Phase 1b.
    return { kind: 'will-add' };
  }
  // No bindTo + no column match. The form would extend the layer
  // additively with the question's id as the new column name.
  return { kind: 'will-add' };
}
