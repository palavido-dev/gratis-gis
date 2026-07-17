// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  Smartphone,
  Trash2,
} from 'lucide-react';

import { formatBytes } from '@/lib/offline-store';
import { useConfirm } from '@/components/dialog-provider';

/**
 * Per-deployment summary inside a single device's manifest. Mirrors
 * what the API returns; trimmed to what this page renders.
 *
 * The server enriches each entry with `dataCollectionTitle` (resolved
 * via Item.title) so the admin sees a human label rather than a raw
 * uuid. `dataCollectionDeleted` flips when the underlying item has
 * been soft-deleted, since the manifest mirror outlives item deletion
 * by design.
 */
export interface FieldQueueManifestEntry {
  dataCollectionId: string;
  dataCollectionTitle?: string | null;
  dataCollectionDeleted?: boolean;
  cachedAt: string | null;
  queuedRecords: Array<{
    id: string;
    op: 'insert' | 'update' | 'delete';
    layerId: string;
    queuedAt: string;
    status: 'pending' | 'failed';
    lastError?: string | null;
    attempts?: number;
  }>;
}

export interface FieldQueueRow {
  id: string;
  userId: string;
  username: string;
  email: string;
  fullName: string | null;
  deviceFingerprint: string;
  storageUsage: number | null;
  storageQuota: number | null;
  userAgent: string | null;
  reportedAt: string;
  manifest: FieldQueueManifestEntry[];
}

/**
 * Sort and render every device row. We don't try to roll up by user
 * here -- one user with two devices is two rows, deliberately, since
 * the device is the unit of state we can act on (no admin lever
 * mutates state remotely; the unit of recovery is "ask Alice to open
 * her iPad").
 */
/** #275 / #276: a manifest is "stale" when it has no queued records
 *  anywhere AND the last beacon was more than `staleAfterDays`
 *  ago. The threshold is configurable in the Housekeeping admin
 *  surface; the value reads from the server-rendered prop so the
 *  default-hide filter matches the bulk-forget cutoff on the
 *  API. */
function isStale(row: FieldQueueRow, staleAfterDays: number): boolean {
  if (countQueued(row) > 0) return false;
  const reportedMs = Date.now() - new Date(row.reportedAt).getTime();
  return reportedMs > staleAfterDays * 24 * 60 * 60 * 1000;
}

export function FieldQueuesView({
  rows,
  staleAfterDays,
}: {
  rows: FieldQueueRow[];
  /** #276: server-supplied threshold; matches the
   *  fieldQueueStaleDays setting on Housekeeping. Falls back to 7
   *  via the page-level fetch if the setting is unreachable. */
  staleAfterDays: number;
}) {
  const router = useRouter();
  const [showStale, setShowStale] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // row id being forgotten or 'bulk'
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const visibleRows = useMemo(() => {
    const filtered = showStale
      ? rows
      : rows.filter((r) => !isStale(r, staleAfterDays));
    // Stuck records first (urgent), then oldest report (silent
    // device, possibly worker hasn't opened the app in a while).
    return [...filtered].sort((a, b) => {
      const aStuck = countQueued(a);
      const bStuck = countQueued(b);
      if (aStuck !== bStuck) return bStuck - aStuck;
      return a.reportedAt.localeCompare(b.reportedAt);
    });
  }, [rows, showStale, staleAfterDays]);

  const staleCount = useMemo(
    () => rows.filter((r) => isStale(r, staleAfterDays)).length,
    [rows, staleAfterDays],
  );

  const forgetOne = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/portal/admin/field-queues/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to forget device',
      );
    } finally {
      setBusy(null);
    }
  };

  const forgetAllStale = async () => {
    if (staleCount === 0) return;
    const ok = await confirm({
      title: 'Forget stale device manifests?',
      message: `Forget ${staleCount} manifest${
        staleCount === 1 ? '' : 's'
      } with empty queues last seen ${staleAfterDays}+ days ago? Each device will re-register if it's still in use.`,
      variant: 'danger',
      confirmLabel: 'Forget stale',
    });
    if (!ok) return;
    setBusy('bulk');
    setError(null);
    try {
      const res = await fetch(
        '/api/portal/admin/field-queues/forget-stale',
        { method: 'POST' },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to forget stale',
      );
    } finally {
      setBusy(null);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-1 px-4 py-10 text-center text-sm text-muted">
        No field devices have reported in yet. Once a worker opens a
        deployment in field mode, their device will beacon a queue
        manifest here.
      </div>
    );
  }

  return (
    <>
      {/* #275: filter + bulk-forget controls. The default view hides
          rows whose queue is empty AND last reported >7 days ago,
          which is almost always "device that has since cleared its
          cache or stopped being used." Toggle reveals them; bulk
          button drops them all. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-1 px-4 py-2">
        <label className="inline-flex items-center gap-2 text-xs text-ink-1">
          <input
            type="checkbox"
            checked={showStale}
            onChange={(e) => setShowStale(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Show stale rows ({staleCount} hidden)
        </label>
        {staleCount > 0 ? (
          <button
            type="button"
            onClick={forgetAllStale}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-0 px-2.5 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === 'bulk' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            Forget all stale
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}

      {visibleRows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-1 px-4 py-10 text-center text-sm text-muted">
          {showStale
            ? 'No devices to show.'
            : `No active devices. Toggle "Show stale rows" to see manifests last beaconed >${staleAfterDays} days ago.`}
        </div>
      ) : (
        <ul className="space-y-3">
          {visibleRows.map((row) => (
            <DeviceRow
              key={row.id}
              row={row}
              onForget={() => void forgetOne(row.id)}
              forgetting={busy === row.id}
              disabled={busy !== null && busy !== row.id}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function DeviceRow({
  row,
  onForget,
  forgetting,
  disabled,
}: {
  row: FieldQueueRow;
  onForget: () => void;
  forgetting: boolean;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const confirm = useConfirm();
  const stuck = countQueued(row);
  const failed = countFailed(row);
  const oldest = oldestQueuedAt(row);
  const lastReportMs = Date.now() - new Date(row.reportedAt).getTime();
  const silent = lastReportMs > 1000 * 60 * 60 * 24 * 3; // > 3 days
  const usagePct =
    row.storageQuota && row.storageQuota > 0 && row.storageUsage !== null
      ? (row.storageUsage / row.storageQuota) * 100
      : null;
  const tightStorage = usagePct !== null && usagePct >= 90;

  return (
    <li className="rounded-lg border border-border bg-surface-1">
      <div className="flex items-stretch">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex flex-1 items-stretch gap-3 px-4 py-3 text-left hover:bg-surface-2"
      >
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent"
        >
          <Smartphone className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="truncate text-sm font-semibold text-ink-0">
              {row.fullName || row.username}
            </h2>
            <span className="text-xs text-muted">{row.email}</span>
          </div>
          <p className="mt-0.5 truncate text-2xs text-muted">
            {describeUserAgent(row.userAgent)} · device{' '}
            {row.deviceFingerprint.slice(0, 8)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs">
            {stuck > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 font-medium text-warn">
                <AlertTriangle className="h-3 w-3" />
                {stuck} queued
                {failed > 0 ? ` (${failed} failed)` : ''}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-success">
                Queue clear
              </span>
            )}
            {oldest ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-muted">
                Oldest queued: {formatRelative(oldest)}
              </span>
            ) : null}
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                silent
                  ? 'border-warn/30 bg-warn/10 text-warn'
                  : 'border-border bg-surface-2 text-muted'
              }`}
              title={new Date(row.reportedAt).toLocaleString()}
            >
              Last seen: {formatRelative(row.reportedAt)}
            </span>
            {usagePct !== null ? (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                  tightStorage
                    ? 'border-warn/30 bg-warn/10 text-warn'
                    : 'border-border bg-surface-2 text-muted'
                }`}
              >
                Storage: {formatBytes(row.storageUsage ?? 0)} /{' '}
                {formatBytes(row.storageQuota ?? 0)} ({usagePct.toFixed(0)}%)
              </span>
            ) : null}
          </div>
        </div>
        <ChevronRight
          className={`h-4 w-4 self-center text-muted transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {/* #275: per-row Forget. Pure metadata wipe -- record
          payloads live on the device, the row is just the beacon
          mirror. Next sync from that device re-creates the row. */}
      <button
        type="button"
        onClick={async (e) => {
          e.stopPropagation();
          const ok = await confirm({
            title: 'Forget this device manifest?',
            message: `Forget device ${row.deviceFingerprint.slice(
              0,
              8,
            )} for ${row.fullName || row.username}? This only removes the admin-side beacon record. The data on the device (${stuck} queued) is unaffected. The row will return on the next sync if the device is still in use.`,
            variant: 'danger',
            confirmLabel: 'Forget device',
          });
          if (!ok) return;
          onForget();
        }}
        disabled={disabled || forgetting}
        title="Forget this device manifest"
        aria-label="Forget device"
        className="flex shrink-0 items-center justify-center px-3 text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-50"
      >
        {forgetting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4" />
        )}
      </button>
      </div>

      {expanded ? (
        <div className="border-t border-border px-4 py-3">
          {row.manifest.length === 0 ? (
            <p className="text-xs text-muted">
              No deployments cached on this device.
            </p>
          ) : (
            <ul className="space-y-3">
              {row.manifest.map((entry) => (
                <DeploymentEntry
                  key={entry.dataCollectionId}
                  entry={entry}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

function DeploymentEntry({ entry }: { entry: FieldQueueManifestEntry }) {
  const queued = entry.queuedRecords.length;
  const failed = entry.queuedRecords.filter((r) => r.status === 'failed');
  // Prefer the server-resolved deployment title. If the item has been
  // soft-deleted we keep the title but tag it; if the lookup missed
  // entirely (cross-org or hard-deleted) we fall back to the uuid so
  // the admin can still copy it for forensic purposes.
  const title = entry.dataCollectionTitle?.trim() || null;
  const deleted = !!entry.dataCollectionDeleted;
  return (
    <li className="rounded-md border border-border bg-surface-0 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          {title ? (
            <Link
              href={`/items/${entry.dataCollectionId}`}
              className="block truncate text-sm font-medium text-ink-0 hover:text-accent"
              title={entry.dataCollectionId}
            >
              {title}
              {deleted ? (
                <span className="ml-2 text-2xs font-normal text-muted">
                  (deleted)
                </span>
              ) : null}
            </Link>
          ) : (
            <p
              className="truncate text-sm font-medium text-ink-1"
              title={entry.dataCollectionId}
            >
              Unknown deployment
            </p>
          )}
          <p
            className="mt-0.5 truncate font-mono text-2xs text-muted"
            title={entry.dataCollectionId}
          >
            {entry.dataCollectionId}
          </p>
        </div>
        <p className="shrink-0 text-2xs text-muted">
          {entry.cachedAt
            ? `cached ${formatRelative(entry.cachedAt)}`
            : 'no cache'}
        </p>
      </div>
      {queued === 0 ? (
        <p className="mt-1 text-2xs text-muted">No queued records.</p>
      ) : (
        <p className="mt-1 text-2xs text-ink-1">
          {queued} queued ({failed.length} failed)
        </p>
      )}
      {failed.length > 0 ? (
        <div className="mt-2 space-y-1">
          {failed.slice(0, 5).map((r) => (
            <div
              key={r.id}
              className="rounded border border-danger/20 bg-danger/5 px-2 py-1 text-2xs text-danger"
            >
              <span className="font-mono">{r.op}</span> · attempts{' '}
              {r.attempts ?? 0}
              {r.lastError ? <span> · {r.lastError}</span> : null}
            </div>
          ))}
          {failed.length > 5 ? (
            <p className="text-2xs text-muted">
              + {failed.length - 5} more failed records.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function countQueued(row: FieldQueueRow): number {
  return row.manifest.reduce((sum, e) => sum + e.queuedRecords.length, 0);
}

function countFailed(row: FieldQueueRow): number {
  return row.manifest.reduce(
    (sum, e) => sum + e.queuedRecords.filter((r) => r.status === 'failed').length,
    0,
  );
}

function oldestQueuedAt(row: FieldQueueRow): string | null {
  let oldest: string | null = null;
  for (const e of row.manifest) {
    for (const r of e.queuedRecords) {
      if (!oldest || (r.queuedAt && r.queuedAt < oldest)) {
        oldest = r.queuedAt;
      }
    }
  }
  return oldest;
}

/** Naive UA bucketing. Just enough to render "iPhone Safari" without
 *  pulling in a real UA-parser dependency for an admin view. */
function describeUserAgent(ua: string | null): string {
  if (!ua) return 'unknown device';
  const isiPhone = /iPhone/.test(ua);
  const isiPad = /iPad|Macintosh.*Mobile/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  const isChrome = /Chrome|Chromium/.test(ua) && !/Edg/.test(ua);
  const isFirefox = /Firefox/.test(ua);
  const isEdge = /Edg/.test(ua);

  const device = isiPhone
    ? 'iPhone'
    : isiPad
      ? 'iPad'
      : isAndroid
        ? 'Android'
        : 'Desktop';
  const browser = isEdge
    ? 'Edge'
    : isChrome
      ? 'Chrome'
      : isSafari
        ? 'Safari'
        : isFirefox
          ? 'Firefox'
          : 'browser';
  return `${device} ${browser}`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
