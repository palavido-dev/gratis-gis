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
 * Unit 1 is attributes only: the geometry column is present as WKB
 * binary but there are no spatial functions yet; the spatial
 * extension (self-hosted, air-gap rules) is the next unit, and
 * saving results back as a portal layer follows it.
 *
 * Deliberately a workbench, not a wizard: a query box, a result
 * grid, and a few one-click starters. The audience for this panel
 * reads SQL; the guided experience belongs to the tool builder.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Play, Sparkles } from 'lucide-react';
import type { DataLayerSublayer } from '@gratis-gis/shared-types';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import {
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
            <span className="text-2xs text-muted">
              {result.rowCount.toLocaleString()} row
              {result.rowCount === 1 ? '' : 's'} in {result.elapsedMs} ms
              {result.truncated
                ? `; showing first ${RESULT_ROW_CAP.toLocaleString()}`
                : ''}
            </span>
          ) : null}
        </div>
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
