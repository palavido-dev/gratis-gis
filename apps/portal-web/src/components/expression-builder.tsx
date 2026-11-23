// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * The expression builder, shared by every place an expression is
 * written: derived-layer steps, Calculate field, labels, popups and
 * styling.
 *
 * - Checks as you type, with the same checker the server uses, and
 *   points at the problem.
 * - Offers the layer's fields, every function with its help text, and
 *   (with a layer) the related tables and layers the expression may
 *   read.
 * - Previews the result on real features. With a layer, the preview
 *   runs on the server, so data access and share limits are exactly
 *   what the saved expression will see.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Database, FunctionSquare, Loader2, Search, Table2 } from 'lucide-react';
import {
  analyzeExpression,
  DATA_FUNCTION_DOCS,
  FUNCTIONS,
  type DataResolver,
  type DataSource,
  type FieldRef,
  type FunctionCategory,
  type ValueType,
} from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';

export interface ExpressionBuilderLayer {
  itemId: string;
  layerId: string;
}

export interface ExpressionBuilderProps {
  value: string;
  onChange: (next: string) => void;
  /** Fields of the rows the expression runs on. */
  fields: FieldRef[];
  /** The layer the expression runs on: enables data access and a server preview. */
  layer?: ExpressionBuilderLayer | undefined;
  /** What the caller needs back. 'any' shows the type without checking it. */
  expect?: 'boolean' | 'number' | 'string' | 'date' | 'any';
  label?: string;
  hint?: string;
  placeholder?: string;
  rows?: number;
  /**
   * Preview on the layer's features through the server (default
   * true). Off where the rows the expression sees are not the
   * layer's, such as a later step of a derived layer.
   */
  serverPreview?: boolean;
  /** Feature attributes to preview on when there is no layer. */
  samples?: Array<Record<string, unknown>>;
  /** Called with the analysis so the caller can block saving. */
  onValidity?: (v: { ok: boolean; type: ValueType | null }) => void;
}

interface SourcesResponse {
  related: Array<{ name: string; id: string; fields: FieldRef[] }>;
  layers: Array<{
    itemId: string;
    title: string;
    ref: string;
    layers: Array<{ id: string; label: string; geometryType: string | null; fields: FieldRef[] }>;
  }>;
}

const CATEGORY_ORDER: Array<FunctionCategory> = ['logic', 'text', 'math', 'date', 'list', 'conversion', 'geometry', 'data'];

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A client-side resolver over the sources the server listed. */
function resolverFrom(sources: SourcesResponse | null, itemId: string): DataResolver | undefined {
  if (!sources) return undefined;
  return {
    related(name) {
      const hit = sources.related.find((r) => same(r.name, name) || r.id === name);
      if (!hit) return { error: `This layer has no related table called ${name}` };
      return {
        key: `${itemId}/${hit.id}`,
        label: hit.name,
        fields: hit.fields,
        hasGeometry: false,
        itemId,
        layerId: hit.id,
        parentFk: '_',
      } satisfies DataSource;
    },
    layer(name, sublayer) {
      const items = sources.layers.filter((l) => l.itemId === name || same(l.title, name));
      if (items.length === 0) return { error: `No layer called ${name} is shared with you` };
      if (items.length > 1) return { error: `More than one layer is called ${name}; use its id` };
      const item = items[0]!;
      const layer = sublayer
        ? item.layers.find((l) => l.id === sublayer || same(l.label, sublayer))
        : item.layers.length === 1
          ? item.layers[0]
          : undefined;
      if (!layer) {
        return {
          error: sublayer
            ? `${item.title} has no layer called ${sublayer}`
            : `${item.title} has several layers; name one, such as layer('${item.ref}', '${item.layers[0]?.label ?? ''}')`,
        };
      }
      return {
        key: `${item.itemId}/${layer.id}`,
        label: item.title,
        fields: layer.fields,
        hasGeometry: layer.geometryType !== null,
        itemId: item.itemId,
        layerId: layer.id,
      };
    },
  };
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '(empty)';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function ExpressionBuilder(props: ExpressionBuilderProps) {
  const t = useT();
  const { value, onChange, fields, layer } = props;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [panel, setPanel] = useState<'fields' | 'functions' | 'data' | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<FunctionCategory | 'all'>('all');
  const [sources, setSources] = useState<SourcesResponse | null>(null);
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    loading: boolean;
    rows: Array<{ id: string; value: unknown }>;
    issues: string[];
  }>({ loading: false, rows: [], issues: [] });

  // Sources the expression may read: only with a layer.
  useEffect(() => {
    if (!layer) return;
    let cancelled = false;
    fetch(`/api/portal/items/${layer.itemId}/layers/${encodeURIComponent(layer.layerId)}/expressions/sources`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: SourcesResponse | null) => {
        if (!cancelled) setSources(j);
      })
      .catch(() => {
        if (!cancelled) setSources(null);
      });
    return () => {
      cancelled = true;
    };
  }, [layer?.itemId, layer?.layerId]);

  const resolver = useMemo(() => (layer ? resolverFrom(sources, layer.itemId) : undefined), [sources, layer]);

  const analysis = useMemo(() => {
    if (value.trim() === '') return null;
    return analyzeExpression(value, { fields, ...(resolver ? { data: resolver } : {}) });
  }, [value, fields, resolver]);

  const typeIssue = useMemo(() => {
    if (!analysis || analysis.issues.length > 0 || !props.expect || props.expect === 'any') return null;
    const got = analysis.type;
    if (got === null || got === 'unknown' || got === 'null' || got === props.expect) return null;
    if (props.expect === 'string') return null; // anything shows as text
    return t('expressionBuilder.wrongType', {
      want: t(`expressionBuilder.type_${props.expect}`),
      got: t(`expressionBuilder.type_${got}`),
    });
  }, [analysis, props.expect, t]);

  const ok = !!analysis && analysis.issues.length === 0 && typeIssue === null;
  const onValidity = props.onValidity;
  useEffect(() => {
    onValidity?.({ ok: value.trim() === '' ? false : ok, type: analysis?.type ?? null });
  }, [ok, analysis?.type, value, onValidity]);

  // Preview on real features, debounced.
  useEffect(() => {
    if (!ok) {
      setPreview({ loading: false, rows: [], issues: [] });
      return;
    }
    if (!layer || props.serverPreview === false) {
      if (!props.samples?.length) {
        setPreview({ loading: false, rows: [], issues: [] });
        return;
      }
      // Local preview: same evaluator the field app uses offline.
      void import('@gratis-gis/shared-types').then(({ evaluateExpressionValue }) => {
        const rows = props.samples!.slice(0, 5).map((p, i) => {
          try {
            return { id: String(i + 1), value: evaluateExpressionValue(value, { fields, properties: p }) };
          } catch (e) {
            return { id: String(i + 1), value: e instanceof Error ? e.message : '?' };
          }
        });
        setPreview({ loading: false, rows, issues: [] });
      });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setPreview((p) => ({ ...p, loading: true }));
      fetch(`/api/portal/items/${layer.itemId}/layers/${encodeURIComponent(layer.layerId)}/expressions/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expressions: { v: value }, limit: 5 }),
        signal: ctrl.signal,
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(await r.text());
          return r.json() as Promise<{
            expressions: Record<string, { issues: Array<{ message: string }> }>;
            rows: Array<{ id: string; values: Record<string, unknown> }>;
          }>;
        })
        .then((j) => {
          setPreview({
            loading: false,
            rows: j.rows.map((r) => ({ id: r.id, value: r.values.v })),
            issues: (j.expressions.v?.issues ?? []).map((i) => i.message),
          });
        })
        .catch((e: unknown) => {
          if ((e as { name?: string }).name === 'AbortError') return;
          setPreview({ loading: false, rows: [], issues: [t('expressionBuilder.previewFailed')] });
        });
    }, 600);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [ok, value, layer, props.samples, props.serverPreview, fields, t]);

  function insert(text: string, caretBack = 0) {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const caret = start + text.length - caretBack;
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        /* hidden mid-update */
      }
    });
  }

  const functionList = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = FUNCTIONS.flatMap((f) =>
      f.variants.map((v, i) => ({
        key: `${f.name}-${i}`,
        name: f.name,
        signature: v.signature,
        description: f.description,
        example: i === 0 ? f.example : undefined,
        category: f.category,
        aliases: f.aliases ?? [],
      })),
    );
    const data = layer
      ? DATA_FUNCTION_DOCS.map((d) => ({
          key: `data-${d.name}`,
          name: d.name,
          signature: d.signature,
          description: d.description,
          example: d.example,
          category: 'data' as FunctionCategory,
          aliases: [] as string[],
        }))
      : [];
    return [...base, ...data].filter(
      (f) =>
        (category === 'all' || f.category === category) &&
        (!q ||
          f.name.includes(q) ||
          f.aliases.some((a) => a.includes(q)) ||
          f.description.toLowerCase().includes(q)),
    );
  }, [search, category, layer]);

  const firstIssue = analysis?.issues[0] ?? null;
  const caretLine = useMemo(() => {
    if (!firstIssue) return null;
    const pos = Math.min(firstIssue.pos, value.length);
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = value.indexOf('\n', pos);
    const line = value.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    return { line, col: pos - lineStart };
  }, [firstIssue, value]);

  const tab = (id: 'fields' | 'functions' | 'data', icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => setPanel(panel === id ? null : id)}
      className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-2xs ${
        panel === id ? 'border-accent bg-accent/10 text-ink-0' : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
      }`}
      aria-expanded={panel === id}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="space-y-2">
      {props.label || props.hint ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {props.label ? <p className="text-2xs uppercase tracking-wide text-muted">{props.label}</p> : <span />}
          <a
            href="/help/reference/expression-language"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-2xs text-accent hover:underline"
          >
            <BookOpen className="h-3 w-3" />
            {t('expressionBuilder.reference')}
          </a>
        </div>
      ) : null}
      {props.hint ? <p className="text-2xs text-muted">{props.hint}</p> : null}

      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={props.rows ?? 3}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={props.placeholder}
        aria-invalid={!!firstIssue || !!typeIssue}
        className={`w-full rounded-md border bg-surface-0 px-3 py-2 font-mono text-xs text-ink-0 focus:outline-hidden ${
          firstIssue || typeIssue ? 'border-danger focus:border-danger' : 'border-border focus:border-accent'
        }`}
      />

      <div className="flex flex-wrap items-center gap-1">
        {tab('fields', <Table2 className="h-3 w-3" />, t('expressionBuilder.fields'))}
        {tab('functions', <FunctionSquare className="h-3 w-3" />, t('expressionBuilder.functions'))}
        {layer ? tab('data', <Database className="h-3 w-3" />, t('expressionBuilder.otherData')) : null}
        <span className="ml-auto text-2xs text-muted">
          {analysis && analysis.issues.length === 0 && analysis.type
            ? t('expressionBuilder.returns', { type: t(`expressionBuilder.type_${analysis.type}`) })
            : null}
        </span>
      </div>

      {panel === 'fields' ? (
        <div className="max-h-48 overflow-auto rounded-md border border-border bg-surface-1 p-2">
          {fields.length === 0 ? (
            <p className="text-2xs text-muted">{t('expressionBuilder.noFields')}</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {fields.map((f) => (
                <button
                  key={f.name}
                  type="button"
                  onClick={() => insert(`{{${f.name}}}`)}
                  title={f.label && f.label !== f.name ? f.label : undefined}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-0 px-2 py-0.5 font-mono text-2xs text-ink-1 hover:bg-surface-2"
                >
                  {f.name}
                  <span className="font-sans text-muted">{t(`expressionBuilder.type_${f.type}`)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {panel === 'functions' ? (
        <div className="rounded-md border border-border bg-surface-1 p-2">
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <label className="relative">
              <Search className="pointer-events-none absolute left-2 top-1.5 h-3 w-3 text-muted" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('expressionBuilder.searchFunctions')}
                className="h-6 w-44 rounded border border-border bg-surface-0 pl-6 pr-2 text-2xs focus:border-accent focus:outline-hidden"
              />
            </label>
            {(['all', ...CATEGORY_ORDER] as const)
              .filter((c) => c !== 'data' || layer)
              .map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={`h-6 rounded px-2 text-2xs ${category === c ? 'bg-accent/15 text-ink-0' : 'text-muted hover:bg-surface-2'}`}
                >
                  {t(`expressionBuilder.cat_${c}`)}
                </button>
              ))}
          </div>
          <ul className="max-h-56 space-y-1 overflow-auto">
            {functionList.map((f) => (
              <li key={f.key} className="rounded px-2 py-1 hover:bg-surface-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => insert(`${f.name}()`, 1)}
                    className="font-mono text-2xs text-ink-0 hover:underline"
                  >
                    {f.signature}
                  </button>
                  {f.example ? (
                    <button
                      type="button"
                      onClick={() => insert(f.example!)}
                      className="font-mono text-2xs text-accent hover:underline"
                      title={t('expressionBuilder.useExample')}
                    >
                      {f.example}
                    </button>
                  ) : null}
                </div>
                <p className="text-2xs text-muted">{f.description}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {panel === 'data' && layer ? (
        <div className="max-h-64 space-y-2 overflow-auto rounded-md border border-border bg-surface-1 p-2 text-2xs">
          {!sources ? (
            <p className="inline-flex items-center gap-1 text-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('expressionBuilder.loadingSources')}
            </p>
          ) : (
            <>
              <p className="text-muted">{t('expressionBuilder.dataHint')}</p>
              {sources.related.length > 0 ? (
                <div>
                  <p className="mb-1 uppercase tracking-wide text-muted">{t('expressionBuilder.relatedTables')}</p>
                  {sources.related.map((r) => (
                    <SourceRow
                      key={r.id}
                      open={openSource === `r:${r.id}`}
                      onToggle={() => setOpenSource(openSource === `r:${r.id}` ? null : `r:${r.id}`)}
                      title={r.name}
                      insertText={`related(${quote(r.name)})`}
                      fields={r.fields}
                      onInsert={insert}
                    />
                  ))}
                </div>
              ) : null}
              <div>
                <p className="mb-1 uppercase tracking-wide text-muted">{t('expressionBuilder.layers')}</p>
                {sources.layers.flatMap((l) =>
                  l.layers.map((s) => {
                    const key = `l:${l.itemId}:${s.id}`;
                    const text =
                      l.layers.length > 1 ? `layer(${quote(l.ref)}, ${quote(s.label)})` : `layer(${quote(l.ref)})`;
                    return (
                      <SourceRow
                        key={key}
                        open={openSource === key}
                        onToggle={() => setOpenSource(openSource === key ? null : key)}
                        title={l.layers.length > 1 ? `${l.title} / ${s.label}` : l.title}
                        insertText={text}
                        fields={s.fields}
                        onInsert={insert}
                      />
                    );
                  }),
                )}
              </div>
            </>
          )}
        </div>
      ) : null}

      {firstIssue ? (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink-0">
          <p>{firstIssue.message}</p>
          {caretLine && caretLine.line.length > 0 ? (
            <pre className="mt-1 overflow-x-auto font-mono text-2xs text-muted">
              {caretLine.line}
              {'\n'}
              {' '.repeat(caretLine.col)}^
            </pre>
          ) : null}
          {analysis && analysis.issues.length > 1 ? (
            <p className="mt-1 text-2xs text-muted">
              {t('expressionBuilder.moreProblems', { count: analysis.issues.length - 1 })}
            </p>
          ) : null}
        </div>
      ) : typeIssue ? (
        <p role="alert" className="text-xs text-danger">
          {typeIssue}
        </p>
      ) : null}

      {ok && (preview.loading || preview.rows.length > 0 || preview.issues.length > 0) ? (
        <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
          <p className="mb-1 inline-flex items-center gap-1 text-2xs uppercase tracking-wide text-muted">
            {t('expressionBuilder.preview')}
            {preview.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          </p>
          {preview.issues.length > 0 ? (
            <p className="text-danger">{preview.issues[0]}</p>
          ) : (
            <ul className="space-y-0.5 font-mono text-2xs">
              {preview.rows.map((r, i) => (
                <li key={r.id} className="flex gap-2">
                  <span className="text-muted">{i + 1}.</span>
                  <span className={r.value === null ? 'text-muted' : 'text-ink-0'}>{formatValue(r.value)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SourceRow(props: {
  open: boolean;
  onToggle: () => void;
  title: string;
  insertText: string;
  fields: FieldRef[];
  onInsert: (text: string) => void;
}) {
  const t = useT();
  return (
    <div className="rounded px-1 py-0.5 hover:bg-surface-2">
      <div className="flex items-center gap-1">
        <button type="button" onClick={props.onToggle} className="text-muted" aria-expanded={props.open}>
          {props.open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <span className="flex-1 truncate text-ink-1">{props.title}</span>
        <button
          type="button"
          onClick={() => props.onInsert(props.insertText)}
          className="font-mono text-accent hover:underline"
        >
          {t('expressionBuilder.insert')}
        </button>
      </div>
      {props.open ? (
        <div className="ml-4 mt-1 flex flex-wrap gap-1">
          {props.fields.map((f) => (
            <button
              key={f.name}
              type="button"
              onClick={() => props.onInsert(`{{${f.name}}}`)}
              className="rounded border border-border bg-surface-0 px-1.5 py-0.5 font-mono text-ink-1 hover:bg-surface-2"
            >
              {f.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
