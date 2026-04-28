'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  applyCalculations,
  evaluate,
  isRequired,
  isVisible,
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
        {/* Sequential questions are packed into rows by their declared
            width so authors can place "first name | last name" or a
            three-up grid on a single line. Mobile collapses everything
            to full-width below 640px (sm: breakpoint) so phone users
            never operate cramped half-width inputs. */}
        {packIntoRows(currentPage.questions).map((row, rowIdx) => (
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
                  error={errorByQuestion.get(q.id) ?? null}
                  readOnly={readOnly || isReadOnly(q, response)}
                  onChange={(v) => setValue(q.id, v)}
                />
              </div>
            ))}
          </div>
        ))}

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
  if (q.type === 'note') {
    return (
      <div className="rounded-md border border-border bg-surface-2/40 px-3 py-2 text-sm text-ink-1">
        {q.label}
      </div>
    );
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
        <div className="space-y-4">
          {q.children.map((child) => (
            <QuestionField
              key={child.id}
              q={child}
              response={response}
              error={null}
              readOnly={readOnly}
              onChange={(v) => {
                const fakeOnChange = (val: unknown) =>
                  onChange({ ...(response[q.id] as object | undefined), [child.id]: val });
                fakeOnChange(v);
              }}
            />
          ))}
        </div>
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
            <div className="space-y-3">
              {q.children.map((child) => (
                <QuestionField
                  key={child.id}
                  q={child}
                  response={inst}
                  error={null}
                  readOnly={readOnly}
                  onChange={(v) => {
                    const next = instances.slice();
                    next[idx] = { ...inst, [child.id]: v };
                    onChange(next);
                  }}
                />
              ))}
            </div>
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
    case 'number':
      return (
        <input
          id={q.id}
          type="number"
          inputMode="decimal"
          value={value === null || value === undefined ? '' : (value as number | string)}
          step={q.step}
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
    case 'photo':
      return <PhotoInput q={q} value={value} readOnly={readOnly} onChange={onChange} />;
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
            ? '—'
            : String(value)}
        </div>
      );
    case 'note':
    case 'page':
    case 'group':
      return null;
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
  if (q.readOnly === undefined || q.readOnly === false) return false;
  if (q.readOnly === true) return true;
  return Boolean(evaluate(q.readOnly as Expression, response));
}

/**
 * Pack a list of questions into visual rows based on their declared
 * widths. A `full` (or unspecified) width starts a new row by itself.
 * Otherwise sequential questions are accumulated until their summed
 * widths exceed 1, then the row breaks. Note rows are flat -- no
 * recursive nesting -- so a row never contains a group; groups are
 * always on their own row at full width.
 */
function packIntoRows(qs: Question[]): Question[][] {
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
      q.type === 'page' || q.type === 'group' || q.type === 'note';
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

function widthToClass(width: string | undefined): string {
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
