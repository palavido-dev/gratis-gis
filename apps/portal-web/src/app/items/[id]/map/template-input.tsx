// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Shared {{field}}-template input with variable picker + formatter
 * picker + optional live preview (#65).
 *
 * Drop-in for any place that authors hand-write a Handlebars-lite
 * template against a known field schema (popup title, popup body,
 * search Result label, future legend label templates, etc). The
 * goals are:
 *
 *   - No hand-coding field names from memory. Each candidate field
 *     renders as a click-to-insert chip; clicking inserts
 *     `{{field}}` at the caret.
 *   - Discoverable formatter grammar. A dropdown lists the
 *     supported pipes (`upper`, `lower`, `number`, `currency:USD`,
 *     `date:short`, `date:medium`).
 *   - Live preview against a sample feature when one is available,
 *     so the author can see what runtime will produce.
 *
 * The renderer below mirrors the canvas's runtime renderer in
 * `popup-editor.tsx` (kept dependency-free; not re-exported because
 * the two consumers diverge on HTML escaping).
 */
import { useMemo, useRef } from 'react';

interface ExtraInsert {
  /** Button label, e.g. "+line break". */
  label: string;
  /** Raw string inserted at the caret. */
  insert: string;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Candidate fields. Each renders as a click-to-insert chip. */
  fields: string[];
  /** Sample feature properties for the live preview. Omit to hide. */
  sampleProperties?: Record<string, unknown> | null;
  placeholder?: string;
  /** Render as textarea instead of single-line input. */
  multiline?: boolean;
  /** Rows for textarea mode. Default 4. */
  rows?: number;
  /** Show the formatter pipe picker. Default true. */
  showFormatters?: boolean;
  /**
   * Whether the preview is rendered as HTML. Single-line uses are
   * plain text (search labels, popup titles); body templates are
   * HTML and want a dangerouslySetInnerHTML pass. Default false.
   */
  previewAsHtml?: boolean;
  /** Extra "+line break"-style buttons (HTML body templates only). */
  extraInserts?: ExtraInsert[];
  /** Aria label / form-field id. */
  inputId?: string;
}

const FORMATTERS: Array<{ label: string; insert: string }> = [
  { label: '| upper', insert: ' | upper' },
  { label: '| lower', insert: ' | lower' },
  { label: '| number', insert: ' | number' },
  { label: '| currency:USD', insert: ' | currency:USD' },
  { label: '| date:short', insert: ' | date:short' },
  { label: '| date:medium', insert: ' | date:medium' },
];

export function TemplateInput({
  value,
  onChange,
  fields,
  sampleProperties,
  placeholder,
  multiline = false,
  rows = 4,
  showFormatters = true,
  previewAsHtml = false,
  extraInserts,
  inputId,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  function getEl(): HTMLInputElement | HTMLTextAreaElement | null {
    return multiline ? areaRef.current : inputRef.current;
  }

  function insert(text: string): void {
    const el = getEl();
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    // Restore the caret to after the inserted token so the next
    // chip click flows naturally.  Use requestAnimationFrame so the
    // controlled value lands first.
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + text.length;
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        /* Some browsers throw if the element is now hidden; safe to swallow. */
      }
    });
  }

  const preview = useMemo(() => {
    if (!sampleProperties) return null;
    if (!value.trim()) return null;
    return renderTemplate(value, sampleProperties);
  }, [value, sampleProperties]);

  return (
    <div className="space-y-2">
      {fields.length > 0 ? (
        <div>
          <p className="mb-1 text-2xs uppercase tracking-wide text-muted">
            Insert a field
          </p>
          <div className="flex flex-wrap gap-1">
            {fields.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => insert(`{{${f}}}`)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-0.5 font-mono text-2xs text-ink-1 hover:bg-surface-2"
                title={`Insert {{${f}}}`}
              >
                <span className="text-muted">{'{{'}</span>
                {f}
                <span className="text-muted">{'}}'}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-2xs text-muted">
          No field schema loaded yet. Type your template directly, then
          re-open this layer to see field chips once the canvas reports
          the schema.
        </p>
      )}

      {(showFormatters || (extraInserts && extraInserts.length > 0)) && (
        <div className="flex flex-wrap gap-2">
          {showFormatters ? (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) insert(e.target.value);
                e.target.value = '';
              }}
              className="h-7 rounded border border-border bg-surface-1 px-2 text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              <option value="">Insert formatter...</option>
              {FORMATTERS.map((f) => (
                <option key={f.label} value={f.insert}>
                  {f.label}
                </option>
              ))}
            </select>
          ) : null}
          {extraInserts?.map((x) => (
            <button
              key={x.label}
              type="button"
              onClick={() => insert(x.insert)}
              className="h-7 rounded border border-border bg-surface-1 px-2 text-2xs text-ink-1 hover:bg-surface-2"
            >
              {x.label}
            </button>
          ))}
        </div>
      )}

      {multiline ? (
        <textarea
          ref={areaRef}
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          className="w-full rounded border border-border bg-surface-0 px-2 py-1.5 font-mono text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
      ) : (
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-8 w-full rounded border border-border bg-surface-1 px-2 font-mono text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
      )}

      {preview !== null ? (
        <div>
          <p className="mb-1 text-2xs uppercase tracking-wide text-muted">
            Preview
          </p>
          {previewAsHtml ? (
            <div
              className="gg-popup rounded border border-dashed border-border bg-surface-1 p-2 text-xs"
              /* eslint-disable-next-line react/no-danger */
              dangerouslySetInnerHTML={{ __html: preview }}
            />
          ) : (
            <p className="truncate rounded border border-dashed border-border bg-surface-1 p-2 text-xs text-ink-1">
              {preview || (
                <span className="italic text-muted">(empty)</span>
              )}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Render a {{field}} template against sample properties.  Mirrors
 * the canvas runtime renderer in popup-editor.tsx and the
 * lighter search-sources renderTemplate.  Kept private so we can
 * evolve the grammar in one place over time.
 *
 * When `previewAsHtml` is true on the caller, the caller is
 * responsible for any extra HTML it injects around the template
 * (e.g. <br>); the renderer escapes field values either way.
 */
function renderTemplate(
  template: string,
  props: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*([\w.-]+)\s*(?:\|\s*([\w.-]+)(?:\s*:\s*([^}]+))?\s*)?\}\}/g,
    (_, key: string, formatter?: string, arg?: string) => {
      const raw = props[key];
      if (raw === undefined || raw === null) return '';
      const str = String(raw);
      const fmt = formatter?.toLowerCase();
      let out = str;
      if (fmt === 'upper') out = str.toUpperCase();
      else if (fmt === 'lower') out = str.toLowerCase();
      else if (fmt === 'number') {
        const n = Number(str);
        if (!Number.isNaN(n)) out = n.toLocaleString();
      } else if (fmt === 'currency') {
        const n = Number(str);
        if (!Number.isNaN(n)) {
          try {
            out = n.toLocaleString(undefined, {
              style: 'currency',
              currency: arg?.trim() || 'USD',
            });
          } catch {
            out = n.toLocaleString();
          }
        }
      } else if (fmt === 'date') {
        const d = new Date(str);
        if (!Number.isNaN(d.getTime())) {
          const style =
            (arg?.trim() as 'short' | 'long' | 'full' | undefined) ??
            'medium';
          try {
            out = d.toLocaleDateString(undefined, { dateStyle: style });
          } catch {
            out = d.toLocaleDateString();
          }
        }
      }
      return escapeHtml(out);
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
