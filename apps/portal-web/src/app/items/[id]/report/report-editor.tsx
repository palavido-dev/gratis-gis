// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Report template editor: pick the layer, write the template with
 * field and expression placeholders, preview it filled for one
 * feature, and download a PDF for the features you tick.
 *
 * The preview is HTML built by the server (the same code that makes
 * the PDF), shown in a sandboxed frame with scripts off.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eye, Loader2, Save } from 'lucide-react';
import {
  defaultReportBody,
  MAX_REPORT_FEATURES,
  normalizeReportTemplate,
  REPORT_PAGE_SIZES,
  type DataLayerDataV3,
  type FeatureField,
  type ReportPageSize,
  type ReportTemplateData,
} from '@gratis-gis/shared-types';

import { pickRowTitle } from '@/lib/field-form';
import { useT } from '@/lib/i18n/locale-context';

interface Props {
  itemId: string;
  title: string;
  initial: unknown;
  canEdit: boolean;
}

interface LayerOption {
  id: string;
  title: string;
}

interface FeatureRow {
  id: string;
  properties: Record<string, unknown>;
}

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message)) return body.message.join('; ');
  } catch {
    // fall through
  }
  return `${fallback} (HTTP ${res.status})`;
}

export function ReportTemplateEditor({ itemId, title, initial, canEdit }: Props) {
  const t = useT();
  const start = useMemo<ReportTemplateData>(() => {
    const r = normalizeReportTemplate(initial ?? {});
    return 'data' in r
      ? r.data
      : { version: 1, sources: [], body: '', page: { size: 'letter', orientation: 'portrait' } };
  }, [initial]);
  const [draft, setDraft] = useState<ReportTemplateData>(start);
  const [saved, setSaved] = useState(JSON.stringify(start));
  const dirty = JSON.stringify(draft) !== saved;
  const source = draft.sources[0] ?? null;

  const [layers, setLayers] = useState<LayerOption[] | null>(null);
  const [sublayers, setSublayers] = useState<
    Array<{ id: string; label: string; fields: FeatureField[] }>
  >([]);
  const [features, setFeatures] = useState<FeatureRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ html: string; issues: string[] } | null>(null);
  const [busy, setBusy] = useState<'save' | 'preview' | 'pdf' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Data layers the user can read.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/portal/items?type=data_layer&lite=1')
      .then((r) => (r.ok ? (r.json() as Promise<Array<{ id: string; title: string }>>) : []))
      .then((rows) => {
        if (!cancelled) setLayers(rows.map((r) => ({ id: r.id, title: r.title })));
      })
      .catch(() => {
        if (!cancelled) setLayers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The chosen data layer's sublayers and fields.
  const sourceItemId = source?.itemId ?? null;
  useEffect(() => {
    if (!sourceItemId) {
      setSublayers([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/portal/items/${sourceItemId}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { data?: DataLayerDataV3 }) : null))
      .then((item) => {
        if (cancelled) return;
        const data = item?.data;
        setSublayers(
          data?.version === 3
            ? data.layers.map((l) => ({
                id: l.id,
                label: l.label || l.name || l.id,
                fields: l.fields ?? [],
              }))
            : [],
        );
      })
      .catch(() => {
        if (!cancelled) setSublayers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceItemId]);

  const fields = useMemo(
    () => sublayers.find((s) => s.id === source?.layerKey)?.fields ?? [],
    [sublayers, source?.layerKey],
  );

  // Recent features of the layer, for the preview and for generating.
  const layerKey = source?.layerKey ?? null;
  useEffect(() => {
    if (!sourceItemId || !layerKey) {
      setFeatures(null);
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams({
      limit: String(MAX_REPORT_FEATURES),
      sort: '_edited_at',
      dir: 'desc',
    });
    if (search.trim()) qs.set('q', search.trim());
    const timer = setTimeout(() => {
      void fetch(
        `/api/portal/items/${sourceItemId}/layers/${encodeURIComponent(layerKey)}/features-page?${qs.toString()}`,
      )
        .then(async (r) =>
          r.ok ? ((await r.json()) as { features?: FeatureRow[] }) : { features: [] },
        )
        .then((j) => {
          if (!cancelled) setFeatures(j.features ?? []);
        })
        .catch(() => {
          if (!cancelled) setFeatures([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sourceItemId, layerKey, search]);

  const runPreview = useCallback(
    async (featureId: string | null) => {
      if (!source) return;
      setBusy('preview');
      setError(null);
      try {
        const res = await fetch('/api/portal/reports/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceItemId: source.itemId,
            layerKey: source.layerKey,
            body: draft.body,
            ...(featureId ? { featureId } : {}),
          }),
        });
        if (!res.ok) throw new Error(await errorText(res, t('reportTemplate.previewFailed')));
        const j = (await res.json()) as {
          html: string;
          featureId: string | null;
          issues: string[];
        };
        setPreview({ html: j.html, issues: j.issues });
        if (j.featureId) setPreviewId(j.featureId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [source, draft.body, t],
  );

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: draft }),
      });
      if (!res.ok) throw new Error(await errorText(res, t('reportTemplate.saveFailed')));
      setSaved(JSON.stringify(draft));
      setNotice(t('reportTemplate.saved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function downloadPdf(ids: string[]) {
    if (ids.length === 0) return;
    setBusy('pdf');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ featureIds: ids.slice(0, MAX_REPORT_FEATURES) }),
      });
      if (!res.ok) throw new Error(await errorText(res, t('reportTemplate.pdfFailed')));
      const issues = res.headers.get('x-report-issues');
      if (issues) setNotice(decodeURIComponent(issues));
      const blob = await res.blob();
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        'report.pdf';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function insert(text: string) {
    const el = bodyRef.current;
    if (!el) {
      setDraft((d) => ({ ...d, body: d.body + text }));
      return;
    }
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const next = draft.body.slice(0, s) + text + draft.body.slice(e);
    setDraft((d) => ({ ...d, body: next }));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + text.length, s + text.length);
    });
  }

  function pickSource(itemIdValue: string) {
    setPreview(null);
    setPreviewId(null);
    setSelected(new Set());
    setDraft((d) => ({
      ...d,
      sources: itemIdValue ? [{ itemId: itemIdValue, layerKey: '' }] : [],
    }));
  }

  // Pick the first sublayer once they load.
  useEffect(() => {
    if (source && !source.layerKey && sublayers[0]) {
      const first = sublayers[0];
      setDraft((d) => ({
        ...d,
        sources: [{ itemId: source.itemId, layerKey: first.id }],
        body: d.body.trim() ? d.body : defaultReportBody(title, first.fields),
      }));
    }
  }, [source, sublayers, title]);

  const savedSourceMatches = (() => {
    try {
      const s = JSON.parse(saved) as ReportTemplateData;
      return (
        s.sources[0]?.itemId === source?.itemId &&
        s.sources[0]?.layerKey === source?.layerKey &&
        s.body === draft.body
      );
    } catch {
      return false;
    }
  })();

  const input = 'rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm';
  const button =
    'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50';

  return (
    <div className="space-y-4">
      <section className="grid gap-3 rounded-lg border border-border bg-surface-1 p-4 shadow-card sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('reportTemplate.layer')}</span>
          <select
            className={`${input} w-full`}
            value={source?.itemId ?? ''}
            disabled={!canEdit}
            onChange={(e) => pickSource(e.target.value)}
          >
            <option value="">
              {layers === null ? t('reportTemplate.loading') : t('reportTemplate.pickLayer')}
            </option>
            {(layers ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </label>
        {sublayers.length > 1 ? (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('reportTemplate.sublayer')}</span>
            <select
              className={`${input} w-full`}
              value={source?.layerKey ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  sources: source ? [{ itemId: source.itemId, layerKey: e.target.value }] : [],
                }))
              }
            >
              {sublayers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('reportTemplate.page')}</span>
          <span className="flex gap-2">
            <select
              className={input}
              value={draft.page.size}
              disabled={!canEdit}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  page: { ...d.page, size: e.target.value as ReportPageSize },
                }))
              }
            >
              {REPORT_PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s === 'a4' || s === 'a3'
                    ? s.toUpperCase()
                    : s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <select
              className={input}
              value={draft.page.orientation}
              disabled={!canEdit}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  page: {
                    ...d.page,
                    orientation: e.target.value === 'landscape' ? 'landscape' : 'portrait',
                  },
                }))
              }
            >
              <option value="portrait">{t('reportTemplate.portrait')}</option>
              <option value="landscape">{t('reportTemplate.landscape')}</option>
            </select>
          </span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('reportTemplate.fileName')}</span>
          <input
            className={`${input} w-full`}
            value={draft.fileName ?? ''}
            placeholder={title}
            disabled={!canEdit}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                ...(e.target.value ? { fileName: e.target.value } : { fileName: '' }),
              }))
            }
          />
        </label>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('reportTemplate.template')}</h2>
            {canEdit ? (
              <button
                type="button"
                className={button}
                disabled={!dirty || busy !== null}
                onClick={() => void save()}
              >
                {busy === 'save' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {t('reportTemplate.save')}
              </button>
            ) : null}
          </div>
          <textarea
            ref={bodyRef}
            className={`${input} h-[28rem] w-full font-mono text-xs`}
            value={draft.body}
            readOnly={!canEdit}
            spellCheck={false}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          />
          {canEdit && fields.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {fields.map((f) => (
                <button
                  key={f.name}
                  type="button"
                  className="rounded border border-border bg-surface-0 px-1.5 py-0.5 font-mono text-xs hover:bg-surface-2"
                  title={f.label || f.name}
                  onClick={() => insert(`{{${f.name}}}`)}
                >
                  {f.name}
                </button>
              ))}
              <button
                type="button"
                className="rounded border border-border bg-surface-0 px-1.5 py-0.5 font-mono text-xs hover:bg-surface-2"
                onClick={() => insert('{{photos}}')}
              >
                photos
              </button>
            </div>
          ) : null}
          <p className="text-xs text-muted">{t('reportTemplate.syntaxHint')}</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('reportTemplate.preview')}</h2>
            <button
              type="button"
              className={button}
              disabled={!source?.layerKey || busy !== null}
              onClick={() => void runPreview(previewId)}
            >
              {busy === 'preview' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
              {t('reportTemplate.refreshPreview')}
            </button>
          </div>
          {preview ? (
            <>
              <iframe
                title={t('reportTemplate.preview')}
                sandbox=""
                srcDoc={preview.html}
                className="h-[28rem] w-full rounded-md border border-border bg-white"
              />
              {preview.issues.length > 0 ? (
                <ul className="list-disc pl-5 text-xs text-warn">
                  {preview.issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted">
              {t('reportTemplate.previewEmpty')}
            </p>
          )}
        </div>
      </section>

      {source?.layerKey ? (
        <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('reportTemplate.generate')}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={input}
                placeholder={t('reportTemplate.search')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                disabled={selected.size === 0 || busy !== null || dirty || !savedSourceMatches}
                title={dirty ? t('reportTemplate.saveFirst') : undefined}
                onClick={() => void downloadPdf([...selected])}
              >
                {busy === 'pdf' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {t('reportTemplate.downloadPdf', { count: selected.size })}
              </button>
            </div>
          </div>
          {dirty ? (
            <p className="mt-1 text-xs text-muted">{t('reportTemplate.saveFirst')}</p>
          ) : null}
          {features === null ? (
            <p className="mt-2 text-sm text-muted">{t('reportTemplate.loading')}</p>
          ) : features.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t('reportTemplate.noFeatures')}</p>
          ) : (
            <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border">
              <label className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={features.length > 0 && features.every((f) => selected.has(f.id))}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(features.map((f) => f.id)) : new Set())
                  }
                />
                {t('reportTemplate.selectAll', { count: features.length })}
              </label>
              {features.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm last:border-b-0"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(f.id)}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(f.id);
                        else next.delete(f.id);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {pickRowTitle(f.properties) ?? f.id.slice(0, 8)}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-accent hover:underline"
                    onClick={() => void runPreview(f.id)}
                  >
                    {t('reportTemplate.previewThis')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}
    </div>
  );
}
