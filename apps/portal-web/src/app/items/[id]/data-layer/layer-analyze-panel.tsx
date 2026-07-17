// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * In-browser SQL analysis over one sublayer (#175, unit 1).
 *
 * The layer arrives as GeoParquet from the export endpoint (so the
 * download permission gates analysis with zero new policy surface),
 * gets registered with the shared DuckDB-WASM instance, and every
 * query after that runs on the visitor's own machine. Free at any
 * scale, offline once loaded, and invisible to the server.
 *
 * Attribute queries plus save-as-layer (units 1 and 3): the
 * geometry column is present as WKB binary but there are no spatial
 * functions yet; the spatial extension (self-hosted, air-gap rules)
 * is the remaining unit.
 *
 * Deliberately a workbench, not a wizard: a query box, a result
 * grid, and a few one-click starters. The audience for this panel
 * reads SQL; the guided experience belongs to the tool builder.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Play, Save, Sparkles } from 'lucide-react';
import type {
  DataLayerSublayer,
  FeatureField,
} from '@gratis-gis/shared-types';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { toast } from '@/lib/toast';
import {
  getDuckDb,
  registerParquetView,
  runQuery,
  RESULT_ROW_CAP,
  type QueryResultTable,
} from '@/lib/duckdb-wasm';

interface Props {
  itemId: string;
  layer: DataLayerSublayer;
}

type Phase =
  | { kind: 'booting'; step: string }
  | { kind: 'ready' }
  | { kind: 'boot-error'; message: string };

export function LayerAnalyzePanel({ itemId, layer }: Props) {
  // View name mirrors the layer's table name so queries read like
  // the schema the author already knows (SELECT * FROM facilities).
  const viewName = (layer.name || 'layer').replace(/[^a-zA-Z0-9_]/g, '_');

  const [phase, setPhase] = useState<Phase>({
    kind: 'booting',
    step: 'Starting the in-browser engine',
  });
  const [sql, setSql] = useState(`SELECT * FROM "${viewName}" LIMIT 100`);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<
    (QueryResultTable & { truncated: boolean }) | null
  >(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const connRef = useRef<AsyncDuckDBConnection | null>(null);
  const router = useRouter();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);

  /**
   * Unit 3 of #175: persist the CURRENT query's result as a brand
   * new data_layer item. The result is COPY'd to Parquet inside the
   * WASM engine (so types survive exactly as DuckDB computed them),
   * a layer schema is derived from DESCRIBE on that file, the item
   * is created through the same POST the new-item wizard uses, and
   * the bytes upload through the existing per-layer import, whose
   * server side already reads Parquet. A result with a WKB
   * geometry column becomes a spatial layer inheriting this source
   * layer's geometry type (an attribute query does not change the
   * family); without one it becomes an attribute-only table.
   */
  async function saveAsLayer(): Promise<void> {
    const conn = connRef.current;
    const title = saveTitle.trim();
    if (!conn || title.length === 0 || saveBusy) return;
    setSaveBusy(true);
    const outFile = `analysis-out-${Date.now()}.parquet`;
    try {
      // Trailing semicolons would terminate the COPY's inner SELECT.
      const inner = sql.trim().replace(/;+\s*$/, '');
      await conn.query(
        `COPY (${inner}) TO '${outFile}' (FORMAT PARQUET)`,
      );
      const described = await runQuery(
        conn,
        `DESCRIBE SELECT * FROM read_parquet('${outFile}')`,
      );
      const fields: FeatureField[] = [];
      let hasGeometry = false;
      for (const row of described.rows) {
        const colName = String(row[0] ?? '');
        const colType = String(row[1] ?? '');
        if (isWkbGeometryColumn(colName, colType)) {
          hasGeometry = true;
          continue;
        }
        fields.push({
          name: sanitizeFieldName(colName),
          label: colName,
          type: duckdbTypeToFieldType(colType),
          nullable: true,
        });
      }
      const db = await getDuckDb();
      const bytes = await db.copyFileToBuffer(outFile);

      const createRes = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'data_layer',
          title,
          description: `Created from an in-browser SQL analysis of "${layer.label || layer.name}".`,
          tags: [],
          access: 'private',
          data: {
            version: 3,
            storageType: 'postgis',
            layers: [
              {
                id: 'layer-1',
                label: title,
                name: sanitizeFieldName(title).slice(0, 40) || 'analysis',
                geometryType: hasGeometry ? layer.geometryType : null,
                fields,
                editingEnabled: true,
              },
            ],
          },
        }),
      });
      if (!createRes.ok) {
        throw new Error(
          `Could not create the layer (${createRes.status}): ${await createRes
            .text()
            .catch(() => '')}`,
        );
      }
      const created = (await createRes.json()) as { id: string };

      const form = new FormData();
      form.append(
        'file',
        new File([bytes as BlobPart], 'analysis.parquet'),
      );
      const importRes = await fetch(
        `/api/portal/items/${created.id}/layers/layer-1/import?mode=replace`,
        { method: 'POST', body: form },
      );
      if (!importRes.ok) {
        // The empty item exists at this point; say so instead of
        // silently deleting work the user may want to retry into.
        throw new Error(
          `The layer was created but loading the rows failed (${importRes.status}). Open the new item to retry the import.`,
        );
      }
      toast.success(`Layer "${title}" created`);
      router.push(`/items/${created.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      // Scratch file cleanup is best-effort; the WASM FS dies with
      // the tab anyway.
      void getDuckDb()
        .then((db) => db.dropFile(outFile))
        .catch(() => undefined);
      setSaveBusy(false);
    }
  }

  const execute = useCallback(async (statement: string) => {
    const conn = connRef.current;
    if (!conn) return;
    setRunning(true);
    setQueryError(null);
    try {
      setResult(await runQuery(conn, statement));
    } catch (err) {
      setResult(null);
      setQueryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let conn: AsyncDuckDBConnection | null = null;
    (async () => {
      try {
        setPhase({ kind: 'booting', step: 'Starting the in-browser engine' });
        conn = await registerParquetView({
          fileName: `layer-${itemId}-${layer.id}.parquet`,
          viewName,
          bytes: async () => {
            if (!cancelled) {
              setPhase({ kind: 'booting', step: 'Downloading layer data' });
            }
            const res = await fetch(
              `/api/portal/items/${itemId}/layers/${layer.id}/geoparquet`,
            );
            if (!res.ok) {
              throw new Error(
                res.status === 403
                  ? 'Analyzing needs download permission on this layer.'
                  : `Layer download failed (${res.status})`,
              );
            }
            return new Uint8Array(await res.arrayBuffer());
          },
        });
        if (cancelled) return;
        connRef.current = conn;
        setPhase({ kind: 'ready' });
        // Kick off the preview so the panel opens showing data, not
        // an empty grid waiting for input.
        await execute(`SELECT * FROM "${viewName}" LIMIT 100`);
      } catch (err) {
        if (!cancelled) {
          setPhase({
            kind: 'boot-error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      connRef.current = null;
      // Close asynchronously; nothing depends on the teardown.
      void conn?.close().catch(() => undefined);
    };
    // execute is stable (useCallback with no deps).
  }, [itemId, layer.id, viewName, execute]);

  const countField = firstTextField(layer);
  const starters: Array<{ label: string; sql: string }> = [
    { label: 'Preview', sql: `SELECT * FROM "${viewName}" LIMIT 100` },
    // SUMMARIZE is DuckDB's built-in per-column profile: min / max /
    // distinct counts / null fraction in one click, the fastest
    // possible "what is in this layer" answer.
    { label: 'Column profile', sql: `SUMMARIZE "${viewName}"` },
    ...(countField !== null
      ? [
          {
            label: `Count by ${countField}`,
            sql: `SELECT "${countField}", count(*) AS features\nFROM "${viewName}"\nGROUP BY 1\nORDER BY features DESC`,
          },
        ]
      : []),
  ];

  if (phase.kind === 'boot-error') {
    return (
      <div className="flex items-start gap-1.5 border-t border-border bg-danger/5 px-3 py-2 text-2xs text-danger">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{phase.message}</span>
      </div>
    );
  }

  if (phase.kind === 'booting') {
    return (
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-2xs text-muted">
        <Loader2 className="h-3 w-3 animate-spin" />
        {phase.step}…
      </div>
    );
  }

  return (
    <div className="border-t border-border">
      <div className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-muted" aria-hidden />
          {starters.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                setSql(s.sql);
                void execute(s.sql);
              }}
              className="rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
            >
              {s.label}
            </button>
          ))}
          <span className="ml-auto text-2xs text-muted">
            Runs in your browser. The server never sees a query.
          </span>
        </div>
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void execute(sql);
            }
          }}
          rows={4}
          spellCheck={false}
          className="w-full resize-y rounded-md border border-border bg-surface-1 p-2 font-mono text-xs text-ink-0 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          aria-label="SQL query"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void execute(sql)}
            disabled={running}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-1 px-2.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            Run (Ctrl+Enter)
          </button>
          {result ? (
            <button
              type="button"
              onClick={() => {
                setSaveTitle(`${layer.label || layer.name} analysis`);
                setSaveOpen((v) => !v);
              }}
              disabled={running || saveBusy}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              title="Run this query server-free and keep the result as a new portal layer"
            >
              <Save className="h-3 w-3" />
              Save as layer
            </button>
          ) : null}
          {result ? (
            <span className="text-2xs text-muted">
              {result.rowCount.toLocaleString()} row
              {result.rowCount === 1 ? '' : 's'} in {result.elapsedMs} ms
              {result.truncated
                ? `; showing first ${RESULT_ROW_CAP.toLocaleString()}`
                : ''}
            </span>
          ) : null}
        </div>
        {saveOpen ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-1 p-2">
            <label className="text-2xs font-medium text-ink-1" htmlFor="analyze-save-title">
              New layer title
            </label>
            <input
              id="analyze-save-title"
              type="text"
              value={saveTitle}
              onChange={(e) => setSaveTitle(e.target.value)}
              className="h-7 min-w-56 flex-1 rounded border border-border bg-surface-0 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
            <button
              type="button"
              onClick={() => void saveAsLayer()}
              disabled={saveBusy || saveTitle.trim().length === 0}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-1 px-2.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
            >
              {saveBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {saveBusy ? 'Creating' : 'Create layer'}
            </button>
            <button
              type="button"
              onClick={() => setSaveOpen(false)}
              disabled={saveBusy}
              className="h-7 rounded-md border border-border bg-surface-1 px-2.5 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              Cancel
            </button>
            <p className="w-full text-2xs text-muted">
              The current query re-runs in your browser and the result
              becomes a private data layer you can share, map, and
              export like any other.
            </p>
          </div>
        ) : null}
        {queryError ? (
          <div className="flex items-start gap-1.5 rounded-md bg-danger/5 px-2 py-1.5 text-2xs text-danger">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="font-mono">{queryError}</span>
          </div>
        ) : null}
        {result && result.columns.length > 0 ? (
          <div className="max-h-80 overflow-auto rounded-md border border-border">
            <table className="w-full border-collapse text-left font-mono text-2xs">
              <thead className="sticky top-0 bg-surface-2">
                <tr>
                  {result.columns.map((c) => (
                    <th
                      key={c}
                      className="whitespace-nowrap border-b border-border px-2 py-1 font-semibold text-ink-0"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} className="odd:bg-surface-1">
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        className="max-w-64 truncate whitespace-nowrap border-b border-border/50 px-2 py-1 text-ink-1"
                        title={cell === null ? undefined : String(cell)}
                      >
                        {cell === null ? (
                          <span className="text-muted">null</span>
                        ) : (
                          String(cell)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="text-2xs text-muted">
          The layer is available as{' '}
          <span className="font-mono">&quot;{viewName}&quot;</span>. The
          geometry column is WKB binary for now; spatial functions arrive
          with the next update.
        </p>
      </div>
    </div>
  );
}

/** First string-typed field name, for the count-by starter. */
function firstTextField(layer: DataLayerSublayer): string | null {
  const f = (layer.fields ?? []).find((fl) => fl.type === 'string');
  return f?.name ?? null;
}

/**
 * Mirror of the server importer's geometry-column fallback: a BLOB
 * column with a conventional geometry name is WKB. Results that keep
 * the source's geometry column match this exactly, so the saved
 * parquet round-trips through the same server path a hand-uploaded
 * file would.
 */
function isWkbGeometryColumn(name: string, type: string): boolean {
  return (
    baseType(type) === 'BLOB' &&
    ['geometry', 'geom', 'wkb_geometry'].includes(name.toLowerCase())
  );
}

/** "DECIMAL(10,2)" to "DECIMAL". */
function baseType(t: string): string {
  return t.trim().toUpperCase().replace(/\(.*$/, '').trim();
}

const NUMERIC_BASE_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'UHUGEINT',
  'FLOAT',
  'DOUBLE',
  'REAL',
  'DECIMAL',
  'NUMERIC',
  'VARINT',
  'BIGNUM',
]);

/** DuckDB column type to portal field type; token-based like the
 *  server-side mapping so INTERVAL does not misfile as number. */
function duckdbTypeToFieldType(t: string): FeatureField['type'] {
  const base = baseType(t);
  if (NUMERIC_BASE_TYPES.has(base)) return 'number';
  if (base === 'BOOLEAN' || base === 'BOOL') return 'boolean';
  if (base === 'DATE' || base.startsWith('TIMESTAMP') || base.startsWith('TIME')) {
    return 'date';
  }
  return 'string';
}

/** Field names must satisfy the schema validator ([a-z0-9_], not
 *  starting with a digit). Derived from whatever the user aliased
 *  their result columns to, so normalize hard and keep it stable. */
function sanitizeFieldName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f_$1');
  return cleaned.length > 0 ? cleaned : 'field';
}
