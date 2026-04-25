'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  FileSpreadsheet,
  FileUp,
  Loader2,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import type {
  PickListData,
  PickListEntry,
} from '@gratis-gis/shared-types';
import { DEFAULT_PICK_LIST } from '@gratis-gis/shared-types';

/**
 * Detail-page editor for a `pick_list` item.
 *
 * Features:
 *  - Manual add / edit / reorder / delete of entries
 *  - CSV upload (headers: code,label,description)
 *  - Excel .xlsx upload (first sheet, first row = headers)
 *  - Paste-from-clipboard (tab- or comma-delimited)
 *  - Duplicate-code policy toggle (merge vs reject)
 *  - Optional author-only note
 *
 * Persistence: the whole PickListData blob is PATCHed to the item.
 * The server stores it opaquely; referenced domains resolve at
 * read time (see feature-service field domain of type
 * `coded-value-ref`).
 */
interface Props {
  itemId: string;
  initial: PickListData;
  canEdit: boolean;
}

type DupePolicy = 'reject' | 'replace';

export function PickListEditor({ itemId, initial, canEdit }: Props) {
  const router = useRouter();
  const [data, setData] = useState<PickListData>(() => ({
    ...DEFAULT_PICK_LIST,
    ...initial,
    entries: Array.isArray(initial?.entries) ? initial.entries.slice() : [],
    version: 3,
  }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importInfo, setImportInfo] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [dupePolicy, setDupePolicy] = useState<DupePolicy>('replace');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Reference-equality dirty check. The setters below always create a
  // new object, so `data !== initial` is sufficient once the user has
  // made any change at all.
  const dirty = data !== initial;

  function updateEntries(next: PickListEntry[]) {
    setData((prev) => ({ ...prev, entries: next }));
  }

  function addBlankRow() {
    updateEntries([...data.entries, { code: '', label: '' }]);
  }

  function updateRow(i: number, patch: Partial<PickListEntry>) {
    const next = data.entries.slice();
    next[i] = { ...next[i]!, ...patch };
    updateEntries(next);
  }

  function removeRow(i: number) {
    const next = data.entries.slice();
    next.splice(i, 1);
    updateEntries(next);
  }

  function moveRow(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= data.entries.length) return;
    const next = data.entries.slice();
    const tmp = next[i]!;
    next[i] = next[j]!;
    next[j] = tmp;
    updateEntries(next);
  }

  // --- Import paths ---------------------------------------------------

  /**
   * Merge a batch of parsed entries into the current list per the
   * configured duplicate-code policy. Returns a user-facing summary
   * for the toast surface.
   */
  function applyImport(rows: PickListEntry[]): string {
    const existing = new Map(data.entries.map((e) => [e.code, e]));
    let added = 0;
    let replaced = 0;
    let skipped = 0;
    const next = data.entries.slice();
    for (const row of rows) {
      if (!row.code) continue;
      if (existing.has(row.code)) {
        if (dupePolicy === 'replace') {
          const idx = next.findIndex((e) => e.code === row.code);
          if (idx >= 0) next[idx] = { ...next[idx]!, ...row };
          replaced += 1;
        } else {
          skipped += 1;
        }
      } else {
        next.push(row);
        existing.set(row.code, row);
        added += 1;
      }
    }
    updateEntries(next);
    return `Imported ${rows.length} row${rows.length === 1 ? '' : 's'}: ${added} added, ${replaced} replaced, ${skipped} skipped.`;
  }

  async function handleCsvFile(file: File) {
    setError(null);
    setImporting(true);
    try {
      const text = await file.text();
      const rows = parseDelimited(text);
      const parsed = rowsToEntries(rows);
      if (parsed.length === 0) {
        setError('No rows parsed. Expected headers: code, label, description?');
        return;
      }
      setImportInfo(applyImport(parsed));
    } catch (err) {
      setError((err as Error).message || 'CSV import failed');
    } finally {
      setImporting(false);
    }
  }

  async function handleXlsxFile(file: File) {
    setError(null);
    setImporting(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const firstSheet = wb.SheetNames[0];
      if (!firstSheet) {
        setError('The .xlsx has no sheets.');
        return;
      }
      const sheet = wb.Sheets[firstSheet]!;
      // header:1 returns a raw array-of-arrays; we do our own header
      // resolution so both CSV and XLSX paths share the same parser.
      const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
        header: 1,
        blankrows: false,
        defval: '',
      });
      const parsed = rowsToEntries(matrix);
      if (parsed.length === 0) {
        setError(
          `No rows parsed from sheet "${firstSheet}". Expected headers: code, label, description?`,
        );
        return;
      }
      setImportInfo(applyImport(parsed));
    } catch (err) {
      setError((err as Error).message || 'Excel import failed');
    } finally {
      setImporting(false);
    }
  }

  async function handleFile(file: File) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      await handleXlsxFile(file);
    } else {
      await handleCsvFile(file);
    }
  }

  function applyPaste() {
    setError(null);
    const text = pasteText.trim();
    if (!text) return;
    try {
      const rows = parseDelimited(text);
      const parsed = rowsToEntries(rows);
      if (parsed.length === 0) {
        setError(
          'No rows parsed. Paste either CSV / TSV with headers (code,label,description) or a plain list of `code,label` rows.',
        );
        return;
      }
      setImportInfo(applyImport(parsed));
      setPasteText('');
      setPasteOpen(false);
    } catch (err) {
      setError((err as Error).message || 'Paste import failed');
    }
  }

  // --- Save -----------------------------------------------------------

  async function save() {
    setError(null);
    // Block saves with empty codes or duplicate codes: the server
    // doesn't enforce this today but domain-reference consumers
    // depend on it.
    const codes = new Set<string>();
    for (const [i, e] of data.entries.entries()) {
      if (!e.code.trim() || !e.label.trim()) {
        setError(`Row ${i + 1} is missing a code or label.`);
        return;
      }
      if (codes.has(e.code.trim())) {
        setError(`Row ${i + 1}: duplicate code "${e.code.trim()}".`);
        return;
      }
      codes.add(e.code.trim());
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: {
            ...data,
            entries: data.entries.map((e) => ({
              code: e.code.trim(),
              label: e.label.trim(),
              ...(e.description?.trim()
                ? { description: e.description.trim() }
                : {}),
            })),
          },
        }),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  // --- Render ---------------------------------------------------------

  return (
    <div className="space-y-4">
      {!canEdit ? (
        <div className="rounded-md border border-border bg-surface-1 p-3 text-xs text-muted">
          Read-only view: you don&apos;t have edit access to this pick list.
        </div>
      ) : null}

      <section className="rounded-lg border border-border bg-surface-1">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold text-ink-0">Entries</h2>
          <span className="text-xs text-muted">
            {data.entries.length} {data.entries.length === 1 ? 'row' : 'rows'}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {canEdit ? (
              <>
                <label
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2"
                  title="Import from CSV or Excel file"
                >
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,.tsv,.txt,.xlsx,.xls"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleFile(f);
                      e.target.value = '';
                    }}
                  />
                  {importing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileUp className="h-3.5 w-3.5" />
                  )}
                  Import file
                </label>
                <button
                  type="button"
                  onClick={() => setPasteOpen((v) => !v)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2"
                  title="Paste rows from clipboard"
                >
                  <ClipboardPaste className="h-3.5 w-3.5" />
                  Paste
                </button>
                <button
                  type="button"
                  onClick={addBlankRow}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add row
                </button>
              </>
            ) : null}
          </div>
        </header>

        {canEdit ? (
          <div className="border-b border-border bg-surface-0 px-3 py-2">
            <label className="flex items-center gap-2 text-[11px] text-muted">
              On duplicate code during import:
              <select
                value={dupePolicy}
                onChange={(e) => setDupePolicy(e.target.value as DupePolicy)}
                className="h-7 rounded border border-border bg-surface-1 px-1 text-[11px]"
              >
                <option value="replace">replace label + description (import wins)</option>
                <option value="reject">skip duplicate rows (existing wins)</option>
              </select>
            </label>
          </div>
        ) : null}

        {pasteOpen ? (
          <div className="border-b border-border bg-surface-0 p-3">
            <p className="mb-1.5 flex items-center gap-1 text-[11px] text-muted">
              <FileSpreadsheet className="h-3 w-3" />
              Paste CSV/TSV rows. First row can be headers (
              <code className="rounded bg-surface-2 px-1">code,label,description</code>
              ) or just data.
            </p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={`code,label,description\nHIGH,High priority,\nMED,Medium priority,\nLOW,Low priority,`}
              rows={5}
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPasteOpen(false);
                  setPasteText('');
                }}
                className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs text-ink-1 hover:bg-surface-2"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyPaste}
                disabled={!pasteText.trim()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-2 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" /> Apply
              </button>
            </div>
          </div>
        ) : null}

        {data.entries.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted">
            No entries yet. Add rows manually, import a CSV/Excel file, or
            paste from the clipboard.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {data.entries.map((entry, i) => (
              <li
                key={`${i}`}
                className="grid grid-cols-[2fr_3fr_3fr_auto] items-start gap-2 px-3 py-2"
              >
                <input
                  type="text"
                  value={entry.code}
                  onChange={(e) => updateRow(i, { code: e.target.value })}
                  placeholder="CODE"
                  disabled={!canEdit}
                  className="h-8 rounded-md border border-border bg-surface-1 px-2 font-mono text-xs uppercase focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
                />
                <input
                  type="text"
                  value={entry.label}
                  onChange={(e) => updateRow(i, { label: e.target.value })}
                  placeholder="Human label"
                  disabled={!canEdit}
                  className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
                />
                <input
                  type="text"
                  value={entry.description ?? ''}
                  onChange={(e) => updateRow(i, { description: e.target.value })}
                  placeholder="Description (optional)"
                  disabled={!canEdit}
                  className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
                />
                {canEdit ? (
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => moveRow(i, -1)}
                      disabled={i === 0}
                      title="Move up"
                      className="inline-flex h-8 w-7 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-surface-2 disabled:opacity-30"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveRow(i, 1)}
                      disabled={i === data.entries.length - 1}
                      title="Move down"
                      className="inline-flex h-8 w-7 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-surface-2 disabled:opacity-30"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      title="Remove row"
                      className="inline-flex h-8 w-7 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canEdit ? (
        <section className="rounded-lg border border-border bg-surface-1 p-3">
          <label className="block text-xs">
            <span className="mb-1 block uppercase tracking-wide text-muted">
              Author note (optional)
            </span>
            <textarea
              value={data.note ?? ''}
              onChange={(e) =>
                setData((prev) => ({ ...prev, note: e.target.value }))
              }
              placeholder="Source, stewardship, review cadence, anything the next maintainer should know."
              rows={2}
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <span className="mt-1 block text-[11px] text-muted">
              Only shown to authors with edit access.
            </span>
          </label>
        </section>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="flex items-center gap-1.5 text-sm text-danger"
        >
          <AlertTriangle className="h-4 w-4" />
          {error}
        </p>
      ) : null}

      {importInfo ? (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <Check className="h-4 w-4" />
          {importInfo}
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex items-center justify-end gap-2">
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save pick list
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delimited-text helpers
// ---------------------------------------------------------------------------

/**
 * Minimal CSV / TSV parser. Handles:
 *   - Commas or tabs as field delimiter (whichever is more common on row 1)
 *   - Quoted fields with embedded commas and doubled "" escapes
 *   - CRLF or LF line endings
 *
 * Deliberately NOT a full RFC 4180 impl: we don't need escaped newlines
 * inside quoted fields for the pick-list use case. Imports with that
 * shape can go through the .xlsx path instead.
 */
function parseDelimited(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const firstLine = normalized.split('\n', 1)[0] ?? '';
  const delim =
    (firstLine.match(/\t/g)?.length ?? 0) >
    (firstLine.match(/,/g)?.length ?? 0)
      ? '\t'
      : ',';

  const rows: string[][] = [];
  const lines = normalized.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delim) {
          fields.push(cur);
          cur = '';
        } else {
          cur += ch;
        }
      }
    }
    fields.push(cur);
    rows.push(fields);
  }
  return rows;
}

/**
 * Convert a string matrix into PickListEntry[]. Expects a header row
 * with some variant of code/label/description; falls back to positional
 * (col 0 = code, col 1 = label, col 2 = description) when no header is
 * detected. Column names are case-insensitive and tolerate common
 * aliases (`value`, `key` for code; `name`, `display` for label).
 */
function rowsToEntries(rows: string[][]): PickListEntry[] {
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => String(h).trim().toLowerCase());
  const knownHeaders = new Set([
    'code',
    'value',
    'key',
    'label',
    'name',
    'display',
    'description',
    'desc',
  ]);
  const looksLikeHeader = header.some((h) => knownHeaders.has(h));

  let codeIdx = 0;
  let labelIdx = 1;
  let descIdx = 2;
  let startAt = 0;
  if (looksLikeHeader) {
    codeIdx = header.findIndex((h) => ['code', 'value', 'key'].includes(h));
    labelIdx = header.findIndex((h) => ['label', 'name', 'display'].includes(h));
    descIdx = header.findIndex((h) => ['description', 'desc'].includes(h));
    if (codeIdx < 0) codeIdx = 0;
    if (labelIdx < 0) labelIdx = 1;
    startAt = 1;
  }

  const out: PickListEntry[] = [];
  for (let i = startAt; i < rows.length; i += 1) {
    const row = rows[i]!;
    const code = String(row[codeIdx] ?? '').trim();
    const label = String(row[labelIdx] ?? '').trim();
    if (!code) continue;
    const entry: PickListEntry = { code, label: label || code };
    const desc = descIdx >= 0 ? String(row[descIdx] ?? '').trim() : '';
    if (desc) entry.description = desc;
    out.push(entry);
  }
  return out;
}
