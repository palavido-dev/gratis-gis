// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { FeatureField, PickListData } from '@gratis-gis/shared-types';

interface Props {
  /** Layer schema. Non-system fields drive the form inputs. */
  fields: FeatureField[];
  /**
   * Subset of `fields` the parent permits the user to fill at this
   * stage. Driven by the Editor target's `editableFields` setting.
   * Pass `null` to mean "all fields editable" (the typical "Add new
   * feature, fill anything" path). For Edit (slice 3b-3) this gets
   * narrowed to just the columns the share allows.
   */
  editableFieldNames: ReadonlySet<string> | null;
  /**
   * Resolved pick lists, indexed by item id, used for fields whose
   * `domain` is a `coded-value-ref`. The runtime fetches these
   * server-side and passes them in so the form renders a real
   * <select> with each pick list's entries instead of a raw text
   * input. Optional: a missing entry falls back to a text input
   * with a warning, so a stale reference never breaks the form.
   */
  pickLists?: Record<string, PickListData>;
  /** Initial values keyed by field name. Empty for Add; pre-filled
   *  for Edit. */
  initial?: Record<string, unknown>;
  /** Layer label shown in the form header so the user always knows
   *  what they're editing. */
  layerTitle: string;
  submitting?: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
  /**
   * Action label. "Save" for create, "Update" for edit (slice 3b-3).
   * Defaults to "Save".
   */
  submitLabel?: string;
  /**
   * Heading shown above the layer subtitle. Defaults to "New
   * feature attributes" for the create flow; the edit flow passes
   * "Edit feature attributes" so the user is never confused about
   * which action they're confirming.
   */
  title?: string;
  /**
   * Optional extra footer content rendered to the LEFT of the
   * Cancel button. The edit flow passes a Delete button here so the
   * destructive action lives on the same surface as the attribute
   * edits without being mistakable for the primary submit.
   */
  extraFooter?: React.ReactNode;
}

/**
 * Inline form generated from a layer's FeatureField list. Renders
 * as a flex column meant to fill the editor pane container; the
 * editor pane supplies the surrounding chrome (right-dock,
 * absolute positioning, X-to-close).
 *
 * Rules:
 *   - Editable columns get an input of the right type. text -> text,
 *     number -> number, boolean -> checkbox, date -> date input.
 *   - Non-editable columns (not in `editableFieldNames`) are
 *     surfaced read-only at the bottom so the author can see what's
 *     there but cannot change it. For Add this is rare; for Edit
 *     it is the common "see all the data, edit only what you can"
 *     UX.
 *   - `nullable: false` is treated as required. We block submit
 *     until every required field has a value.
 *   - System metadata fields (created_by, edited_at, etc.) are not
 *     part of the user-facing schema and never appear here. They
 *     are stamped server-side.
 */
export function AttributeForm({
  fields,
  editableFieldNames,
  pickLists,
  initial = {},
  layerTitle,
  submitting,
  errorMessage,
  onCancel,
  onSubmit,
  submitLabel = 'Save',
  title = 'New feature attributes',
  extraFooter,
}: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const seed: Record<string, unknown> = {};
    for (const f of fields) {
      seed[f.name] = initial[f.name] ?? defaultFor(f);
    }
    return seed;
  });

  function set(name: string, value: unknown) {
    setValues((cur) => ({ ...cur, [name]: value }));
  }

  // Required validation. Required = !nullable AND we expect the
  // user to fill it (i.e. it's editable). A required non-editable
  // field would already need to have come from a prior write, so
  // we don't block on it.
  const missing: string[] = [];
  for (const f of fields) {
    const editable =
      editableFieldNames === null || editableFieldNames.has(f.name);
    if (!editable) continue;
    if (f.nullable) continue;
    const v = values[f.name];
    if (v === null || v === undefined || v === '') {
      missing.push(f.label || f.name);
    }
  }
  const canSubmit = missing.length === 0 && !submitting;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-0">{title}</h2>
          <p className="truncate text-xs text-muted">{layerTitle}</p>
        </div>
        <button
          type="button"
          disabled={submitting}
          onClick={onCancel}
          className="shrink-0 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink-0 disabled:opacity-50"
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-auto px-3 py-3">
        {fields.length === 0 ? (
          <p className="text-sm text-muted">
            This layer has no editable fields. Save to drop a feature with
            just geometry and system metadata.
          </p>
        ) : null}
        {fields.map((f) => {
          const editable =
            editableFieldNames === null ||
            editableFieldNames.has(f.name);
          return (
            <FieldRow
              key={f.name}
              field={f}
              value={values[f.name]}
              editable={editable}
              pickLists={pickLists}
              onChange={(v) => set(f.name, v)}
            />
          );
        })}
        {missing.length > 0 && !submitting ? (
          <p className="text-xs text-warn">
            Required: {missing.join(', ')}
          </p>
        ) : null}
        {errorMessage ? (
          <p className="text-sm text-danger" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
        {extraFooter ? (
          <div className="mr-auto flex items-center gap-2">{extraFooter}</div>
        ) : null}
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSubmit(values)}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

interface FieldRowProps {
  field: FeatureField;
  value: unknown;
  editable: boolean;
  pickLists?: Record<string, PickListData> | undefined;
  onChange: (next: unknown) => void;
}

function FieldRow({
  field,
  value,
  editable,
  pickLists,
  onChange,
}: FieldRowProps) {
  const label = field.label || field.name;
  const required = !field.nullable && editable;

  // Read-only rows show the current value as plain text. We keep
  // them in the form because hiding non-editable fields entirely
  // would make the user feel like they're missing context.
  if (!editable) {
    return (
      <div className="text-xs">
        <div className="text-muted">
          {label}
          <span className="ml-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs uppercase tracking-wide">
            read-only
          </span>
        </div>
        <div className="mt-0.5 text-ink-1">
          {value === null || value === undefined || value === '' ? (
            <span className="text-muted">(empty)</span>
          ) : (
            String(value)
          )}
        </div>
      </div>
    );
  }

  // multi_select renders as a checkbox group with each option drawn
  // from the field's domain. The wire shape is an array of codes;
  // we accept null/undefined/array on read and always emit an array
  // on write (empty array when nothing is checked, never null, so
  // downstream code can treat the field as homogeneous). A legacy
  // CSV string ("a,b,c") gets parsed into ["a","b","c"] for display
  // -- this lets users edit data imported from AGO without first
  // having to re-shape it.
  if (field.type === 'multi_select') {
    let mOptions: Array<{ code: string | number; label: string }> = [];
    let mUnresolvedRef = false;
    if (field.domain?.type === 'coded-value') {
      mOptions = field.domain.values;
    } else if (field.domain?.type === 'coded-value-ref') {
      const list = pickLists?.[field.domain.pickListItemId];
      if (list) {
        mOptions = list.entries.map((e) => ({ code: e.code, label: e.label }));
      } else {
        mUnresolvedRef = true;
      }
    }
    // Normalize the current value to a Set<string> of selected codes.
    const selected = new Set<string>(coerceArrayCodes(value));
    if (mOptions.length > 0) {
      return (
        <fieldset className="block text-xs">
          <legend className="text-ink-1">
            {label}
            {required ? <span className="ml-1 text-danger">*</span> : null}
          </legend>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-border bg-surface-1 px-2 py-1.5">
            {mOptions.map((o) => {
              const codeStr = String(o.code);
              const checked = selected.has(codeStr);
              return (
                <label
                  key={codeStr}
                  className="inline-flex items-center gap-1.5 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(codeStr);
                      else next.delete(codeStr);
                      // Preserve numeric codes when the inline domain
                      // declared them as numbers; pick-list refs are
                      // always strings.
                      const ordered = mOptions
                        .filter((opt) => next.has(String(opt.code)))
                        .map((opt) =>
                          typeof opt.code === 'number' ? opt.code : String(opt.code),
                        );
                      onChange(ordered);
                    }}
                    className="h-3.5 w-3.5 rounded border-border"
                  />
                  <span>
                    {o.label}{' '}
                    <span className="text-muted">({o.code})</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      );
    }
    if (mUnresolvedRef) {
      return (
        <label className="block text-xs">
          <span className="text-ink-1">
            {label}
            {required ? <span className="ml-1 text-danger">*</span> : null}
          </span>
          <input
            type="text"
            value={
              Array.isArray(value)
                ? value.map((v) => String(v)).join(', ')
                : value === null || value === undefined
                  ? ''
                  : String(value)
            }
            onChange={(e) => {
              // Comma-split fallback -- the pick list is unresolved
              // so we can't validate codes. Keep what the user types.
              const parts = e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              onChange(parts);
            }}
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-0.5 text-2xs text-warn">
            This multi-select references a pick list that could not be
            loaded. Edit as comma-separated codes; validation is not
            enforced here.
          </p>
        </label>
      );
    }
    // multi_select with no domain at all -- shouldn't happen in
    // practice (the wizard requires one) but render a disabled
    // notice rather than a useless empty fieldset.
    return (
      <label className="block text-xs">
        <span className="text-ink-1">
          {label}
          {required ? <span className="ml-1 text-danger">*</span> : null}
        </span>
        <p className="mt-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-2xs text-warn">
          This multi-select field has no choices configured. Edit the
          layer schema to add a pick list.
        </p>
      </label>
    );
  }

  // Domain-backed fields render as a <select>. coded-value carries
  // the value list inline; coded-value-ref points at a pick_list
  // item that the runtime resolved server-side and passed in via
  // the pickLists map. Numeric range domains aren't yet UI-rendered;
  // they fall through to the plain numeric input below.
  if (field.domain && (field.domain.type === 'coded-value' || field.domain.type === 'coded-value-ref')) {
    let options: Array<{ code: string | number; label: string }> = [];
    let unresolvedRef = false;
    if (field.domain.type === 'coded-value') {
      options = field.domain.values;
    } else {
      const list = pickLists?.[field.domain.pickListItemId];
      if (list) {
        options = list.entries.map((e) => ({ code: e.code, label: e.label }));
      } else {
        unresolvedRef = true;
      }
    }
    if (options.length > 0) {
      const stringValue =
        value === null || value === undefined ? '' : String(value);
      return (
        <label className="block text-xs">
          <span className="text-ink-1">
            {label}
            {required ? <span className="ml-1 text-danger">*</span> : null}
          </span>
          <select
            value={stringValue}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') {
                onChange(null);
                return;
              }
              // Preserve original code type: if the inline domain
              // declared numeric codes, coerce back to number on
              // submit. Pick-list entries always use string codes.
              const matched = options.find((o) => String(o.code) === raw);
              onChange(
                matched && typeof matched.code === 'number' ? matched.code : raw,
              );
            }}
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            <option value="">
              {field.nullable ? '(none)' : 'Select a value...'}
            </option>
            {options.map((o) => (
              <option key={String(o.code)} value={String(o.code)}>
                {o.label} ({o.code})
              </option>
            ))}
          </select>
        </label>
      );
    }
    // Pick list reference resolved to nothing (item missing or not
    // visible). Fall through to a plain text input but warn so the
    // user knows the domain isn't being enforced.
    if (unresolvedRef) {
      return (
        <label className="block text-xs">
          <span className="text-ink-1">
            {label}
            {required ? <span className="ml-1 text-danger">*</span> : null}
          </span>
          <input
            type="text"
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value || null)}
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-0.5 text-2xs text-warn">
            This field references a pick list that could not be loaded.
            Validation is not enforced here; double-check the value.
          </p>
        </label>
      );
    }
  }

  // Editable input keyed off the field type. We coerce values here
  // so the parent's submit payload has the right shapes (numbers as
  // numbers, booleans as booleans, dates as ISO strings).
  switch (field.type) {
    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 cursor-pointer"
          />
          <span className="text-ink-1">
            {label}
            {required ? <span className="ml-1 text-danger">*</span> : null}
          </span>
        </label>
      );
    case 'number':
      return (
        <label className="block text-xs">
          <span className="text-ink-1">
            {label}
            {required ? <span className="ml-1 text-danger">*</span> : null}
          </span>
          <input
            type="number"
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(e) => {
              const v = e.target.value;
              onChange(v === '' ? null : Number(v));
            }}
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
      );
    case 'date':
      return (
        <label className="block text-xs">
          <span className="text-ink-1">
            {label}
            {required ? <span className="ml-1 text-danger">*</span> : null}
          </span>
          <input
            type="date"
            value={
              value === null || value === undefined
                ? ''
                : String(value).slice(0, 10)
            }
            onChange={(e) => onChange(e.target.value || null)}
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
      );
    case 'string':
    default:
      return (
        <label className="block text-xs">
          <span className="text-ink-1">
            {label}
            {required ? <span className="ml-1 text-danger">*</span> : null}
          </span>
          <input
            type="text"
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value || null)}
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
      );
  }
}

function defaultFor(f: FeatureField): unknown {
  switch (f.type) {
    case 'boolean':
      return false;
    case 'multi_select':
      // Empty array is the right "nothing selected" representation.
      // Keeps downstream code from having to special-case null.
      return [];
    case 'number':
    case 'string':
    case 'date':
    default:
      return null;
  }
}

/**
 * Coerce a stored multi_select value into an array of code strings
 * for the checkbox renderer. Accepts:
 *   - null / undefined -> []
 *   - array of strings/numbers -> stringified codes (preserves order)
 *   - legacy comma-separated string ("a, b, c") -> split + trim
 *   - any other scalar (number, etc.) -> single-element array
 *
 * The legacy-CSV branch lets a user open a feature whose multi_select
 * data was imported from AGO before the schema flipped to native
 * arrays, edit it, and have the next save land as a real array. No
 * separate migration pass needed.
 */
function coerceArrayCodes(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) {
    return v
      .filter((x) => x !== null && x !== undefined)
      .map((x) => String(x));
  }
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [String(v)];
}
