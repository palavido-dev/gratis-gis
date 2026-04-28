'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  AlignLeft,
  Calculator,
  Calendar,
  CalendarClock,
  Camera,
  CheckSquare,
  Circle,
  Clock,
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
 * Three-panel form designer (#131). Survey123-style layout: palette on
 * the left, canvas in the middle, properties on the right; a Preview
 * tab swaps the canvas with the live runtime so authors can sanity-
 * check what respondents will see.
 *
 * Persistence: the schema lives on the form item's `data_json`. Save
 * does a PUT to /api/portal/items/<id> with the full data field.
 *
 * Drag-drop: HTML5 native (no extra deps). Drag from palette into the
 * canvas to add; drag a canvas row by its grip to reorder. Touch
 * drag-drop is awkward on phones, so the palette + canvas also
 * support tap-to-add (selecting a palette tile inserts at the end of
 * the canvas).
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

  const selected = useMemo(
    () => (selectedId ? form.questions.find((q) => q.id === selectedId) ?? null : null),
    [form.questions, selectedId],
  );

  const addQuestion = useCallback(
    (type: QuestionType) => {
      const baseId = suggestQuestionId(type);
      const id = uniqueQuestionId(form, baseId);
      const q = defaultQuestion(type, id);
      setForm((f) => ({ ...f, questions: [...f.questions, q] }));
      setSelectedId(id);
    },
    [form],
  );

  const updateQuestion = useCallback(
    (id: QuestionId, patch: Partial<Question>) => {
      setForm((f) => ({
        ...f,
        questions: f.questions.map((q) =>
          q.id === id ? ({ ...q, ...patch } as Question) : q,
        ),
      }));
    },
    [],
  );

  const removeQuestion = useCallback((id: QuestionId) => {
    setForm((f) => ({
      ...f,
      questions: f.questions.filter((q) => q.id !== id),
    }));
    setSelectedId(null);
  }, []);

  const reorder = useCallback((from: number, to: number) => {
    setForm((f) => {
      const next = f.questions.slice();
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      return { ...f, questions: next };
    });
  }, []);

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
          <Palette canEdit={canEdit} onAdd={addQuestion} />
          <Canvas
            form={form}
            selectedId={selectedId}
            canEdit={canEdit}
            onSelect={setSelectedId}
            onRemove={removeQuestion}
            onReorder={reorder}
            onAdd={addQuestion}
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
              setForm((f) => ({
                ...f,
                questions: f.questions.map((q) =>
                  q.id === selected.id ? ({ ...q, id: newId } as Question) : q,
                ),
              }));
              setSelectedId(newId);
            }}
            onUpdateForm={(patch) => setForm({ ...form, ...patch })}
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
    </div>
  );
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
  { type: 'group', label: 'Group', icon: ListChecks, group: 'layout' },
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

// ---- Canvas -----------------------------------------------------

function Canvas({
  form,
  selectedId,
  canEdit,
  onSelect,
  onRemove,
  onReorder,
  onAdd,
}: {
  form: FormSchema;
  selectedId: QuestionId | null;
  canEdit: boolean;
  onSelect: (id: QuestionId) => void;
  onRemove: (id: QuestionId) => void;
  onReorder: (from: number, to: number) => void;
  onAdd: (type: QuestionType) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  function onDropTarget(toIndex: number, e: React.DragEvent) {
    e.preventDefault();
    const newType = e.dataTransfer.getData('text/x-question-type');
    if (newType) {
      // adding from palette
      onAdd(newType as QuestionType);
      return;
    }
    if (dragIndex !== null) {
      onReorder(dragIndex, toIndex);
    }
    setDragIndex(null);
    setOverIndex(null);
  }

  return (
    <main
      className="min-h-[420px] border-b border-border bg-surface-0 p-4 lg:border-b-0"
      onDragOver={(e) => {
        if (canEdit) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!canEdit) return;
        const newType = e.dataTransfer.getData('text/x-question-type');
        if (newType) onAdd(newType as QuestionType);
      }}
    >
      {form.questions.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-md border border-dashed border-border bg-surface-1 text-center text-sm text-muted">
          <Plus className="mb-2 h-5 w-5" />
          Drag a question type from the left, or tap one to add it.
        </div>
      ) : (
        <ul className="space-y-2">
          {form.questions.map((q, i) => (
            <li key={q.id}>
              <div
                className={`relative rounded-md border ${
                  q.id === selectedId
                    ? 'border-accent ring-2 ring-accent/30'
                    : 'border-border'
                } bg-surface-1 p-3 ${
                  overIndex === i ? 'border-t-2 border-t-accent' : ''
                }`}
                onClick={() => onSelect(q.id)}
                onDragOver={(e) => {
                  if (!canEdit) return;
                  e.preventDefault();
                  setOverIndex(i);
                }}
                onDrop={(e) => {
                  if (!canEdit) return;
                  onDropTarget(i, e);
                }}
                onDragLeave={() => setOverIndex(null)}
              >
                <div className="flex items-start gap-2">
                  {canEdit ? (
                    <button
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/x-reorder', String(i));
                        e.dataTransfer.effectAllowed = 'move';
                        setDragIndex(i);
                      }}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setOverIndex(null);
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
                    </p>
                    <p className="text-sm font-medium text-ink-0">{q.label}</p>
                    {q.hint ? (
                      <p className="text-xs text-muted">{q.hint}</p>
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
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
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
}: {
  form: FormSchema;
  question: Question | null;
  canEdit: boolean;
  onChange: (patch: Partial<Question>) => void;
  onRename: (newId: string) => void;
  onUpdateForm: (patch: Partial<FormSchema>) => void;
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
        <p className="mt-3 text-[11px] text-muted">
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

      {/* Type-specific bits */}
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

      <details className="mt-3 rounded-md border border-border bg-surface-1 p-2 text-xs">
        <summary className="cursor-pointer text-muted">Conditional logic</summary>
        <div className="mt-2 space-y-2">
          <ExpressionEditor
            label="Visible if"
            value={question.visibleIf}
            allFields={form.questions.map((q) => ({ id: q.id, label: q.label }))}
            disabled={!canEdit}
            onChange={(visibleIf) => onChange({ visibleIf })}
          />
        </div>
      </details>
    </aside>
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
  // Phase 1 minimal builder: a single `eq` between a question ref
  // and a literal. The Expression type already supports the fuller
  // shape; the builder UI catches up in Phase 2.
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
