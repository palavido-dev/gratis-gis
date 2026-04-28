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
  Circle,
  Clock,
  Crosshair,
  Database,
  Download,
  Eye,
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
  Phone,
  Plus,
  Regex,
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
  const [layerColumns, setLayerColumns] = useState<LayerColumn[] | null>(null);

  // Whenever the linked layer changes (initial load + import + unlink),
  // refresh our copy of the layer's columns so the canvas can render
  // per-question status. Failure is non-fatal: the designer still
  // works, just without the colored "matched / new column" badges.
  useEffect(() => {
    if (!form.linkedLayerId) {
      setLayerColumns(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const cols = await fetchLayerColumns(form.linkedLayerId!, form.linkedLayerKey);
        if (!cancelled) setLayerColumns(cols);
      } catch {
        if (!cancelled) setLayerColumns(null);
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
        <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr_280px]">
          <Palette canEdit={canEdit} onAdd={(t) => addQuestion(t, null)} />
          <Canvas
            form={form}
            selectedId={selectedId}
            canEdit={canEdit}
            layerColumns={layerColumns}
            isLinked={Boolean(form.linkedLayerId)}
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
            layerColumns={layerColumns}
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

/** Display order + label for each palette group. The list order is
 *  intentional: text and choice (the bread-and-butter types) come
 *  first; specialized groups follow. */
const PALETTE_GROUPS: { id: PaletteGroup; label: string }[] = [
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
  { id: 'layout', label: 'Layout' },
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
  { type: 'image-choice', label: 'Image choice', icon: Image, group: 'media' },
  { type: 'image-display', label: 'Image', icon: Image, group: 'media' },
  { type: 'image-hotspot', label: 'Image hotspot', icon: Crosshair, group: 'media' },
  { type: 'signature', label: 'Signature', icon: Type, group: 'media' },
  { type: 'geopoint', label: 'Location', icon: MapPin, group: 'spatial' },
  { type: 'geotrace', label: 'Path', icon: SplitSquareHorizontal, group: 'spatial' },
  { type: 'geoshape', label: 'Area', icon: Square, group: 'spatial' },
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

  return (
    <aside className="border-b border-border bg-surface-2/40 p-3 lg:border-b-0 lg:border-r">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted">
        Add a question
      </p>
      <div className="space-y-3">
        {PALETTE_GROUPS.map((g) => {
          const entries = buckets.get(g.id);
          if (!entries || entries.length === 0) return null;
          return (
            <div key={g.id}>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted/70">
                {g.label}
              </p>
              <div className="flex flex-wrap gap-1.5 lg:flex-col">
                {entries.map((entry) => {
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
            </div>
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
  layerColumns: LayerColumn[] | null;
  isLinked: boolean;
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
  layerColumns,
  isLinked,
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
              <LinkStatusBadge status={questionLinkStatus(q, layerColumns, isLinked)} />
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
                layerColumns={layerColumns}
                isLinked={isLinked}
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
  layerColumns,
  onChange,
  onRename,
  onUpdateForm,
  onOpenImport,
  onUnlinkLayer,
}: {
  form: FormSchema;
  question: Question | null;
  canEdit: boolean;
  layerColumns: LayerColumn[] | null;
  onChange: (patch: Partial<Question>) => void;
  onRename: (newId: string) => void;
  onUpdateForm: (patch: Partial<FormSchema>) => void;
  onOpenImport: () => void;
  onUnlinkLayer: () => void;
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
        {form.linkedLayerId ? (
          <LinkedLayerSummary
            form={form}
            layerColumns={layerColumns}
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
      qs.push(buildAttachmentsGroup('photos', 'Photos'));
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
 * Convert a flat list of layer columns into questions, snapping each
 * to the most compatible question type. Stamps `bindTo.column` so the
 * Field-mode runtime can route values back to the right column.
 */
function questionsForColumns(cols: LayerColumn[]): Question[] {
  const qs: Question[] = [];
  for (const col of cols) {
    if (SKIP_PREFIX_RE.test(col.name)) continue;
    if (SKIP_EXACT.has(col.name.toLowerCase())) continue;
    const t = (col.type ?? '').toLowerCase();
    const id = col.name;
    const label = col.label ?? humanise(col.name);
    const required = col.nullable === false;
    const base = { id, label, required, bindTo: { column: col.name } };
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
  const inner = questionsForColumns(rel.columns);
  if (rel.attachmentsEnabled) {
    inner.push(buildAttachmentsGroup(`${rel.layerKeyOrItemId}_photos`, 'Photos'));
  }
  const id = suggestQuestionId(rel.label || 'related');
  return {
    id,
    type: 'group',
    label: rel.label,
    repeat: { addLabel: `Add another ${rel.label}` },
    bindTo: { column: rel.layerKeyOrItemId },
    children: inner,
  };
}

/**
 * Build a repeating group dedicated to attachments. Phase 1 ships
 * one photo question per instance so a respondent can capture N
 * images; future iterations may add captions / files / etc. The
 * group's bindTo is the layer key (or relationship id) the
 * Field-mode runtime uses to route attachments back to the right
 * feature_attachment row.
 */
function buildAttachmentsGroup(idHint: string, label: string): Question {
  return {
    id: suggestQuestionId(idHint),
    type: 'group',
    label,
    repeat: { addLabel: 'Add another photo' },
    children: [
      {
        id: 'photo',
        type: 'photo',
        label: 'Photo',
        maxCount: 1,
      },
    ],
  };
}

// ---- Link-status badge on each canvas row ----------------------

function LinkStatusBadge({ status }: { status: LinkStatus }) {
  if (status.kind === 'unbound') return null;
  if (status.kind === 'matched') {
    return (
      <span
        title={`Bound to column "${status.column.name}" (${status.column.type})`}
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
  layerColumns,
  canEdit,
  onUnlinkLayer,
}: {
  form: FormSchema;
  layerColumns: LayerColumn[] | null;
  canEdit: boolean;
  onUnlinkLayer: () => void;
}) {
  const linkedTitle =
    typeof form.meta?.linkedLayerTitle === 'string'
      ? (form.meta.linkedLayerTitle as string)
      : 'data layer';
  // Tally per-question status so the user sees at a glance how the
  // form lines up against the layer's current schema.
  let matched = 0;
  let willAdd = 0;
  for (const q of walkAll(form.questions)) {
    if (q.type === 'note' || q.type === 'page' || q.type === 'group') continue;
    const s = questionLinkStatus(q, layerColumns, true);
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
        {layerColumns === null
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

  return {
    columns,
    related,
    attachmentsEnabled: Boolean(picked?.attachmentsEnabled),
  };
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
  cols: LayerColumn[] | null,
  isLinked: boolean,
): LinkStatus {
  if (!isLinked || cols === null) return { kind: 'unbound' };
  // Skip pure-display question types and groups -- they don't bind.
  if (q.type === 'note' || q.type === 'page' || q.type === 'group') {
    return { kind: 'unbound' };
  }
  const colName = q.bindTo?.column ?? q.id;
  const match = cols.find((c) => c.name === colName);
  if (match) return { kind: 'matched', column: match };
  if (q.bindTo?.column) {
    // Explicit binding to a column the layer doesn't have. Could be
    // either "we'll add it on save" (the user just made the
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
