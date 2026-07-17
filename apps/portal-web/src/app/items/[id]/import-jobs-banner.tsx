// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  X,
} from 'lucide-react';

/**
 * Detail-page banner that polls /items/:id/import-jobs/active and
 * renders one row per in-flight job (#115). Replaces the old wizard-
 * blocking modal: the user lands on the detail page immediately and
 * watches the import drain here while still being free to navigate
 * around the page.
 *
 * Behavior:
 *   - Polls every 2.5s while at least one job is active.
 *   - When the active set drops to zero (after being non-empty), fires
 *     router.refresh() once so the SSR-rendered feature counts and
 *     bbox preview pick up the freshly-imported rows.
 *   - Surfaces failed/succeeded transitions for ~10s after they
 *     terminate so the user actually sees the "Done" or "Failed"
 *     message instead of the row vanishing on the next poll.
 *   - Cancel button on each running/queued row.
 *
 * The banner self-hides when there's nothing to show. It does NOT
 * paginate or scroll: a typical create flow has 1-3 layers, so a
 * vertical stack reads fine.
 */

interface ImportJobWire {
  id: string;
  itemId: string;
  layerId: string;
  sourceFileName: string;
  sourceLayerName: string;
  mode: 'replace' | 'append';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  totalFeatures: number | null;
  processedFeatures: number;
  insertedFeatures: number;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
}

const POLL_MS = 2500;
const TERMINAL_DISPLAY_MS = 10_000;

interface Props {
  itemId: string;
}

export function ImportJobsBanner({ itemId }: Props) {
  const router = useRouter();
  const [activeJobs, setActiveJobs] = useState<ImportJobWire[]>([]);
  // Terminal jobs we keep visible briefly after they leave the active
  // list so the user sees the success/failure state. Keyed by job id;
  // we GC each entry after TERMINAL_DISPLAY_MS.
  const [recentTerminal, setRecentTerminal] = useState<
    Map<string, { job: ImportJobWire; clearedAt: number }>
  >(new Map());
  const sawActiveRef = useRef(false);
  const cancelInFlightRef = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/portal/items/${itemId}/import-jobs/active`,
        { cache: 'no-store' },
      );
      if (!res.ok) return;
      const next = (await res.json()) as ImportJobWire[];
      setActiveJobs((prev) => {
        // Surface jobs that just left the active list as terminal
        // chips so the user actually sees the outcome before they
        // disappear. The active endpoint returns queued+running
        // only, so a job missing from `next` has finished.
        const nextIds = new Set(next.map((j) => j.id));
        const justFinished = prev.filter((j) => !nextIds.has(j.id));
        if (justFinished.length > 0) {
          // Refetch each finished job to get the terminal status +
          // counts (the active endpoint can't tell us; we need a
          // direct GET). Done out-of-band so the poller stays cheap.
          void Promise.all(
            justFinished.map((j) =>
              fetch(`/api/portal/import-jobs/${j.id}`, {
                cache: 'no-store',
              })
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null),
            ),
          ).then((results) => {
            const now = Date.now();
            setRecentTerminal((cur) => {
              const out = new Map(cur);
              for (let i = 0; i < results.length; i += 1) {
                const r = results[i] as ImportJobWire | null;
                const fallback = justFinished[i];
                if (fallback === undefined) continue;
                const job = r ?? fallback;
                out.set(job.id, { job, clearedAt: now });
              }
              return out;
            });
          });
        }
        return next;
      });
    } catch {
      // Network blips are non-fatal; the next tick will retry.
    }
  }, [itemId]);

  // Kick off the poll loop. Always poll once on mount so we don't
  // leave the user staring at an empty banner if the wizard just
  // fired and-and-navigated; the first response paints the rows.
  useEffect(() => {
    let cancelled = false;
    void poll();
    const id = setInterval(() => {
      if (!cancelled) void poll();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [poll]);

  // Stamp the moment we first see at least one active job; when we
  // come back to zero, fire a single router.refresh() so the SSR
  // feature counts on the page pick up the new rows.
  useEffect(() => {
    if (activeJobs.length > 0) {
      sawActiveRef.current = true;
    } else if (sawActiveRef.current) {
      sawActiveRef.current = false;
      router.refresh();
    }
  }, [activeJobs.length, router]);

  // Garbage-collect terminal entries after their display window. A
  // single timer is set per change; entries past their clearedAt +
  // TERMINAL_DISPLAY_MS get dropped.
  useEffect(() => {
    if (recentTerminal.size === 0) return undefined;
    const t = setTimeout(() => {
      setRecentTerminal((cur) => {
        const now = Date.now();
        const out = new Map<
          string,
          { job: ImportJobWire; clearedAt: number }
        >();
        for (const [id, entry] of cur) {
          if (now - entry.clearedAt < TERMINAL_DISPLAY_MS) {
            out.set(id, entry);
          }
        }
        return out;
      });
    }, TERMINAL_DISPLAY_MS + 250);
    return () => clearTimeout(t);
  }, [recentTerminal]);

  const cancelJob = useCallback(
    async (jobId: string) => {
      if (cancelInFlightRef.current.has(jobId)) return;
      cancelInFlightRef.current.add(jobId);
      try {
        await fetch(`/api/portal/import-jobs/${jobId}/cancel`, {
          method: 'POST',
        });
        // Optimistic: re-poll immediately so the UI flips fast.
        await poll();
      } catch {
        // Swallow; next tick will reconcile.
      } finally {
        cancelInFlightRef.current.delete(jobId);
      }
    },
    [poll],
  );

  const terminalJobs = Array.from(recentTerminal.values()).map((e) => e.job);
  if (activeJobs.length === 0 && terminalJobs.length === 0) return null;

  return (
    <div
      className="mb-4 rounded-md border border-accent/30 bg-accent/5 px-4 py-3"
      role="status"
      aria-live="polite"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-0">
        {activeJobs.length > 0 ? (
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        ) : null}
        <span>
          {activeJobs.length > 0
            ? activeJobs.length === 1
              ? 'Importing 1 layer'
              : `Importing ${activeJobs.length} layers`
            : 'Imports finished'}
        </span>
      </div>
      <ul className="space-y-1.5">
        {activeJobs.map((job) => (
          <ImportJobRow
            key={job.id}
            job={job}
            onCancel={() => void cancelJob(job.id)}
          />
        ))}
        {terminalJobs.map((job) => (
          <ImportJobRow key={job.id} job={job} onCancel={null} terminal />
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  job: ImportJobWire;
  onCancel: (() => void) | null;
  terminal?: boolean;
}

function ImportJobRow({ job, onCancel, terminal = false }: RowProps) {
  const total = job.totalFeatures ?? 0;
  const inserted = job.insertedFeatures;
  const pct =
    total > 0 ? Math.min(100, Math.round((inserted / total) * 100)) : null;

  let statusEl: React.ReactNode;
  let detail: string;
  if (job.status === 'queued') {
    statusEl = <Loader2 className="h-3.5 w-3.5 text-muted" />;
    detail =
      total > 0 ? `Queued (${total.toLocaleString()} features)` : 'Queued';
  } else if (job.status === 'running') {
    statusEl = <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />;
    if (pct !== null) {
      detail = `Loaded ${inserted.toLocaleString()} of ${total.toLocaleString()} (${pct}%)`;
    } else if (inserted > 0) {
      detail = `Loaded ${inserted.toLocaleString()} features`;
    } else {
      detail = 'Starting…';
    }
  } else if (job.status === 'succeeded') {
    statusEl = <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
    detail = `Done — loaded ${inserted.toLocaleString()} features`;
  } else if (job.status === 'failed') {
    statusEl = <AlertTriangle className="h-3.5 w-3.5 text-danger" />;
    detail = `Failed: ${job.errorMessage ?? 'unknown error'}`;
  } else {
    statusEl = <X className="h-3.5 w-3.5 text-muted" />;
    detail = 'Cancelled';
  }

  return (
    <li className="rounded border border-border bg-surface-1 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">{statusEl}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-ink-0">
              {job.sourceLayerName}
            </span>
            <span className="text-2xs text-muted">
              from {job.sourceFileName}
            </span>
          </div>
          <div
            className={
              job.status === 'failed'
                ? 'mt-0.5 text-2xs text-danger'
                : 'mt-0.5 text-2xs text-muted'
            }
          >
            {detail}
          </div>
          {!terminal &&
          job.status === 'running' &&
          pct !== null ? (
            <div className="mt-1 h-1 w-full overflow-hidden rounded bg-surface-2">
              <div
                className="h-full bg-accent transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          ) : null}
        </div>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded border border-border bg-surface-0 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </li>
  );
}
