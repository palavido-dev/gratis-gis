// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #159 "Print this map" chooser dialog.
 *
 * Two paths into printing:
 *   1. Create a new print layout pre-bound to this map.
 *   2. Pick an existing print_template — hover shows a layout
 *      wireframe; click opens a preview step that renders the PDF
 *      into an iframe so the author can confirm before downloading.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, Loader2, Plus, Printer } from 'lucide-react';

import { useT } from '@/lib/i18n/locale-context';
import type { PrintTemplateData } from '@gratis-gis/shared-types';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { PrintLayoutThumb } from './print-layout-thumb';

interface PrintTemplateSummary {
  id: string;
  title: string;
  description?: string;
  data?: PrintTemplateData | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** UUID of the map the author triggered the print from. */
  mapId: string;
}

type Step =
  | { kind: 'pick' }
  | {
      kind: 'preview';
      templateId: string;
      title: string;
      blobUrl: string | null;
      rendering: boolean;
    };

export function PrintThisMapDialog({ open, onClose, mapId }: Props) {
  const t = useT();
  const [templates, setTemplates] = useState<PrintTemplateSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [hoverId, setHoverId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // full=1 so each row carries PrintTemplateData for the hover
      // layout thumbnails. The list is small (starter set + a few
      // custom layouts).
      const res = await fetch(
        `/api/portal/items?type=print_template&limit=50&full=1`,
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const json = (await res.json()) as
        | Array<{
            id: string;
            title: string;
            description?: string;
            data?: PrintTemplateData | null;
          }>
        | {
            items?: Array<{
              id: string;
              title: string;
              description?: string;
              data?: PrintTemplateData | null;
            }>;
          };
      const rows = Array.isArray(json) ? json : (json.items ?? []);
      setTemplates(
        rows.map((it) => ({
          id: it.id,
          title: it.title,
          ...(it.description ? { description: it.description } : {}),
          ...(it.data ? { data: it.data } : {}),
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setStep({ kind: 'pick' });
      setHoverId(null);
      setError(null);
      void refresh();
    }
  }, [open, refresh]);

  // Revoke blob URLs when leaving the preview step or closing.
  useEffect(() => {
    return () => {
      if (step.kind === 'preview' && step.blobUrl) {
        URL.revokeObjectURL(step.blobUrl);
      }
    };
  }, [step]);

  const renderPreview = useCallback(
    async (templateId: string, title: string) => {
      setError(null);
      setStep({
        kind: 'preview',
        templateId,
        title,
        blobUrl: null,
        rendering: true,
      });
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
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setStep({
          kind: 'preview',
          templateId,
          title,
          blobUrl: url,
          rendering: false,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to render');
        setStep({ kind: 'pick' });
      }
    },
    [mapId],
  );

  function downloadPreview() {
    if (step.kind !== 'preview' || !step.blobUrl) return;
    const a = document.createElement('a');
    a.href = step.blobUrl;
    a.download = `${sanitizeFilename(step.title)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function backToPick() {
    if (step.kind === 'preview' && step.blobUrl) {
      URL.revokeObjectURL(step.blobUrl);
    }
    setStep({ kind: 'pick' });
    setError(null);
  }

  const hovered = hoverId
    ? templates.find((tmpl) => tmpl.id === hoverId)
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (step.kind === 'preview' && step.blobUrl) {
            URL.revokeObjectURL(step.blobUrl);
          }
          onClose();
        }
      }}
    >
      <DialogContent
        size={step.kind === 'preview' ? 'xl' : 'md'}
        className="flex max-h-[85vh] flex-col overflow-hidden p-0"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 pr-12">
          {step.kind === 'preview' ? (
            <button
              type="button"
              onClick={backToPick}
              className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink-1"
              aria-label={t('print.backToLayouts')}
              title={t('print.backToLayouts')}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : (
            <Printer className="h-4 w-4 text-muted" />
          )}
          <DialogTitle className="text-sm font-semibold text-ink-1">
            {step.kind === 'preview'
              ? t('print.previewTitle', { title: step.title })
              : t('print.chooserTitle')}
          </DialogTitle>
        </div>

        {step.kind === 'pick' ? (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
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
                          onMouseEnter={() => setHoverId(tmpl.id)}
                          onMouseLeave={() =>
                            setHoverId((cur) =>
                              cur === tmpl.id ? null : cur,
                            )
                          }
                          onFocus={() => setHoverId(tmpl.id)}
                          onBlur={() =>
                            setHoverId((cur) =>
                              cur === tmpl.id ? null : cur,
                            )
                          }
                          onClick={() =>
                            void renderPreview(tmpl.id, tmpl.title)
                          }
                          className="block w-full rounded border border-border bg-surface-1 px-3 py-2 text-left hover:bg-surface-2 focus:border-accent focus:outline-hidden"
                        >
                          <p className="text-sm font-medium text-ink-1">
                            {tmpl.title}
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

            <aside className="hidden w-48 shrink-0 border-l border-border bg-surface-0/60 p-3 sm:block">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                {t('print.layoutPreview')}
              </p>
              {hovered?.data ? (
                <div className="flex flex-col items-center gap-2">
                  <PrintLayoutThumb data={hovered.data} maxWidth={152} />
                  <p className="text-center text-2xs text-muted">
                    {hovered.title}
                  </p>
                </div>
              ) : (
                <p className="text-2xs text-muted">
                  {t('print.layoutPreviewHint')}
                </p>
              )}
            </aside>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {error ? (
              <p role="alert" className="px-4 pt-3 text-xs text-danger">
                {error}
              </p>
            ) : null}
            <div className="relative min-h-0 flex-1 bg-surface-2">
              {step.rendering || !step.blobUrl ? (
                <div className="flex h-full min-h-[24rem] items-center justify-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('print.renderingPreview')}
                </div>
              ) : (
                <iframe
                  title={t('print.previewFrameAria', { title: step.title })}
                  src={step.blobUrl}
                  className="h-full min-h-[24rem] w-full border-0 bg-white"
                />
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={backToPick}
                className="inline-flex h-9 items-center rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2"
              >
                {t('print.backToLayouts')}
              </button>
              <button
                type="button"
                onClick={downloadPreview}
                disabled={!step.blobUrl || step.rendering}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                {t('print.downloadPdf')}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
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
