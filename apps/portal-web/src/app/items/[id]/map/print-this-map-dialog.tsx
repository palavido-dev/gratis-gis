// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #159 Phase 1: "Print this map" chooser dialog.
 *
 * Opens from the map editor toolbar and gives the author two
 * paths to printing the current map:
 *
 *   1. **Use an existing print template** — picks any
 *      print_template item the viewer can read. We forward the
 *      caller's map id as a query param so the template's
 *      designer opens already pointing at this map, which the
 *      Map / Legend / Scalebar / North-arrow elements auto-bind
 *      to. No need to wire references manually.
 *
 *   2. **Create a new template pre-bound to this map** — opens
 *      the new-item wizard with `type=print_template` and the
 *      map id pre-supplied. The wizard writes the id into the
 *      template's `defaultMapId` field on create.
 *
 * Phase 2 will replace `window.print()` with a server-side
 * Puppeteer pipeline for vector-quality PDFs; the chooser shape
 * stays the same.
 *
 * Pre-existing `print_template` ships under #101 and includes
 * the designer + parameters + smart auto-binding. This dialog
 * is the missing UX bridge from a plain map to that designer.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Printer, Plus, X } from 'lucide-react';

import { useT } from '@/lib/i18n/locale-context';

interface PrintTemplateSummary {
  id: string;
  title: string;
  description?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** UUID of the map the author triggered the print from. */
  mapId: string;
}

export function PrintThisMapDialog({ open, onClose, mapId }: Props) {
  const t = useT();
  const [templates, setTemplates] = useState<PrintTemplateSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #159 Phase 2 follow-up: rendering state when the user has picked
  // a template and we're waiting on the server-side render. Tracked
  // by template id so multiple clicks queue cleanly and the picker
  // shows progress on the right row only.
  const [renderingId, setRenderingId] = useState<string | null>(null);

  const renderWithTemplate = useCallback(
    async (templateId: string, title: string) => {
      setRenderingId(templateId);
      setError(null);
      try {
        const res = await fetch('/api/portal/print/render', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ templateId, mapId }),
        });
        if (!res.ok) {
          throw new Error(
            `Render failed: ${res.status} ${res.statusText}`,
          );
        }
        // Stream the PDF into a blob and trigger a browser-side
        // download with a filename derived from the template's
        // title. The server already sets content-disposition, but
        // browsers honor the anchor's `download` attribute over
        // the response header when the URL is a blob URL.
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${sanitizeFilename(title)}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to render');
      } finally {
        setRenderingId(null);
      }
    },
    [mapId, onClose],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/items?type=print_template&limit=50`,
      );
      if (!res.ok) throw new Error(`${res.status}`);
      // /api/portal/items returns a bare array (no { items } wrapper).
      // Stay defensive in case the endpoint shape ever changes: accept
      // either the array directly or a wrapped { items: [] }.
      const json = (await res.json()) as
        | Array<{ id: string; title: string; description?: string }>
        | { items?: Array<{ id: string; title: string; description?: string }> };
      const rows = Array.isArray(json) ? json : (json.items ?? []);
      setTemplates(
        rows.map((it) => ({
          id: it.id,
          title: it.title,
          ...(it.description ? { description: it.description } : {}),
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label={t('print.chooserTitle')}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[36rem] max-w-[90vw] flex-col rounded-md border border-border bg-surface-1 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Printer className="h-4 w-4 text-muted" />
            <h2 className="text-sm font-semibold text-ink-1">
              {t('print.chooserTitle')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink-1"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3">
          <section className="mb-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {t('print.startSection')}
            </h3>
            <Link
              href={`/items/new?type=print_template&map=${encodeURIComponent(mapId)}`}
              className="flex items-center gap-2 rounded border border-border bg-surface-1 px-3 py-2 text-sm text-ink-1 hover:bg-surface-2"
            >
              <Plus className="h-4 w-4 text-muted" />
              {t('print.startAction')}
            </Link>
            <p className="mt-1 text-2xs text-muted">
              {t('print.startHint')}
            </p>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {t('print.pickSection')}
            </h3>
            {loading ? (
              <p className="text-xs text-muted">{t('common.loading')}</p>
            ) : error ? (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            ) : templates.length === 0 ? (
              <p className="text-xs text-muted">
                {t('print.pickEmpty')}
              </p>
            ) : (
              <ul className="space-y-1">
                {templates.map((tmpl) => (
                  <li key={tmpl.id}>
                    <button
                      type="button"
                      disabled={renderingId !== null}
                      onClick={() => renderWithTemplate(tmpl.id, tmpl.title)}
                      className="block w-full rounded border border-border bg-surface-1 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-50"
                    >
                      <p className="flex items-center gap-2 text-sm font-medium text-ink-1">
                        {tmpl.title}
                        {renderingId === tmpl.id ? (
                          <span className="text-2xs font-normal text-muted">
                            {t('common.loading')}
                          </span>
                        ) : null}
                      </p>
                      {tmpl.description ? (
                        <p className="mt-0.5 line-clamp-2 text-2xs text-muted">
                          {tmpl.description}
                        </p>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Strip filesystem-unsafe characters out of a template title so it
 * can be used as the PDF's downloaded filename. Keeps the result
 * readable (no mass `_` substitution) while removing the few chars
 * that trip downloads on Windows + macOS.
 */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : 'map-print';
}
