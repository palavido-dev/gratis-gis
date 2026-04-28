'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlignLeft,
  Calculator,
  Calendar,
  CalendarClock,
  Camera,
  CheckSquare,
  Circle,
  Clock,
  Database,
  Eye,
  GripVertical,
  Hash,
  ListChecks,
  Loader2,
  MapPin,
  Plus,
  Save,
  Sliders,
  SplitSquareHorizontal,
  Square,
  Star,
  Text as TextIcon,
  ToggleLeft,
  Trash2,
  Type,
  Workflow,
  X,
} from 'lucide-react';
import {
  collectIds,
  CURRENT_FORM_SCHEMA_VERSION,
  defaultQuestion,
  emptyForm,
  QUESTION_TYPES,
  suggestQuestionId,
  uniqueQuestionId,
  type Choice,
  type Expression,
  type FormSchema,
  type Question,
  type QuestionId,
  type QuestionType,
} from '@gratis-gis/form-schema';
import { FormRuntime } from '@/components/form-runtime';

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
  const [form, setForm] = useState<FormSchema>(
    () => initial ?? emptyForm(itemId, 'Untitled form'),
  );
  const [selectedId, setSelectedId] = useState<QuestionId | null>(null);
  const [tab, setTab] = useState<'design' | 'preview'>('design');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

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
    (type: QuestionType, containerId: QuestionId | null = null) => {
      const baseId = suggestQuestionId(type);
      setForm((f) => {
        const id = uniqueQuestionId(f, baseId);
        const q = defaultQuestion(type, id);
        const next = mutateContainer(f, containerId, (list) => [...list, q]);
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
      setForm((f) => moveInTree(f, sourceId, target));
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

  function applyImported(qs: Question[]) {
    setForm((f) => ({ ...f, questions: [...f.questions, ...qs] }));
    setImportOpen(false);
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
        <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr_280px]">
          <Palette canEdit={canEdit} onAdd={(t) => addQuestion(t, null)} />
          <Canvas
            form={form}
            selectedId={selectedId}
            canEdit={canEdit}
            onSelect={setSelectedId}
            onRemove={removeQuestion}
            onAddInto={addQuestion}
            onMove={moveQuestion}
            onOpenImport={() => setImportOpen(true)}
          />
          <Properties
            form={form}
            question={selected}
            canEdit={canEdit}
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
          <FormRuntime
            form={form}
            onSubmit={async () => {
              /* preview discards submission */
            }}
            readOnly
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

interface PaletteEntry {
  type: QuestionType;
  label: string;
  icon: typeof Type;
  group: 'basic' | 'choice' | 'time' | 'media' | 'spatial' | 'logic' | 'layout';
}

const PALETTE: PaletteEntry[] = [
  { type: 'text', label: 'Short text', icon: Type, group: 'basic' },
  { type: 'multiline', label: 'Long text', icon: AlignLeft, group: 'basic' },
  { type: 'number', label: 'Number', icon: Hash, group: 'basic' },
  { type: 'integer', label: 'Whole number', icon: Hash, group: 'basic' },
  { type: 'boolean', label: 'Yes / No', icon: ToggleLeft, group: 'basic' },
  { type: 'select-one', label: 'Single choice', icon: Circle, group: 'choice' },
  { type: 'select-many', label: 'Multiple choice', icon: CheckSquare, group: 'choice' },
  { type: 'date', label: 'Date', icon: Calendar, group: 'time' },
  { type: 'time', label: 'Time', icon: Clock, group: 'time' },
  { type: 'datetime', label: 'Date + time', icon: CalendarClock, group: 'time' },
  { type: 'photo', label: 'Photo', icon: Camera, group: 'media' },
  { type: 'signature', label: 'Signature', icon: Type, group: 'media' },
  { type: 'geopoint', label: 'Location', icon: MapPin, group: 'spatial' },
  { type: 'geotrace', label: 'Path', icon: SplitSquareHorizontal, group: 'spatial' },
  { type: 'geoshape', label: 'Area', icon: Square, group: 'spatial' },
  { type: 'rating', label: 'Rating', icon: Star, group: 'basic' },
  { type: 'slider', label: 'Slider', icon: Sliders, group: 'basic' },
  { type: 'calculated', label: 'Calculated', icon: Calculator, group: 'logic' },
  { type: 'note', label: 'Note', icon: TextIcon, group: 'layout' },
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
  return (
    <aside className="border-b border-border bg-surface-2/40 p-3 lg:border-b-0 lg:border-r">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted">
        Add a question
      </p>
      <div className="flex flex-wrap gap-1.5 lg:flex-col">
        {QUESTION_TYPES.map((t) => {
          const entry = PALETTE.find((e) => e.type === t);
          if (!entry) return null;
          const Icon = entry.icon;
          return (
            <button
              type="button"
              key={t}
              draggable={canEdit}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/x-question-type', t);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => canEdit && onAdd(t)}
              disabled={!canEdit}
              className="inline-flex w-full items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              <Icon className="h-3.5 w-3.5 text-muted" />
              <span className="truncate text-left">{entry.label}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

// ---- Canvas (recursive) -----------------------------------------

interface CanvasCallbacks {
  selectedId: QuestionId | null;
  canEdit: boolean;
  onSelect: (id: QuestionId) => void;
  onRemove: (id: QuestionId) => void;
  onAddInto: (type: QuestionType, containerId: QuestionId | null) => void;
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
  return (
    <main className="min-h-[420px] border-b border-border bg-surface-0 p-4 lg:border-b-0">
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
          Or start from a data layer
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
  return (
    <ul className="space-y-2">
      {list.map((q, i) => (
        <QuestionRow
          key={q.id}
          q={q}
          index={i}
          containerId={containerId}
          {...cb}
        />
      ))}
      {/* Trailing drop zone for "drop at the end". Without this you
          can't drop into an empty group, and you can't append-via-
          drop on the top-level list either. */}
      <li>
        <DropSlot
          containerId={containerId}
          index={list.length}
          canEdit={cb.canEdit}
          onAddType={(t) => cb.onAddInto(t, containerId)}
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
  onSelect,
  onRemove,
  onAddInto,
  onMove,
}: {
  q: Question;
  index: number;
  containerId: QuestionId | null;
} & CanvasCallbacks) {
  const [overTop, setOverTop] = useState(false);

  function onTopDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setOverTop(false);
    const newType = e.dataTransfer.getData('text/x-question-type');
    const sourceId = e.dataTransfer.getData('text/x-reorder-id');
    if (newType) onAddInto(newType as QuestionType, containerId);
    else if (sourceId && sourceId !== q.id) {
      onMove(sourceId, { containerId, index });
    }
  }

  return (
    <li>
      {/* Insert-before drop zone. Sits above the row card so the user
          gets a target *between* questions, distinct from "drop on
          the row" (which would be ambiguous). */}
      <DropSlot
        containerId={containerId}
        index={index}
        canEdit={canEdit}
        onAddType={(t) => onAddInto(t, containerId)}
        onMove={(id) => {
          if (id !== q.id) onMove(id, { containerId, index });
        }}
      />

      <div
        className={`relative rounded-md border ${
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
            </p>
            <p className="text-sm font-medium text-ink-0">{q.label}</p>
            {q.hint ? <p className="text-xs text-muted">{q.hint}</p> : null}
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
                onSelect={onSelect}
                onRemove={onRemove}
                onAddInto={onAddInto}
                onMove={onMove}
              />
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// ---- Properties -------------------------------------------------

function Properties({
  form,
  question,
  canEdit,
  onChange,
  onRename,
  onUpdateForm,
  onOpenImport,
}: {
  form: FormSchema;
  question: Question | null;
  canEdit: boolean;
  onChange: (patch: Partial<Question>) => void;
  onRename: (newId: string) => void;
  onUpdateForm: (patch: Partial<FormSchema>) => void;
  onOpenImport: () => void;
}) {
  if (!question) {
    return (
      <aside className="border-l border-border bg-surface-2/40 p-3">
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
        {canEdit ? (
          <button
            type="button"
            onClick={onOpenImport}
            className="mb-3 inline-flex h-8 w-full items-center justify-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            <Database className="h-3.5 w-3.5" />
            Import questions from a data layer
          </button>
        ) : null}
        <p className="mt-1 text-[11px] text-muted">
          Select a question on the left to edit it.
        </p>
      </aside>
    );
  }
  return (
    <aside className="border-l border-border bg-surface-2/40 p-3">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted">
        {question.type} properties
      </p>

      <Field label="Label">
        <input
          type="text"
          value={question.label}
          disabled={!canEdit}
          onChange={(e) => onChange({ label: e.target.value })}
          className={inputCls}
        />
      </Field>

      <Field label="Question id" hint="Used as the column name in the layer schema.">
        <input
          type="text"
          value={question.id}
          disabled={!canEdit}
          onChange={(e) => onRename(e.target.value)}
          className={`${inputCls} font-mono`}
        />
      </Field>

      <Field label="Hint">
        <textarea
          rows={2}
          value={question.hint ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChange({ hint: e.target.value || undefined })}
          className={inputCls}
        />
      </Field>

      <label className="mb-2 inline-flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={Boolean(question.required)}
          disabled={!canEdit}
          onChange={(e) => onChange({ required: e.target.checked })}
        />
        <span>Required</span>
      </label>

      {question.type === 'select-one' || question.type === 'select-many' ? (
        <ChoicesEditor
          choices={question.choices}
          canEdit={canEdit}
          onChange={(choices) => onChange({ choices } as Partial<Question>)}
        />
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

      {question.type === 'text' || question.type === 'multiline' ? (
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

      {question.type === 'group' ? (
        <GroupRepeatEditor
          q={question}
          canEdit={canEdit}
          onChange={(repeat) => onChange({ repeat } as Partial<Question>)}
        />
      ) : null}

      <details className="mt-3 rounded-md border border-border bg-surface-1 p-2 text-xs">
        <summary className="cursor-pointer text-muted">Conditional logic</summary>
        <div className="mt-2 space-y-2">
          <ExpressionEditor
            label="Visible if"
            value={question.visibleIf}
            allFields={collectIdLabelPairs(form)}
            disabled={!canEdit}
            onChange={(visibleIf) => onChange({ visibleIf })}
          />
        </div>
      </details>
    </aside>
  );
}

function collectIdLabelPairs(form: FormSchema): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  function walk(qs: Question[]) {
    for (const q of qs) {
      out.push({ id: q.id, label: q.label });
      if (q.type === 'group') walk(q.children);
    }
  }
  walk(form.questions);
  return out;
}

function GroupRepeatEditor({
  q,
  canEdit,
  onChange,
}: {
  q: Extract<Question, { type: 'group' }>;
  canEdit: boolean;
  onChange: (repeat: Extract<Question, { type: 'group' }>['repeat']) => void;
}) {
  const enabled = Boolean(q.repeat);
  return (
    <div className="mt-2 rounded-md border border-border bg-surface-1 p-2 text-xs">
      <label className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canEdit}
          onChange={(e) =>
            onChange(e.target.checked ? { min: 0, addLabel: 'Add another' } : undefined)
          }
        />
        <span>Repeat (capture multiple instances)</span>
      </label>
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

function ExpressionEditor({
  label,
  value,
  allFields,
  disabled,
  onChange,
}: {
  label: string;
  value: Expression | undefined;
  allFields: Array<{ id: string; label: string }>;
  disabled: boolean;
  onChange: (next: Expression | undefined) => void;
}) {
  const eq =
    value && value.op === 'eq' && 'ref' in value.left && 'value' in value.right
      ? { ref: value.left.ref, val: value.right.value as string | number | boolean | null }
      : null;
  return (
    <div>
      <p className="mb-0.5 text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <div className="grid grid-cols-2 gap-1">
        <select
          value={eq?.ref ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const ref = e.target.value;
            if (!ref) {
              onChange(undefined);
              return;
            }
            onChange({
              op: 'eq',
              left: { ref },
              right: { value: eq?.val ?? '' },
            });
          }}
          className={`${inputCls}`}
        >
          <option value="">none</option>
          {allFields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={eq?.val === null || eq?.val === undefined ? '' : String(eq.val)}
          placeholder="equals..."
          disabled={disabled || !eq}
          onChange={(e) => {
            if (!eq) return;
            onChange({
              op: 'eq',
              left: { ref: eq.ref },
              right: { value: e.target.value },
            });
          }}
          className={inputCls}
        />
      </div>
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
  onApply: (qs: Question[]) => void;
}) {
  const [layers, setLayers] = useState<LayerListItem[] | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [columns, setColumns] = useState<Array<{
    name: string;
    type: string;
    nullable?: boolean;
  }> | null>(null);
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

  async function loadColumns(layerId: string) {
    setBusy(true);
    setErr(null);
    setColumns(null);
    try {
      const res = await fetch(`/api/portal/items/${layerId}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const layer = (await res.json()) as {
        data?: {
          layers?: Array<{
            schema?: { columns?: Array<{ name: string; type: string; nullable?: boolean }> };
          }>;
          schema?: { columns?: Array<{ name: string; type: string; nullable?: boolean }> };
        };
      };
      const cols =
        layer.data?.layers?.[0]?.schema?.columns ??
        layer.data?.schema?.columns ??
        [];
      setColumns(cols);
      setPickedId(layerId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load layer schema.');
    } finally {
      setBusy(false);
    }
  }

  function generate() {
    if (!columns) return;
    // Skip system columns (created_*, edited_*, geometry-internal,
    // primary keys) -- the form designer sees them as noise.
    const skipPrefix = /^_/;
    const skipExact = new Set([
      'global_id',
      'object_id',
      'objectid',
      'fid',
      'gid',
      'shape',
      'geom',
      'geometry',
    ]);
    const qs: Question[] = [];
    for (const col of columns) {
      if (skipPrefix.test(col.name)) continue;
      if (skipExact.has(col.name.toLowerCase())) continue;
      const t = col.type.toLowerCase();
      const id = col.name;
      const label = humanise(col.name);
      const required = col.nullable === false;
      const base = { id, label, required, bindTo: { column: col.name } };
      if (/text|varchar|char/.test(t)) {
        qs.push({ ...base, type: 'text' });
      } else if (/int|smallint|bigint/.test(t)) {
        qs.push({ ...base, type: 'integer' });
      } else if (/numeric|float|double|real|decimal/.test(t)) {
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
    onApply(qs);
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
            Start from a data layer
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
                Pick a data layer; we&apos;ll generate one question per column at the
                most compatible question type. You can edit before saving.
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
                        onClick={() => void loadColumns(l.id)}
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
            <div>
              <p className="mb-2 text-xs text-muted">
                Will generate {columns?.length ?? 0} questions:
              </p>
              <ul className="max-h-60 space-y-1 overflow-y-auto rounded border border-border bg-surface-2/40 p-2 text-xs">
                {(columns ?? []).map((c) => (
                  <li key={c.name} className="flex justify-between">
                    <span className="font-mono text-ink-1">{c.name}</span>
                    <span className="text-muted">{c.type}</span>
                  </li>
                ))}
              </ul>
            </div>
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
              disabled={!columns}
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
