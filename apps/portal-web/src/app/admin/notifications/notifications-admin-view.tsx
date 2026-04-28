'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCcw,
  RotateCw,
} from 'lucide-react';

export interface Stats {
  queueDepth: number;
  failedTotal: number;
  sentLast24h: number;
  failedLast24h: number;
  avgLatencyMs: number | null;
  byType: Array<{
    type: string;
    label: string;
    queued: number;
    sent: number;
    failed: number;
  }>;
}

export interface RecentRow {
  id: string;
  type: string;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  address: string;
  attempts: number;
  lastError: string | null;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
}

interface Props {
  initialStats: Stats;
  initialRecent: RecentRow[];
}

/**
 * Admin notifications dashboard view (#130). Shows the four
 * top-line metrics, the per-type rollup, and the recent-activity
 * list with per-row Retry on failed rows. The Refresh button at
 * the top re-fetches both stats + recent in one round-trip-pair
 * so the page stays current without a full reload.
 *
 * Optimistic Retry: clicking Retry flips the local row to "queued"
 * with attempts: 0, then PUTs. On error we revert. The server-side
 * retry is idempotent on already-non-failed rows so a double-click
 * doesn't cause weird state.
 */
export function NotificationsAdminView({
  initialStats,
  initialRecent,
}: Props) {
  const [stats, setStats] = useState<Stats>(initialStats);
  const [recent, setRecent] = useState<RecentRow[]>(initialRecent);
  const [refreshing, setRefreshing] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const [s, r] = await Promise.all([
        fetch('/api/portal/admin/notifications/stats').then(
          (res) => res.json() as Promise<Stats>,
        ),
        fetch('/api/portal/admin/notifications/recent').then(
          (res) => res.json() as Promise<RecentRow[]>,
        ),
      ]);
      setStats(s);
      setRecent(r);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Refresh failed; try again.',
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function retry(id: string) {
    setRetryingId(id);
    setError(null);
    // Optimistic: flip the row to queued so the UI confirms instantly.
    const prev = recent;
    setRecent((cur) =>
      cur.map((r) =>
        r.id === id
          ? { ...r, status: 'queued', attempts: 0, lastError: null }
          : r,
      ),
    );
    try {
      const res = await fetch(
        `/api/portal/admin/notifications/${id}/retry`,
        { method: 'POST' },
      );
      if (!res.ok) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
      // Re-pull stats so the queueDepth / failedTotal counters
      // reflect the change.
      const s = (await fetch(
        '/api/portal/admin/notifications/stats',
      ).then((r) => r.json())) as Stats;
      setStats(s);
    } catch (err) {
      setRecent(prev);
      setError(
        err instanceof Error ? err.message : 'Retry failed; try again.',
      );
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end gap-2">
        {error ? (
          <span
            className="text-xs text-danger"
            role="alert"
          >
            {error}
          </span>
        ) : null}
        <button
          type="button"
          disabled={refreshing}
          onClick={() => void refresh()}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
      </div>

      {/* Top-line metrics. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          icon={<Clock className="h-4 w-4" />}
          label="Queue depth"
          value={stats.queueDepth.toLocaleString()}
          tone={stats.queueDepth > 100 ? 'warn' : 'normal'}
          help="Queued + sending"
        />
        <Metric
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Sent (24h)"
          value={stats.sentLast24h.toLocaleString()}
          tone="normal"
        />
        <Metric
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Failed (24h)"
          value={stats.failedLast24h.toLocaleString()}
          tone={stats.failedLast24h > 0 ? 'warn' : 'normal'}
          help={
            stats.failedTotal > stats.failedLast24h
              ? `${stats.failedTotal} total since launch`
              : undefined
          }
        />
        <Metric
          icon={<Clock className="h-4 w-4" />}
          label="Avg latency"
          value={
            stats.avgLatencyMs === null
              ? '-'
              : formatLatency(stats.avgLatencyMs)
          }
          tone="normal"
          help="Create -> sent (24h)"
        />
      </div>

      {/* Per-type rollup. */}
      <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
          By type
        </h2>
        <table className="min-w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="pb-1 text-left font-medium">Type</th>
              <th className="pb-1 text-right font-medium">Queued</th>
              <th className="pb-1 text-right font-medium">Sent</th>
              <th className="pb-1 text-right font-medium">Failed</th>
            </tr>
          </thead>
          <tbody>
            {stats.byType.map((row) => (
              <tr key={row.type} className="border-t border-border">
                <td className="py-1.5 text-ink-1">{row.label}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {row.queued.toLocaleString()}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {row.sent.toLocaleString()}
                </td>
                <td
                  className={`py-1.5 text-right tabular-nums ${
                    row.failed > 0 ? 'text-amber-700' : ''
                  }`}
                >
                  {row.failed.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Recent activity. */}
      <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
          Recent activity
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-muted">
            No notifications yet. Once the platform fires a trigger,
            rows will appear here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="pb-1 text-left font-medium">Type</th>
                  <th className="pb-1 text-left font-medium">Address</th>
                  <th className="pb-1 text-left font-medium">Status</th>
                  <th className="pb-1 text-left font-medium">Created</th>
                  <th className="pb-1 text-left font-medium">Sent</th>
                  <th className="pb-1 text-left font-medium">Attempts</th>
                  <th className="pb-1 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => {
                  const failed = row.status === 'failed';
                  return (
                    <tr key={row.id} className="border-t border-border">
                      <td className="py-1.5 align-top text-ink-1">
                        {row.type}
                      </td>
                      <td className="py-1.5 align-top">{row.address}</td>
                      <td className="py-1.5 align-top">
                        <StatusBadge status={row.status} />
                        {failed && row.lastError ? (
                          <p
                            className="mt-0.5 max-w-xs truncate text-[11px] text-amber-800"
                            title={row.lastError}
                          >
                            {row.lastError}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-1.5 align-top tabular-nums">
                        {formatRel(row.createdAt)}
                      </td>
                      <td className="py-1.5 align-top tabular-nums">
                        {row.sentAt ? formatRel(row.sentAt) : '-'}
                      </td>
                      <td className="py-1.5 align-top tabular-nums">
                        {row.attempts}
                      </td>
                      <td className="py-1.5 text-right align-top">
                        {failed ? (
                          <button
                            type="button"
                            disabled={retryingId === row.id}
                            onClick={() => void retry(row.id)}
                            className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-0.5 text-[11px] font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                          >
                            {retryingId === row.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCw className="h-3 w-3" />
                            )}
                            Retry
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  tone,
  help,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'normal' | 'warn';
  help?: string | undefined;
}) {
  return (
    <div
      className={`rounded-lg border bg-surface-1 p-4 shadow-card ${
        tone === 'warn' ? 'border-amber-300' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted">
        {icon}
        {label}
      </div>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-ink-0">
        {value}
      </p>
      {help ? <p className="mt-0.5 text-[11px] text-muted">{help}</p> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: RecentRow['status'] }) {
  const tone =
    status === 'sent'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'failed'
        ? 'bg-amber-100 text-amber-900'
        : status === 'sending'
          ? 'bg-sky-100 text-sky-800'
          : 'bg-surface-2 text-muted';
  return (
    <span
      className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}
    >
      {status}
    </span>
  );
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return new Date(iso).toLocaleString();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
