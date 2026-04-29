'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Loader2,
  MapPin,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  applyCalculations,
  evaluate,
  isRequired,
  isVisible,
  labelForAddressComponent,
  labelForNameComponent,
  pruneHidden,
  validate,
  walkQuestions,
  type Expression,
  type FormSchema,
  type Question,
  type Response,
  type ValidationError,
} from '@gratis-gis/form-schema';

/**
 * Mobile-first runtime that renders any FormSchema and captures a
 * Response. Used in two places:
 *
 *   - Designer preview pane: live preview of the form while
 *     authoring, with the in-memory schema.
 *   - Respondent page: end-user filling in a published form.
 *     `/forms/<id>/respond` mounts this directly.
 *
 * Mobile + offline considerations:
 *   - Single-column layout, generous tap targets (44+ px).
 *   - Native input types (`date`, `time`, `datetime-local`, `tel`,
 *     `number` with `inputmode`) so phone keyboards do the right
 *     thing.
 *   - No third-party UI deps -- everything renders even if assets
 *     are stale in the service worker cache.
 *   - The submit handler is a hook; the caller decides what to do
 *     with the response (immediate POST when online, or drop into
 *     the IndexedDB outbox when offline).
 *
 * Pages: when the schema contains a `page` question, the runtime
 * renders one page at a time. Without pages, it's a single scroll.
 */
export interface FormRuntimeProps {
  form: FormSchema;
  /** Initial response (e.g. resuming a draft, or pre-filled values
   *  from the Field runtime when the user tapped an existing
   *  feature). */
  initial?: Response;
  /** Async submit handler. Receives the pruned response (hidden
   *  fields stripped, calculations applied) and the form's
   *  schemaVersion so the caller can stamp the submission. */
  onSubmit: (response: Response) => Promise<void>;
  /** Override the submit button label ("Submit" / "Save" / "Send"). */
  submitLabel?: string;
  /** When true, the form renders read-only with an empty submit
   *  area -- used for designer preview to avoid accidental dummy
   *  submissions. */
  readOnly?: boolean;
}

export function FormRuntime({
  form,
  initial,
  onSubmit,
  submitLabel = 'Submit',
  readOnly = false,
}: FormRuntimeProps) {
  const [response, setResponse] = useState<Response>(() =>
    applyCalculations(form, initial ?? {}),
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // Re-run calculations whenever a referenced value might have
  // changed. Cheap because applyCalculations short-circuits on
  // identity equality when nothing actually changed.
  useEffect(() => {
    const next = applyCalculations(form, response);
    if (next !== response) setResponse(next);
  }, [form, response]);

  const pages = useMemo(() => splitIntoPages(form), [form]);
  const currentPage = pages[pageIndex] ?? pages[0]!;

  const errorByQuestion = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of errors) m.set(e.questionId, e.message);
    return m;
  }, [errors]);

  function setValue(id: string, value: unknown) {
    setResponse((prev) => ({ ...prev, [id]: value }));
  }

  async function handleSubmit() {
    if (readOnly) return;
    const result = validate(form, response);
    if (!result.ok) {
      setErrors(result.errors);
      // Jump to the first page with an error.
      for (let i = 0; i < pages.length; i += 1) {
        const ids = collectIdsOnPage(pages[i]!);
        if (result.errors.some((e) => ids.has(e.questionId))) {
          setPageIndex(i);
          break;
        }
      }
      return;
    }
    setErrors([]);
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onSubmit(pruneHidden(form, response));
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 px-4 py-12 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <Check className="h-6 w-6" />
        </span>
        <h2 className="text-lg font-semibold tracking-tight text-ink-0">
          Submitted
        </h2>
        <p className="text-sm text-muted">
          Thanks. Your response has been recorded.
        </p>
        <button
          type="button"
          onClick={() => {
            setResponse(applyCalculations(form, {}));
            setPageIndex(0);
            setSubmitted(false);
          }}
          className="mt-3 inline-flex h-9 items-center rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2"
        >
          Submit another response
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-24 pt-4 sm:pt-6">
      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight text-ink-0 sm:text-2xl">
          {form.title}
        </h1>
        {form.description ? (
          <p className="mt-1 text-sm text-muted">{form.description}</p>
        ) : null}
        {pages.length > 1 ? (
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs uppercase tracking-wide text-muted">
              Page {pageIndex + 1} of {pages.length}
            </p>
            <div
              className="h-1 flex-1 ml-3 overflow-hidden rounded bg-surface-2"
              aria-hidden
            >
              <div
                className="h-full bg-accent transition-all"
                style={{
                  width: `${((pageIndex + 1) / pages.length) * 100}%`,
                }}
              />
            </div>
          </div>
        ) : null}
      </header>

      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (pageIndex < pages.length - 1) {
            setPageIndex(pageIndex + 1);
          } else {
            void handleSubmit();
          }
        }}
      >
        {/* Page-level row-packing. Same machinery is reused inside
            groups and repeating instances via PackedRows so the
            author's side-by-side layout shows up everywhere, not
            just at the root. Mobile collapses to full-width. */}
        <PackedRows
          questions={currentPage.questions}
          response={response}
          errorByQuestion={errorByQuestion}
          readOnly={readOnly}
          onSet={setValue}
        />

        {submitError ? (
          <p className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
            {submitError}
          </p>
        ) : null}

        <div className="sticky bottom-0 left-0 right-0 -mx-4 mt-6 flex items-center gap-2 border-t border-border bg-surface-1 px-4 py-3">
          {pageIndex > 0 ? (
            <button
              type="button"
              onClick={() => setPageIndex(pageIndex - 1)}
              className="inline-flex h-11 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
          ) : null}
          <div className="flex-1" />
          {readOnly ? (
            <span className="text-xs text-muted">Preview mode</span>
          ) : pageIndex < pages.length - 1 ? (
            <button
              type="submit"
              className="inline-flex h-11 items-center gap-1 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:opacity-90"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex h-11 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {submitLabel}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

// ---- Per-question rendering -------------------------------------

function QuestionField({
  q,
  response,
  error,
  readOnly,
  onChange,
}: {
  q: Question;
  response: Response;
  error: string | null;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  if (!isVisible(q, response)) return null;

  if (q.type === 'page') return null;
  if (q.type === 'hidden') return null;
  if (q.type === 'note') {
    return (
      <div className="rounded-md border border-border bg-surface-2/40 px-3 py-2 text-sm text-ink-1">
        {q.label}
      </div>
    );
  }
  if (q.type === 'divider') {
    return <Input q={q} value={null} readOnly={readOnly} onChange={onChange} />;
  }
  if (q.type === 'image-display') {
    return <Input q={q} value={null} readOnly={readOnly} onChange={onChange} />;
  }
  if (q.type === 'group') {
    return <GroupField q={q} response={response} error={error} readOnly={readOnly} onChange={onChange} />;
  }

  const value = response[q.id];
  const required = isRequired(q, response);
  const requiredMark = required ? (
    <span className="ml-0.5 text-danger" aria-hidden>
      *
    </span>
  ) : null;

  return (
    <div className="space-y-1">
      <label
        className="block text-sm font-medium text-ink-0"
        htmlFor={q.id}
      >
        {q.label}
        {requiredMark}
      </label>
      {q.hint ? <p className="text-xs text-muted">{q.hint}</p> : null}
      <Input q={q} value={value} readOnly={readOnly} onChange={onChange} />
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function GroupField({
  q,
  response,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'group' }>;
  response: Response;
  error: string | null;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  // Repeating group: stored as an array of Response objects.
  // Non-repeating group: child responses live at the top level
  // (group is purely a visual container).
  if (!q.repeat) {
    return (
      <fieldset className="rounded-md border border-border bg-surface-2/30 p-3">
        <legend className="px-2 text-sm font-medium text-ink-0">
          {q.label}
        </legend>
        <PackedRows
          questions={q.children}
          response={response}
          readOnly={readOnly}
          onSet={(id, v) =>
            onChange({
              ...(response[q.id] as object | undefined),
              [id]: v,
            })
          }
        />
      </fieldset>
    );
  }
  const instances = (Array.isArray(response[q.id])
    ? (response[q.id] as Response[])
    : []) as Response[];
  return (
    <fieldset className="rounded-md border border-border bg-surface-2/30 p-3">
      <legend className="px-2 text-sm font-medium text-ink-0">{q.label}</legend>
      <div className="space-y-3">
        {instances.map((inst, idx) => (
          <div key={idx} className="rounded-md border border-border bg-surface-1 p-3">
            <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
              <span>Instance {idx + 1}</span>
              {!readOnly ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-danger"
                  onClick={() => {
                    const next = instances.filter((_, i) => i !== idx);
                    onChange(next);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                  Remove
                </button>
              ) : null}
            </div>
            <PackedRows
              questions={q.children}
              response={inst}
              readOnly={readOnly}
              onSet={(id, v) => {
                const next = instances.slice();
                next[idx] = { ...inst, [id]: v };
                onChange(next);
              }}
            />
          </div>
        ))}
        {!readOnly &&
        (q.repeat.max === undefined || instances.length < q.repeat.max) ? (
          <button
            type="button"
            onClick={() => {
              onChange([...instances, {}]);
            }}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-dashed border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2"
          >
            <Plus className="h-4 w-4" />
            {q.repeat.addLabel ?? `Add another ${q.label}`}
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}

/**
 * Render a flat list of questions packed into rows by their declared
 * widths. Used at the top of every page and inside every group / repeat
 * instance so the side-by-side layout the author set up shows up
 * everywhere, not just at the form's root level.
 */
function PackedRows({
  questions,
  response,
  errorByQuestion,
  readOnly,
  onSet,
}: {
  questions: Question[];
  response: Response;
  errorByQuestion?: Map<string, string>;
  readOnly: boolean;
  onSet: (id: string, v: unknown) => void;
}) {
  return (
    <div className="space-y-5 sm:space-y-4">
      {packIntoRows(questions).map((row, rowIdx) => (
        <div
          key={`row-${rowIdx}`}
          className="flex flex-col gap-5 sm:flex-row sm:flex-wrap sm:gap-4"
        >
          {row.map((q) => (
            <div
              key={q.id}
              className={`min-w-0 ${widthToClass(q.layout?.width)}`}
            >
              <QuestionField
                q={q}
                response={response}
                error={errorByQuestion?.get(q.id) ?? null}
                readOnly={readOnly || isReadOnly(q, response)}
                onChange={(v) => onSet(q.id, v)}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Static, non-interactive preview of one question's input UI. The
 * designer renders this inline beneath each question card so authors
 * can see what a respondent would actually see without flipping to
 * the Preview tab.
 *
 * The wrapper sets `pointer-events: none` so clicks on the input
 * pass through to the design-view's selection handler instead of
 * activating the radio / button. Also dims slightly to telegraph
 * "this is a preview, not interactive."
 */
export function QuestionPreview({ q }: { q: Question }) {
  // Pages, hidden, and group are structural -- nothing to render.
  // Note (text panel) and divider already render on their own.
  if (q.type === 'page' || q.type === 'hidden' || q.type === 'group') {
    return null;
  }
  // Photo / signature / file would either render an empty file
  // picker or a message. Show a small badge instead.
  if (q.type === 'photo' || q.type === 'file' || q.type === 'signature') {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface-2/30 px-3 py-2 text-[11px] text-muted">
        {q.type === 'signature'
          ? 'Signature pad'
          : q.type === 'photo'
            ? 'Photo capture'
            : 'File upload'}
      </div>
    );
  }
  return (
    <div
      className="pointer-events-none select-none opacity-90"
      aria-hidden="true"
    >
      <Input q={q} value={null} readOnly onChange={() => {}} />
    </div>
  );
}

// Per-type input renderers. Native HTML inputs everywhere -- mobile
// pickers come for free.
function Input({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Question;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const baseClass =
    'block w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-base text-ink-0 placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60';

  switch (q.type) {
    case 'text':
      return (
        <input
          id={q.id}
          type={q.obscured ? 'password' : 'text'}
          inputMode="text"
          value={(value as string) ?? ''}
          maxLength={q.maxLength}
          placeholder={q.placeholder}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        />
      );
    case 'multiline':
      return (
        <textarea
          id={q.id}
          rows={q.rows ?? 3}
          value={(value as string) ?? ''}
          maxLength={q.maxLength}
          placeholder={q.placeholder}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        />
      );
    case 'email':
      return (
        <input
          id={q.id}
          type="email"
          inputMode="email"
          autoComplete="email"
          value={(value as string) ?? ''}
          maxLength={q.maxLength}
          placeholder={q.placeholder}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        />
      );
    case 'url':
      return (
        <input
          id={q.id}
          type="url"
          inputMode="url"
          autoComplete="url"
          value={(value as string) ?? ''}
          maxLength={q.maxLength}
          placeholder={q.placeholder}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        />
      );
    case 'phone':
      return (
        <input
          id={q.id}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={(value as string) ?? ''}
          placeholder={q.placeholder}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        />
      );
    case 'regex':
      return (
        <input
          id={q.id}
          type="text"
          value={(value as string) ?? ''}
          maxLength={q.maxLength}
          placeholder={q.placeholder}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        />
      );
    case 'number':
      return (
        <input
          id={q.id}
          type="number"
          inputMode="decimal"
          value={value === null || value === undefined ? '' : (value as number | string)}
          // Default to "any" so the input accepts decimals when the
          // question schema doesn't specify a precision. Without this,
          // browsers fall through to step="1" and silently reject
          // ".5" / "1.25" / etc., which surprises authors who picked
          // the `number` type specifically because they wanted
          // decimals (the dedicated `integer` type is the
          // whole-number variant).
          step={q.step ?? 'any'}
          min={q.min}
          max={q.max}
          disabled={readOnly}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? null : Number(v));
          }}
          className={baseClass}
        />
      );
    case 'integer':
      return (
        <input
          id={q.id}
          type="number"
          inputMode="numeric"
          step={1}
          value={value === null || value === undefined ? '' : (value as number | string)}
          min={q.min}
          max={q.max}
          disabled={readOnly}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? null : Math.trunc(Number(v)));
          }}
          className={baseClass}
        />
      );
    case 'boolean':
      return (
        <div className="flex gap-2">
          {[
            { v: true, label: q.trueLabel ?? 'Yes' },
            { v: false, label: q.falseLabel ?? 'No' },
          ].map((opt) => (
            <button
              type="button"
              key={String(opt.v)}
              disabled={readOnly}
              onClick={() => onChange(opt.v)}
              className={`h-11 flex-1 rounded-md border text-sm font-medium ${
                value === opt.v
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      );
    case 'select-one':
      if (q.appearance === 'dropdown') {
        return (
          <select
            id={q.id}
            value={(value as string) ?? ''}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.value || null)}
            className={baseClass}
          >
            <option value="">--</option>
            {q.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        );
      }
      return (
        <div className="space-y-1.5">
          {q.choices.map((c) => (
            <label
              key={c.value}
              className={`flex h-11 items-center gap-2 rounded-md border px-3 text-sm ${
                value === c.value
                  ? 'border-accent bg-accent/5'
                  : 'border-border bg-surface-1'
              }`}
            >
              <input
                type="radio"
                name={q.id}
                value={c.value}
                checked={value === c.value}
                disabled={readOnly}
                onChange={() => onChange(c.value)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      );
    case 'select-many': {
      const arr = (Array.isArray(value) ? (value as string[]) : []);
      return (
        <div className="space-y-1.5">
          {q.choices.map((c) => {
            const checked = arr.includes(c.value);
            return (
              <label
                key={c.value}
                className={`flex h-11 items-center gap-2 rounded-md border px-3 text-sm ${
                  checked ? 'border-accent bg-accent/5' : 'border-border bg-surface-1'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={readOnly}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...arr, c.value]
                        : arr.filter((v) => v !== c.value),
                    )
                  }
                />
                <span>{c.label}</span>
              </label>
            );
          })}
        </div>
      );
    }
    case 'matrix-single':
      return (
        <MatrixSingleInput
          q={q}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
    case 'matrix-multi':
      return (
        <MatrixMultiInput
          q={q}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
    case 'matrix-dropdown':
      return (
        <MatrixDropdownInput
          q={q}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
    case 'matrix-rating':
      return (
        <MatrixRatingInput
          q={q}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
    case 'ranking':
      return (
        <RankingInput
          q={q}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
    case 'date':
      return (
        <input
          id={q.id}
          type="date"
          value={(value as string) ?? ''}
          min={q.min}
          max={q.max}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value || null)}
          className={baseClass}
        />
      );
    case 'time':
      return (
        <input
          id={q.id}
          type="time"
          value={(value as string) ?? ''}
          min={q.min}
          max={q.max}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value || null)}
          className={baseClass}
        />
      );
    case 'datetime':
      return (
        <input
          id={q.id}
          type="datetime-local"
          value={(value as string) ?? ''}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value || null)}
          className={baseClass}
        />
      );
    case 'name':
      return <NameInput q={q} value={value} readOnly={readOnly} onChange={onChange} />;
    case 'address':
      return <AddressInput q={q} value={value} readOnly={readOnly} onChange={onChange} />;
    case 'photo':
      return <PhotoInput q={q} value={value} readOnly={readOnly} onChange={onChange} />;
    case 'file':
      return <FileInput q={q} value={value} readOnly={readOnly} onChange={onChange} />;
    case 'image-choice':
      return (
        <ImageChoiceInput
          q={q}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
    case 'image-display':
      return <ImageDisplay q={q} />;
    case 'image-hotspot':
      return (
        <ImageHotspotInput
          q={q}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
    case 'signature':
      return (
        <div className="rounded-md border border-dashed border-border bg-surface-2/30 p-4 text-center text-xs text-muted">
          Signature capture is part of Phase 2 of the Data Collection rollout.
        </div>
      );
    case 'geopoint':
      return <GeoPointInput q={q} value={value} readOnly={readOnly} onChange={onChange} />;
    case 'geotrace':
    case 'geoshape':
      return (
        <div className="rounded-md border border-dashed border-border bg-surface-2/30 p-4 text-center text-xs text-muted">
          Polyline / polygon capture is part of Phase 2 of the Data
          Collection rollout.
        </div>
      );
    case 'rating': {
      const max = q.max ?? 5;
      const cur = typeof value === 'number' ? value : 0;
      return (
        <div className="flex gap-1.5">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              type="button"
              key={n}
              disabled={readOnly}
              onClick={() => onChange(n)}
              className={`h-11 w-11 rounded-md border text-lg ${
                n <= cur ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface-1'
              }`}
              aria-label={`${n} of ${max}`}
            >
              {q.shape === 'heart' ? '♥' : q.shape === 'thumb' ? '\u{1F44D}' : '★'}
            </button>
          ))}
        </div>
      );
    }
    case 'likert': {
      const points = q.points ?? 5;
      const cur = typeof value === 'number' ? value : 0;
      return (
        <div>
          <div
            className="grid items-center gap-1 rounded-md border border-border bg-surface-1 p-2"
            style={{ gridTemplateColumns: `repeat(${points}, 1fr)` }}
          >
            {Array.from({ length: points }, (_, i) => i + 1).map((n) => (
              <button
                type="button"
                key={n}
                disabled={readOnly}
                onClick={() => onChange(n)}
                className={`flex h-11 items-center justify-center rounded-md border text-sm tabular-nums ${
                  cur === n
                    ? 'border-accent bg-accent/10 text-accent font-medium'
                    : 'border-border bg-surface-1 hover:bg-surface-2'
                }`}
                aria-label={`Point ${n} of ${points}`}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
            <span>{q.leftLabel ?? ''}</span>
            {q.centerLabel ? <span>{q.centerLabel}</span> : null}
            <span>{q.rightLabel ?? ''}</span>
          </div>
        </div>
      );
    }
    case 'nps': {
      const cur = typeof value === 'number' ? value : -1;
      // NPS scoring: 0..6 detractor (red), 7..8 passive (amber),
      // 9..10 promoter (green). The fill colors track those bands so
      // the respondent's choice maps visually to the score they're
      // giving.
      function bandClass(n: number, selected: boolean): string {
        if (!selected) {
          return 'border-border bg-surface-1 hover:bg-surface-2 text-ink-1';
        }
        if (n <= 6) return 'border-danger bg-danger/15 text-danger font-medium';
        if (n <= 8) return 'border-warning bg-warning/15 text-warning font-medium';
        return 'border-success bg-success/15 text-success font-medium';
      }
      return (
        <div>
          {q.caption ? (
            <p className="mb-1 text-xs text-muted">{q.caption}</p>
          ) : null}
          <div className="grid grid-cols-11 gap-1">
            {Array.from({ length: 11 }, (_, n) => (
              <button
                type="button"
                key={n}
                disabled={readOnly}
                onClick={() => onChange(n)}
                className={`flex h-10 items-center justify-center rounded-md border text-sm tabular-nums ${bandClass(n, cur === n)}`}
                aria-label={`${n}`}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted">
            <span>Not at all likely</span>
            <span>Extremely likely</span>
          </div>
        </div>
      );
    }
    case 'slider': {
      const cur = typeof value === 'number' ? value : q.min;
      return (
        <div>
          <input
            id={q.id}
            type="range"
            min={q.min}
            max={q.max}
            step={q.step ?? 1}
            value={cur}
            disabled={readOnly}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-11 w-full"
          />
          {q.showValue ? (
            <p className="mt-1 text-right text-xs tabular-nums text-muted">{cur}</p>
          ) : null}
        </div>
      );
    }
    case 'calculated':
      return (
        <div className="rounded-md border border-border bg-surface-2/40 px-3 py-2 text-sm text-ink-1">
          {value === null || value === undefined || value === ''
            ? '-'
            : String(value)}
        </div>
      );
    case 'note':
    case 'page':
    case 'group':
    case 'hidden':
      return null;
    case 'divider':
      return (
        <div className="my-1">
          {q.caption ? (
            <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">
              {q.caption}
            </p>
          ) : null}
          <hr className="border-border" />
        </div>
      );
    case 'acknowledge':
      return (
        <AcknowledgeInput
          q={q}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
  }
}

function PhotoInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'photo' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  // Phase 1: capture as data URLs in IndexedDB-friendly arrays. The
  // server-side upload-to-MinIO wiring lands in Phase 2.
  const photos: string[] = Array.isArray(value) ? (value as string[]) : [];
  const max = q.maxCount ?? 1;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {photos.map((src, i) => (
          <div
            key={i}
            className="relative h-20 w-20 overflow-hidden rounded-md border border-border bg-surface-2"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" className="h-full w-full object-cover" />
            {!readOnly ? (
              <button
                type="button"
                onClick={() => onChange(photos.filter((_, j) => j !== i))}
                className="absolute right-0 top-0 rounded-bl bg-black/60 p-0.5 text-white"
                aria-label="Remove photo"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        ))}
        {!readOnly && photos.length < max ? (
          <label className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-surface-1 text-xs text-muted hover:bg-surface-2">
            <Camera className="h-5 w-5" />
            Photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const dataUrl = await fileToDataUrl(file);
                onChange([...photos, dataUrl]);
              }}
            />
          </label>
        ) : null}
      </div>
      <p className="text-[11px] text-muted">
        {photos.length} of {max} {max === 1 ? 'photo' : 'photos'}
      </p>
    </div>
  );
}

/**
 * Composite name input. Renders one labeled <input> per requested
 * component; lays them out in a responsive grid that collapses on
 * mobile. The `prefix` and `suffix` cells stay narrow when shown.
 */
/**
 * Image-choice: a grid of clickable thumbnails. Single or multi
 * select per `q.multi`. The whole tile is the click target so
 * touch users don't have to hit a small radio.
 */
/**
 * Acknowledgement: long-form text plus a required checkbox. When
 * the user checks the box the runtime stamps an ISO timestamp into
 * the response so the system has an audit trail of when consent
 * was given. Unchecking clears the timestamp.
 */
function AcknowledgeInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'acknowledge' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const checked =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Boolean((value as { acknowledged?: unknown }).acknowledged)
      : false;
  const at =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { at?: unknown }).at
      : undefined;

  function set(nextChecked: boolean) {
    if (readOnly) return;
    if (nextChecked) {
      onChange({ acknowledged: true, at: new Date().toISOString() });
    } else {
      onChange({ acknowledged: false });
    }
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-surface-2/30 p-3 text-sm text-ink-1 whitespace-pre-line">
        {q.body}
      </div>
      <label className="flex items-start gap-2 rounded-md border border-border bg-surface-1 p-3 text-sm">
        <input
          type="checkbox"
          checked={checked}
          disabled={readOnly}
          onChange={(e) => set(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span>{q.agreeLabel ?? 'I have read and agree.'}</span>
          {checked && typeof at === 'string' ? (
            <span className="ml-2 text-[11px] text-muted">
              ({new Date(at).toLocaleString()})
            </span>
          ) : null}
        </span>
      </label>
    </div>
  );
}

/**
 * Generic file upload. Captures attachments as `{ name, mimeType,
 * sizeBytes, dataUrl }` so the offline outbox can persist them
 * without an immediate network upload. Phase 2 swaps the data URL
 * for a MinIO object key once the server-side pipeline lands.
 */
function FileInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'file' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  type Attachment = {
    name: string;
    mimeType: string;
    sizeBytes: number;
    dataUrl: string;
  };
  const files: Attachment[] = Array.isArray(value)
    ? (value as Attachment[]).filter(
        (f): f is Attachment =>
          f !== null &&
          typeof f === 'object' &&
          typeof (f as Attachment).name === 'string' &&
          typeof (f as Attachment).dataUrl === 'string',
      )
    : [];
  const max = q.maxCount ?? 1;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    if (readOnly) return;
    const picked = e.target.files;
    if (!picked || picked.length === 0) return;
    const next: Attachment[] = files.slice();
    for (const f of Array.from(picked)) {
      if (next.length >= max) break;
      const dataUrl = await fileToDataUrl(f);
      next.push({
        name: f.name,
        mimeType: f.type || 'application/octet-stream',
        sizeBytes: f.size,
        dataUrl,
      });
    }
    onChange(next);
    e.target.value = '';
  }

  function remove(idx: number) {
    if (readOnly) return;
    onChange(files.filter((_, i) => i !== idx));
  }

  function fmtSize(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className="space-y-2">
      {files.length > 0 ? (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm"
            >
              <span className="flex-1 truncate" title={f.name}>
                {f.name}
              </span>
              <span className="text-[11px] text-muted">{fmtSize(f.sizeBytes)}</span>
              {!readOnly ? (
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                  aria-label="Remove file"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!readOnly && files.length < max ? (
        <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-dashed border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2">
          <Plus className="h-4 w-4 text-muted" />
          <span>Add file</span>
          <input
            type="file"
            className="sr-only"
            accept={q.accept}
            onChange={onPick}
          />
        </label>
      ) : null}
      <p className="text-[11px] text-muted">
        {files.length} of {max} {max === 1 ? 'file' : 'files'} attached
      </p>
    </div>
  );
}

function ImageChoiceInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'image-choice' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const multi = Boolean(q.multi);
  const arr: string[] = Array.isArray(value) ? (value as string[]) : [];
  const single: string | null = typeof value === 'string' ? value : null;

  function toggle(v: string) {
    if (readOnly) return;
    if (multi) {
      onChange(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    } else {
      onChange(single === v ? null : v);
    }
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
      {q.choices.map((c) => {
        const selected = multi ? arr.includes(c.value) : single === c.value;
        return (
          <button
            type="button"
            key={c.value}
            onClick={() => toggle(c.value)}
            disabled={readOnly}
            className={`group flex flex-col overflow-hidden rounded-md border text-left text-xs ${
              selected
                ? 'border-accent ring-2 ring-accent/40'
                : 'border-border hover:border-accent/50'
            }`}
          >
            <div className="aspect-square w-full bg-surface-2 sm:aspect-[4/3]">
              {c.imageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={c.imageUrl}
                  alt={c.alt ?? c.label}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[11px] text-muted">
                  No image
                </div>
              )}
            </div>
            <div
              className={`px-2 py-1.5 ${selected ? 'bg-accent/10 text-accent' : 'bg-surface-1 text-ink-1'}`}
            >
              {c.label}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Image-display: a static image embed. No value captured. Used as
 * instructional content; the runtime walker treats this as a
 * non-input question.
 */
function ImageDisplay({
  q,
}: {
  q: Extract<Question, { type: 'image-display' }>;
}) {
  if (!q.imageUrl) {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface-2/30 p-4 text-center text-xs text-muted">
        No image set.
      </div>
    );
  }
  return (
    <figure className="overflow-hidden rounded-md border border-border bg-surface-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={q.imageUrl}
        alt={q.alt ?? q.label}
        className="block h-auto w-full object-contain"
      />
      {q.caption ? (
        <figcaption className="border-t border-border bg-surface-2/40 px-3 py-1.5 text-[11px] text-muted">
          {q.caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * Image-hotspot: respondent clicks one or more points on the
 * reference image. Coordinates are stored as fractions of the
 * image's natural size so they survive resizes.
 */
function ImageHotspotInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'image-hotspot' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const points: { x: number; y: number }[] = Array.isArray(value)
    ? (value as { x: number; y: number }[]).filter(
        (p): p is { x: number; y: number } =>
          p !== null &&
          typeof p === 'object' &&
          typeof (p as { x: unknown }).x === 'number' &&
          typeof (p as { y: unknown }).y === 'number',
      )
    : [];
  const max = q.maxPoints ?? 1;

  function addPoint(e: React.MouseEvent<HTMLDivElement>) {
    if (readOnly) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (max <= 1) {
      onChange([{ x, y }]);
    } else {
      const next = [...points, { x, y }];
      onChange(next.slice(-max));
    }
  }

  function clearPoints() {
    if (readOnly) return;
    onChange([]);
  }

  if (!q.imageUrl) {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface-2/30 p-4 text-center text-xs text-muted">
        Set an image URL in the question Properties to enable hotspot
        capture.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        onClick={addPoint}
        className="relative inline-block w-full cursor-crosshair overflow-hidden rounded-md border border-border bg-surface-1"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={q.imageUrl}
          alt={q.alt ?? q.label}
          className="block h-auto w-full select-none object-contain"
          draggable={false}
        />
        {points.map((p, i) => (
          <div
            key={i}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
          >
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-white shadow">
              {i + 1}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>
          {points.length} of {max} {max === 1 ? 'point' : 'points'} placed
        </span>
        {!readOnly && points.length > 0 ? (
          <button
            type="button"
            onClick={clearPoints}
            className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs hover:bg-surface-2"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

function NameInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'name' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const components = q.components ?? ['first', 'last'];
  const map: Record<string, string> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};

  function set(component: string, raw: string) {
    const next = { ...map };
    if (raw === '') delete next[component];
    else next[component] = raw;
    onChange(Object.keys(next).length === 0 ? null : next);
  }

  // Two-column on sm+: prefix / first / middle / last / suffix in a
  // sane shape. We use a 6-col grid where prefix/suffix span 1, the
  // name cells span 2.
  function spanFor(c: string): string {
    if (c === 'prefix' || c === 'suffix') return 'sm:col-span-1';
    return 'sm:col-span-2';
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-6">
      {components.map((c) => (
        <label key={c} className={`flex flex-col gap-1 ${spanFor(c)}`}>
          <span className="text-[11px] text-muted">
            {labelForNameComponent(c)}
          </span>
          <input
            type="text"
            value={map[c] ?? ''}
            disabled={readOnly}
            autoComplete={
              c === 'first'
                ? 'given-name'
                : c === 'last'
                  ? 'family-name'
                  : c === 'middle'
                    ? 'additional-name'
                    : c === 'prefix'
                      ? 'honorific-prefix'
                      : c === 'suffix'
                        ? 'honorific-suffix'
                        : 'off'
            }
            onChange={(e) => set(c, e.target.value)}
            className="h-11 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
      ))}
    </div>
  );
}

/**
 * Composite postal address input. Components are rendered in a
 * sensible form layout (street1/2 stack full-width, city/region/postal
 * share a row on sm+, country full-width).
 */
function AddressInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'address' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const components =
    q.components ?? ['street1', 'street2', 'city', 'region', 'postal', 'country'];
  const map: Record<string, string> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};

  function set(component: string, raw: string) {
    const next = { ...map };
    if (raw === '') delete next[component];
    else next[component] = raw;
    onChange(Object.keys(next).length === 0 ? null : next);
  }

  // Map component to its grid placement. We use a 6-col grid:
  // street1, street2, country: full row
  // city: 3, region: 2, postal: 1 -- the standard US-style row.
  function spanFor(c: string): string {
    if (c === 'street1' || c === 'street2' || c === 'country') {
      return 'sm:col-span-6';
    }
    if (c === 'city') return 'sm:col-span-3';
    if (c === 'region') return 'sm:col-span-2';
    if (c === 'postal') return 'sm:col-span-1';
    return 'sm:col-span-6';
  }

  function autoFor(c: string): string {
    switch (c) {
      case 'street1':
        return 'address-line1';
      case 'street2':
        return 'address-line2';
      case 'city':
        return 'address-level2';
      case 'region':
        return 'address-level1';
      case 'postal':
        return 'postal-code';
      case 'country':
        return 'country-name';
      default:
        return 'off';
    }
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-6">
      {components.map((c) => (
        <label key={c} className={`flex flex-col gap-1 ${spanFor(c)}`}>
          <span className="text-[11px] text-muted">
            {labelForAddressComponent(c)}
          </span>
          <input
            type="text"
            value={map[c] ?? ''}
            disabled={readOnly}
            autoComplete={autoFor(c)}
            onChange={(e) => set(c, e.target.value)}
            className="h-11 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
      ))}
    </div>
  );
}

function GeoPointInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'geopoint' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const point = (value as { lat: number; lng: number; accuracy?: number } | null) ?? null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function capture() {
    if (!('geolocation' in navigator)) {
      setErr('Geolocation not supported on this device.');
      return;
    }
    setBusy(true);
    setErr(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onChange({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setBusy(false);
      },
      (e) => {
        setErr(e.message);
        setBusy(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  return (
    <div className="space-y-2">
      {point ? (
        <div className="rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-1">
          <p className="font-mono text-xs">
            {point.lat.toFixed(6)}, {point.lng.toFixed(6)}
          </p>
          {point.accuracy !== undefined ? (
            <p className="text-[11px] text-muted">
              ± {point.accuracy.toFixed(0)} m
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted">No location captured yet.</p>
      )}
      {!readOnly &&
      (q.capture === 'auto' || q.capture === 'gps' || q.capture === undefined) ? (
        <button
          type="button"
          onClick={capture}
          disabled={busy}
          className="inline-flex h-11 items-center gap-2 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
          {point ? 'Recapture' : 'Capture location'}
        </button>
      ) : null}
      {!readOnly && q.capture === 'manual' ? (
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            placeholder="Latitude"
            value={point?.lat ?? ''}
            onChange={(e) => onChange({ ...(point ?? { lng: 0 }), lat: Number(e.target.value) })}
            className="block h-11 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <input
            type="number"
            placeholder="Longitude"
            value={point?.lng ?? ''}
            onChange={(e) => onChange({ ...(point ?? { lat: 0 }), lng: Number(e.target.value) })}
            className="block h-11 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
      ) : null}
      {err ? <p className="text-xs text-danger">{err}</p> : null}
    </div>
  );
}

/**
 * Matrix (single choice per row). On desktop renders as a CSS grid
 * with column headers across the top and row labels down the left.
 * On mobile (< sm breakpoint) collapses to a stack: each row shows
 * its label, then the choices below as full-width radio buttons --
 * cramped grid cells are unusable on a phone.
 */
function MatrixSingleInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'matrix-single' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const map: Record<string, string> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};

  function set(rowId: string, col: string | null) {
    const next = { ...map };
    if (col === null) delete next[rowId];
    else next[rowId] = col;
    onChange(next);
  }

  return (
    <div>
      {/* Desktop: grid */}
      <div className="hidden sm:block">
        <div
          className="grid items-center gap-x-2 gap-y-1 overflow-x-auto rounded-md border border-border bg-surface-1 p-2 text-sm"
          style={{
            gridTemplateColumns: `minmax(8rem, 1.4fr) repeat(${q.columns.length}, minmax(5rem, 1fr))`,
          }}
        >
          <div />
          {q.columns.map((c) => (
            <div
              key={c.value}
              className="px-1 text-center text-[11px] font-medium text-muted"
            >
              {c.label}
            </div>
          ))}
          {q.rows.map((row, idx) => (
            <MatrixSingleRow
              key={row.id}
              row={row}
              columns={q.columns}
              selected={map[row.id] ?? null}
              odd={idx % 2 === 1}
              readOnly={readOnly}
              onChange={(col) => set(row.id, col)}
            />
          ))}
        </div>
      </div>

      {/* Mobile: stacked rows */}
      <div className="space-y-3 sm:hidden">
        {q.rows.map((row) => (
          <fieldset key={row.id} className="rounded-md border border-border bg-surface-1 p-2">
            <legend className="px-1 text-sm font-medium text-ink-1">
              {row.label}
            </legend>
            <div className="mt-1 space-y-1">
              {q.columns.map((c) => {
                const selected = map[row.id] === c.value;
                return (
                  <label
                    key={c.value}
                    className={`flex h-10 items-center gap-2 rounded-md border px-3 text-sm ${
                      selected
                        ? 'border-accent bg-accent/5'
                        : 'border-border bg-surface-1'
                    }`}
                  >
                    <input
                      type="radio"
                      name={`${q.id}__${row.id}`}
                      value={c.value}
                      checked={selected}
                      disabled={readOnly}
                      onChange={() => set(row.id, c.value)}
                    />
                    <span>{c.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}

function MatrixSingleRow({
  row,
  columns,
  selected,
  odd,
  readOnly,
  onChange,
}: {
  row: { id: string; label: string };
  columns: { value: string; label: string }[];
  selected: string | null;
  odd: boolean;
  readOnly: boolean;
  onChange: (col: string) => void;
}) {
  return (
    <>
      <div
        className={`px-2 py-2 text-sm text-ink-1 ${odd ? 'bg-surface-2/40' : ''}`}
      >
        {row.label}
      </div>
      {columns.map((c) => (
        <div
          key={c.value}
          className={`flex items-center justify-center py-2 ${odd ? 'bg-surface-2/40' : ''}`}
        >
          <input
            type="radio"
            name={`__matrix_${row.id}`}
            value={c.value}
            checked={selected === c.value}
            disabled={readOnly}
            onChange={() => onChange(c.value)}
            aria-label={c.label}
          />
        </div>
      ))}
    </>
  );
}

/**
 * Matrix (multi choice per row). Same layout as MatrixSingleInput
 * but each cell is a checkbox and the per-row response is an array.
 */
function MatrixMultiInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'matrix-multi' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const map: Record<string, string[]> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string[]>)
      : {};

  function toggle(rowId: string, col: string) {
    const raw = map[rowId];
    const arr: string[] = Array.isArray(raw) ? raw : [];
    const next = arr.includes(col)
      ? arr.filter((v) => v !== col)
      : [...arr, col];
    const out = { ...map };
    if (next.length === 0) delete out[rowId];
    else out[rowId] = next;
    onChange(out);
  }

  return (
    <div>
      {/* Desktop: grid */}
      <div className="hidden sm:block">
        <div
          className="grid items-center gap-x-2 gap-y-1 overflow-x-auto rounded-md border border-border bg-surface-1 p-2 text-sm"
          style={{
            gridTemplateColumns: `minmax(8rem, 1.4fr) repeat(${q.columns.length}, minmax(5rem, 1fr))`,
          }}
        >
          <div />
          {q.columns.map((c) => (
            <div
              key={c.value}
              className="px-1 text-center text-[11px] font-medium text-muted"
            >
              {c.label}
            </div>
          ))}
          {q.rows.map((row, idx) => {
            const odd = idx % 2 === 1;
            const raw = map[row.id];
            const arr: string[] = Array.isArray(raw) ? raw : [];
            return (
              <Fragment key={row.id}>
                <div
                  className={`px-2 py-2 text-sm text-ink-1 ${odd ? 'bg-surface-2/40' : ''}`}
                >
                  {row.label}
                </div>
                {q.columns.map((c) => (
                  <div
                    key={c.value}
                    className={`flex items-center justify-center py-2 ${odd ? 'bg-surface-2/40' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={arr.includes(c.value)}
                      disabled={readOnly}
                      onChange={() => toggle(row.id, c.value)}
                      aria-label={`${row.label}: ${c.label}`}
                    />
                  </div>
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* Mobile: stacked rows */}
      <div className="space-y-3 sm:hidden">
        {q.rows.map((row) => {
          const raw = map[row.id];
          const arr: string[] = Array.isArray(raw) ? raw : [];
          return (
            <fieldset
              key={row.id}
              className="rounded-md border border-border bg-surface-1 p-2"
            >
              <legend className="px-1 text-sm font-medium text-ink-1">
                {row.label}
              </legend>
              <div className="mt-1 space-y-1">
                {q.columns.map((c) => {
                  const checked = arr.includes(c.value);
                  return (
                    <label
                      key={c.value}
                      className={`flex h-10 items-center gap-2 rounded-md border px-3 text-sm ${
                        checked
                          ? 'border-accent bg-accent/5'
                          : 'border-border bg-surface-1'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={readOnly}
                        onChange={() => toggle(row.id, c.value)}
                      />
                      <span>{c.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Matrix dropdown: each cell is a per-column dropdown. Renders as a
 * grid on desktop and as one fieldset per row on mobile.
 */
function MatrixDropdownInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'matrix-dropdown' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const map: Record<string, Record<string, string>> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, Record<string, string>>)
      : {};

  function setCell(rowId: string, colValue: string, choice: string | null) {
    const rowMap: Record<string, string> = { ...(map[rowId] ?? {}) };
    if (choice === null || choice === '') delete rowMap[colValue];
    else rowMap[colValue] = choice;
    const out = { ...map };
    if (Object.keys(rowMap).length === 0) delete out[rowId];
    else out[rowId] = rowMap;
    onChange(out);
  }

  return (
    <div>
      <div className="hidden sm:block">
        <div
          className="grid items-center gap-x-2 gap-y-1 overflow-x-auto rounded-md border border-border bg-surface-1 p-2 text-sm"
          style={{
            gridTemplateColumns: `minmax(8rem, 1.4fr) repeat(${q.columns.length}, minmax(7rem, 1fr))`,
          }}
        >
          <div />
          {q.columns.map((c) => (
            <div
              key={c.value}
              className="px-1 text-center text-[11px] font-medium text-muted"
            >
              {c.label}
            </div>
          ))}
          {q.rows.map((row, idx) => {
            const odd = idx % 2 === 1;
            const rowMap = map[row.id] ?? {};
            return (
              <Fragment key={row.id}>
                <div
                  className={`px-2 py-2 text-sm text-ink-1 ${odd ? 'bg-surface-2/40' : ''}`}
                >
                  {row.label}
                </div>
                {q.columns.map((c) => (
                  <div
                    key={c.value}
                    className={`px-1 py-1 ${odd ? 'bg-surface-2/40' : ''}`}
                  >
                    <select
                      value={rowMap[c.value] ?? ''}
                      disabled={readOnly}
                      onChange={(e) =>
                        setCell(row.id, c.value, e.target.value || null)
                      }
                      className="block h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs"
                    >
                      <option value="">--</option>
                      {c.choices.map((ch) => (
                        <option key={ch.value} value={ch.value}>
                          {ch.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>

      <div className="space-y-3 sm:hidden">
        {q.rows.map((row) => {
          const rowMap = map[row.id] ?? {};
          return (
            <fieldset
              key={row.id}
              className="rounded-md border border-border bg-surface-1 p-2"
            >
              <legend className="px-1 text-sm font-medium text-ink-1">
                {row.label}
              </legend>
              <div className="mt-1 space-y-2">
                {q.columns.map((c) => (
                  <label key={c.value} className="block text-xs">
                    <span className="mb-0.5 block text-muted">{c.label}</span>
                    <select
                      value={rowMap[c.value] ?? ''}
                      disabled={readOnly}
                      onChange={(e) =>
                        setCell(row.id, c.value, e.target.value || null)
                      }
                      className="block h-10 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
                    >
                      <option value="">--</option>
                      {c.choices.map((ch) => (
                        <option key={ch.value} value={ch.value}>
                          {ch.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Matrix rating: each row gets the same rating widget. Useful for
 * scoring a list of items on a shared scale.
 */
function MatrixRatingInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'matrix-rating' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const map: Record<string, number> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, number>)
      : {};
  const max = q.max ?? 5;
  const icon =
    q.shape === 'heart' ? '♥' : q.shape === 'thumb' ? '\u{1F44D}' : '★';

  function set(rowId: string, n: number) {
    const out = { ...map };
    out[rowId] = n;
    onChange(out);
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
      {q.rows.map((row, idx) => {
        const cur = map[row.id] ?? 0;
        const odd = idx % 2 === 1;
        return (
          <div
            key={row.id}
            className={`flex flex-col items-start justify-between gap-1 rounded-sm px-2 py-2 sm:flex-row sm:items-center ${odd ? 'bg-surface-2/40' : ''}`}
          >
            <span className="text-sm text-ink-1">{row.label}</span>
            <div className="flex gap-1">
              {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
                <button
                  type="button"
                  key={n}
                  disabled={readOnly}
                  onClick={() => set(row.id, n)}
                  className={`h-9 w-9 rounded-md border text-base ${
                    n <= cur
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border bg-surface-1'
                  }`}
                  aria-label={`${row.label}: ${n} of ${max}`}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Ranking: drag-to-reorder on desktop with a fallback up / down
 * arrow per item. Mobile users tap the arrows; the grip is a hint
 * but not strictly required. Choices not yet ranked appear in a
 * second list and can be promoted into the ordered set.
 */
function RankingInput({
  q,
  value,
  readOnly,
  onChange,
}: {
  q: Extract<Question, { type: 'ranking' }>;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const ranked: string[] = Array.isArray(value)
    ? (value as string[]).filter(
        (v): v is string =>
          typeof v === 'string' && q.choices.some((c) => c.value === v),
      )
    : [];
  const rankedSet = new Set(ranked);
  const unranked = q.choices.filter((c) => !rankedSet.has(c.value));

  function rank(value: string) {
    if (rankedSet.has(value)) return;
    const max = q.maxRanked ?? q.choices.length;
    if (ranked.length >= max) return;
    onChange([...ranked, value]);
  }

  function unrank(value: string) {
    onChange(ranked.filter((v) => v !== value));
  }

  function onDragStart(e: React.DragEvent<HTMLLIElement>, idx: number) {
    if (readOnly) return;
    e.dataTransfer.setData('text/x-rank-index', String(idx));
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDrop(e: React.DragEvent<HTMLLIElement>, dropIdx: number) {
    if (readOnly) return;
    const raw = e.dataTransfer.getData('text/x-rank-index');
    if (!raw) return;
    const fromIdx = Number(raw);
    if (Number.isNaN(fromIdx) || fromIdx === dropIdx) return;
    const next = ranked.slice();
    const [moved] = next.splice(fromIdx, 1);
    if (moved === undefined) return;
    const insertAt = dropIdx > fromIdx ? dropIdx - 1 : dropIdx;
    next.splice(insertAt, 0, moved);
    onChange(next);
    e.preventDefault();
  }

  function labelFor(v: string): string {
    return q.choices.find((c) => c.value === v)?.label ?? v;
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-surface-1 p-2">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Ranked
        </p>
        {ranked.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted">
            No items ranked yet. Tap an item below to add it.
          </p>
        ) : (
          <ol className="space-y-1">
            {ranked.map((v, i) => (
              <li
                key={v}
                draggable={!readOnly}
                onDragStart={(e) => onDragStart(e, i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDrop(e, i)}
                className={`flex items-center gap-2 rounded-md border border-border bg-surface-2/30 px-2 py-1.5 text-sm ${
                  readOnly ? '' : 'cursor-grab active:cursor-grabbing'
                }`}
              >
                {!readOnly ? (
                  <GripVertical
                    className="h-3.5 w-3.5 shrink-0 text-muted"
                    aria-hidden="true"
                  />
                ) : null}
                <span className="w-5 text-xs tabular-nums text-muted">{i + 1}.</span>
                <span className="flex-1 truncate">{labelFor(v)}</span>
                {!readOnly ? (
                  <button
                    type="button"
                    onClick={() => unrank(v)}
                    className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                    aria-label="Remove from ranking"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
      {unranked.length > 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface-2/30 p-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            Available
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unranked.map((c) => (
              <button
                type="button"
                key={c.value}
                disabled={readOnly}
                onClick={() => rank(c.value)}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs hover:bg-surface-2"
              >
                <Plus className="h-3 w-3 text-muted" />
                {c.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---- helpers ----------------------------------------------------

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface Page {
  pageQuestion: Question | null;
  questions: Question[];
}

function splitIntoPages(form: FormSchema): Page[] {
  const pages: Page[] = [];
  let current: Page = { pageQuestion: null, questions: [] };
  for (const q of form.questions) {
    if (q.type === 'page') {
      if (current.questions.length > 0) pages.push(current);
      current = { pageQuestion: q, questions: [] };
    } else {
      current.questions.push(q);
    }
  }
  pages.push(current);
  return pages;
}

function collectIdsOnPage(page: Page): Set<string> {
  const ids = new Set<string>();
  function walk(q: Question) {
    ids.add(q.id);
    if (q.type === 'group') q.children.forEach(walk);
  }
  page.questions.forEach(walk);
  return ids;
}

function isReadOnly(q: Question, response: Response): boolean {
  // A calculated question -- whether the dedicated `calculated`
  // type or a QuestionBase with the optional `calculate` field
  // (#164) -- is always read-only. The respondent isn't meant to
  // override a derived value, and applyCalculations would just
  // overwrite their edit on the next render anyway.
  if (q.type === 'calculated' || q.calculate) return true;
  if (q.readOnly === undefined || q.readOnly === false) return false;
  if (q.readOnly === true) return true;
  return Boolean(evaluate(q.readOnly as Expression, response));
}

/**
 * Pack a list of questions into visual rows based on their declared
 * widths. A question with `full` (or unspecified) width starts a new
 * row by itself. Otherwise sequential questions are accumulated until
 * their summed widths exceed 1, then the row breaks.
 *
 * Only genuinely structural types are forced standalone (page break,
 * group, note, divider, hidden, image-display). Everything else --
 * including the wide ones like matrix and ranking -- respects the
 * author's `layout.width`. If the author sets a matrix to 1/2 they
 * accept the cramped or scrolling consequence; that's an explicit
 * choice we shouldn't second-guess.
 */
export function packIntoRows(qs: Question[]): Question[][] {
  const rows: Question[][] = [];
  let current: Question[] = [];
  let used = 0;
  function flush() {
    if (current.length > 0) rows.push(current);
    current = [];
    used = 0;
  }
  for (const q of qs) {
    const isStandalone =
      q.type === 'page' ||
      q.type === 'group' ||
      q.type === 'note' ||
      q.type === 'divider' ||
      q.type === 'hidden' ||
      q.type === 'image-display';
    const w = widthFraction(q.layout?.width);
    if (isStandalone || w === 1) {
      flush();
      rows.push([q]);
      continue;
    }
    if (used + w > 1) flush();
    current.push(q);
    used += w;
  }
  flush();
  return rows;
}

function widthFraction(width: string | undefined): number {
  switch (width) {
    case 'half':
      return 1 / 2;
    case 'third':
      return 1 / 3;
    case 'two-thirds':
      return 2 / 3;
    case 'quarter':
      return 1 / 4;
    case 'three-quarters':
      return 3 / 4;
    case 'full':
    default:
      return 1;
  }
}

export function widthToClass(width: string | undefined): string {
  // Tailwind: mobile collapses to w-full; sm: applies the fractional
  // basis. We use `basis-` so flexbox does the wrapping inside the
  // `flex-wrap` parent.
  switch (width) {
    case 'half':
      return 'w-full sm:basis-[calc(50%-0.5rem)]';
    case 'third':
      return 'w-full sm:basis-[calc(33.333%-0.667rem)]';
    case 'two-thirds':
      return 'w-full sm:basis-[calc(66.666%-0.333rem)]';
    case 'quarter':
      return 'w-full sm:basis-[calc(25%-0.75rem)]';
    case 'three-quarters':
      return 'w-full sm:basis-[calc(75%-0.25rem)]';
    case 'full':
    default:
      return 'w-full';
  }
}

// Re-export for designer / runtime consumers.
export { walkQuestions };
