// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Housekeeping "Orphaned uploads" card.
 *
 * Surfaces the dry-run report from GET
 * /admin/housekeeping/orphaned-uploads: files sitting in object
 * storage that no attachment row, item, or icon points at anymore,
 * older than the server's age floor. Crashed imports and abandoned
 * upload wizards are the usual culprits; a failed best-effort
 * delete when a row was removed is the other.
 *
 * Two-step destructive flow on purpose: the card always shows the
 * counts first (the GET is read-only), and the delete is a second
 * explicit action behind its own confirm box that POSTs to
 * /purge. The server recomputes the orphan list at purge time, so
 * a report that sat open in a tab for a week cannot delete a file
 * that has since been attached to something.
 */
import { useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { formatBytes } from '@/lib/format-bytes';
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';

export interface OrphanedUploadsReport {
  unavailable: boolean;
  minAgeHours: number;
  perPrefix: Array<{
    prefix: string;
    objectCount: number;
    orphanCount: number;
    orphanBytes: number;
  }>;
  orphanCount: number;
  orphanBytes: number;
  sample: Array<{
    key: string;
    sizeBytes: number;
    lastModified: string | null;
  }>;
}

interface PurgeResult {
  unavailable: boolean;
  deletedCount: number;
  freedBytes: number;
  failedCount: number;
}

/** Human labels for the storage prefixes the sweep manages. Keys
 *  must match the API's ORPHAN_SWEEP_PREFIXES; unknown prefixes
 *  fall back to the raw prefix string so a future kind still
 *  renders something sensible before this map learns about it. */
const PREFIX_KEYS: Record<string, string> = {
  'feature-attachment': 'prefixFeatureAttachment',
  'item-file': 'prefixItemFile',
  'item-tile-layer': 'prefixItemTileLayer',
  'item-point-cloud': 'prefixItemPointCloud',
  'map-icon': 'prefixMapIcon',
};

interface Props {
  initial: OrphanedUploadsReport;
}

export function OrphanedUploadsCard({ initial }: Props) {
  const fmt = useFormat();
  const t = useT();
  const [report, setReport] = useState<OrphanedUploadsReport>(initial);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'scan' | 'purge' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPurge, setLastPurge] = useState<PurgeResult | null>(null);

  async function rescan(): Promise<void> {
    setBusy('scan');
    setError(null);
    try {
      const res = await fetch('/api/portal/admin/housekeeping/orphaned-uploads', {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReport((await res.json()) as OrphanedUploadsReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminHousekeeping.errScanFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function purge(): Promise<void> {
    setBusy('purge');
    setError(null);
    try {
      const res = await fetch(
        '/api/portal/admin/housekeeping/orphaned-uploads/purge',
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLastPurge((await res.json()) as PurgeResult);
      setConfirming(false);
      // Refresh the counts so the card reflects the new reality.
      await rescan();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('adminHousekeeping.errDeleteFailed'));
    } finally {
      setBusy(null);
    }
  }

  const nonEmpty = report.perPrefix.filter((p) => p.orphanCount > 0);

  return (
    <section className="rounded-lg border border-border bg-surface-1 p-5 shadow-card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10 text-accent">
            <Trash2 className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">
              {t('adminHousekeeping.orphanedTitle')}
            </h2>
            <p className="text-xs text-muted">
              {t('adminHousekeeping.orphanedIntro', {
                hours: report.minAgeHours,
              })}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void rescan()}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs text-ink-0 hover:bg-surface-2 disabled:opacity-50"
        >
          {busy === 'scan' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('adminHousekeeping.orphanedRescan')}
        </button>
      </div>

      {error ? (
        <p className="mb-3 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}

      {lastPurge ? (
        <p className="mb-3 rounded border border-border bg-surface-2 px-3 py-2 text-xs">
          {t('adminHousekeeping.orphanedPurgeSummary', {
            count: lastPurge.deletedCount,
            bytes: formatBytes(lastPurge.freedBytes),
          })}
          {lastPurge.failedCount > 0
            ? t('adminHousekeeping.orphanedPurgePartial', {
                failed: fmt.number(lastPurge.failedCount),
              })
            : ''}
        </p>
      ) : null}

      {report.unavailable ? (
        <p className="text-sm text-muted">
          {t('adminHousekeeping.orphanedUnavailable')}
        </p>
      ) : report.orphanCount === 0 ? (
        <p className="text-sm text-muted">
          {t('adminHousekeeping.orphanedEmpty')}
        </p>
      ) : (
        <>
          <table className="mb-3 w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="py-1.5 pr-2 font-medium">
                  {t('adminHousekeeping.orphanedColKind')}
                </th>
                <th className="py-1.5 pr-2 text-right font-medium">
                  {t('adminHousekeeping.orphanedColFiles')}
                </th>
                <th className="py-1.5 text-right font-medium">
                  {t('adminHousekeeping.orphanedColSize')}
                </th>
              </tr>
            </thead>
            <tbody>
              {nonEmpty.map((p) => (
                <tr key={p.prefix} className="border-b border-border/60">
                  <td className="py-1.5 pr-2">
                    {PREFIX_KEYS[p.prefix]
                      ? t(`adminHousekeeping.${PREFIX_KEYS[p.prefix]}`)
                      : p.prefix}
                  </td>
                  <td className="py-1.5 pr-2 text-right font-mono">
                    {fmt.number(p.orphanCount)}
                  </td>
                  <td className="py-1.5 text-right font-mono">
                    {formatBytes(p.orphanBytes)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-1.5 pr-2 font-medium">
                  {t('adminHousekeeping.orphanedTotal')}
                </td>
                <td className="py-1.5 pr-2 text-right font-mono font-medium">
                  {fmt.number(report.orphanCount)}
                </td>
                <td className="py-1.5 text-right font-mono font-medium">
                  {formatBytes(report.orphanBytes)}
                </td>
              </tr>
            </tbody>
          </table>

          {report.sample.length > 0 ? (
            <details className="mb-3 text-xs text-muted">
              <summary className="cursor-pointer select-none">
                {t('adminHousekeeping.orphanedShowSample', {
                  shown: report.sample.length,
                  total: fmt.number(report.orphanCount),
                })}
              </summary>
              <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto font-mono">
                {report.sample.map((s) => (
                  <li key={s.key} className="truncate">
                    {s.key} ({formatBytes(s.sizeBytes)})
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {confirming ? (
            <div className="rounded border border-danger/40 bg-danger/5 p-3">
              <p className="mb-2 flex items-start gap-1.5 text-xs text-danger">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {t('adminHousekeeping.orphanedConfirm', {
                    count: report.orphanCount,
                    bytes: formatBytes(report.orphanBytes),
                  })}
                </span>
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void purge()}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded bg-danger px-2.5 py-1.5 text-xs font-medium text-white hover:bg-danger/90 disabled:opacity-50"
                >
                  {busy === 'purge' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  {t('adminHousekeeping.orphanedConfirmYes')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy !== null}
                  className="rounded border border-border px-2.5 py-1.5 text-xs hover:bg-surface-2 disabled:opacity-50"
                >
                  {t('adminHousekeeping.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded border border-danger/40 px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/5 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('adminHousekeeping.orphanedDeleteButton', {
                count: report.orphanCount,
              })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
