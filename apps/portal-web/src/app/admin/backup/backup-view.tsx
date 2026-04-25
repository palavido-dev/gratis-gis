'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  Info,
  Loader2,
  PlayCircle,
  Save,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';

import { RestoreDialog } from './restore-dialog';

/**
 * Effective config as returned by /admin/backup/config. Matches the
 * shape the service emits: presentation-friendly, with the schedule
 * already summarised as English.
 */
export interface BackupConfig {
  archiveDirectory: string;
  scheduleMode: 'off' | 'daily' | 'weekly' | 'monthly' | 'custom';
  scheduleHour: number;
  scheduleMinute: number;
  scheduleDayOfWeek: number | null;
  scheduleDayOfMonth: number | null;
  customCron: string | null;
  retentionCount: number;
  scheduleSummary: string;
  effectiveCron: string | null;
}

export interface BackupRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  filename: string | null;
  sizeBytes: string | null;
  trigger: string;
  startedBy: string | null;
  error: string | null;
}

interface Props {
  initialConfig: BackupConfig;
  initialRuns: BackupRun[];
  /** Portal display name, used as the confirm phrase on Restore. */
  orgName: string;
}

export function BackupView({ initialConfig, initialRuns, orgName }: Props) {
  const [config, setConfig] = useState<BackupConfig>(initialConfig);
  const [runs, setRuns] = useState<BackupRun[]>(initialRuns);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [restoringRun, setRestoringRun] = useState<BackupRun | null>(null);

  const reloadRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/portal/admin/backup/runs');
      if (!res.ok) return;
      const body = (await res.json()) as BackupRun[];
      setRuns(body);
    } catch {
      // Swallow; the next poll tick tries again.
    }
  }, []);

  // Poll while any run is still 'running'. Stops when nothing is in
  // flight so an idle page isn't hitting the API every few seconds.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const anyRunning = runs.some((r) => r.status === 'running');
    if (anyRunning && !pollRef.current) {
      pollRef.current = setInterval(reloadRuns, 3000);
    }
    if (!anyRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [runs, reloadRuns]);

  async function handleRunNow() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/admin/backup/runs', {
        method: 'POST',
      });
      if (!res.ok) {
        setError(`Could not start backup (HTTP ${res.status}).`);
        return;
      }
      await reloadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start backup.');
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    setError(null);
    try {
      const res = await fetch(`/api/portal/admin/backup/runs/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(`Could not delete (HTTP ${res.status}).`);
        return;
      }
      await reloadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete.');
    } finally {
      setDeleting(null);
      setConfirmingDelete(null);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsCard
        config={config}
        onSaved={(next) => setConfig(next)}
      />

      <section className="rounded-lg border border-border bg-surface-1">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-medium text-ink-0">Backup history</h2>
            <p className="text-xs text-muted">
              {config.scheduleMode === 'off' ? (
                <>
                  Automatic backups are turned off. Use "Run now" to take
                  one on demand.
                </>
              ) : (
                <>
                  {config.scheduleSummary}. Keeping the{' '}
                  <strong>{config.retentionCount}</strong> most recent
                  successful backups.
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={handleRunNow}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlayCircle className="h-4 w-4" />
            )}
            {running ? 'Starting…' : 'Run now'}
          </button>
        </header>

        {error ? (
          <div className="border-b border-danger/30 bg-danger/5 px-4 py-2 text-xs text-danger">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            {error}
          </div>
        ) : null}

        {runs.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">
            No backups yet. Click "Run now" to take your first one, or
            wait for the next scheduled run.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Took</th>
                <th className="px-4 py-2">Triggered by</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Size</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  confirming={confirmingDelete === r.id}
                  deleting={deleting === r.id}
                  onConfirmDelete={() => setConfirmingDelete(r.id)}
                  onCancelDelete={() => setConfirmingDelete(null)}
                  onDelete={() => handleDelete(r.id)}
                  onRestore={() => setRestoringRun(r)}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <WhatsIncluded />
      {restoringRun ? (
        <RestoreDialog
          runId={restoringRun.id}
          filename={restoringRun.filename ?? ''}
          orgName={orgName}
          onClose={() => setRestoringRun(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------
// Settings card: the editable replacement for the old read-only
// config panel. One form, one Save button, optimistic UI on the
// summary so the cron description updates the instant you tweak a
// picker rather than after the round trip.
// ---------------------------------------------------------------

function SettingsCard({
  config,
  onSaved,
}: {
  config: BackupConfig;
  onSaved: (next: BackupConfig) => void;
}) {
  const [draft, setDraft] = useState<BackupConfig>(config);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Keep the draft in sync if the upstream config ever changes from
  // underneath us (e.g. another admin saves). Comparing by stringify
  // is fine for this shape.
  useEffect(() => {
    setDraft(config);
  }, [config]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/portal/admin/backup/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          archiveDirectory: draft.archiveDirectory,
          scheduleMode: draft.scheduleMode,
          scheduleHour: draft.scheduleHour,
          scheduleMinute: draft.scheduleMinute,
          scheduleDayOfWeek:
            draft.scheduleMode === 'weekly' ? draft.scheduleDayOfWeek ?? 0 : null,
          scheduleDayOfMonth:
            draft.scheduleMode === 'monthly'
              ? draft.scheduleDayOfMonth ?? 1
              : null,
          customCron:
            draft.scheduleMode === 'custom' ? draft.customCron : null,
          retentionCount: draft.retentionCount,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          (body as { message?: string | string[] }).message ??
          `HTTP ${res.status}`;
        setSaveError(Array.isArray(msg) ? msg.join('; ') : msg);
        return;
      }
      const next = (await res.json()) as BackupConfig;
      onSaved(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : 'Could not save settings.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-1">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-ink-0">Settings</h2>
        <p className="text-xs text-muted">
          Control how often backups run and how many to keep. Changes
          apply the moment you click Save: no restart needed.
        </p>
      </header>

      <div className="space-y-5 px-4 py-4">
        {/* Schedule block. Mode picker drives which secondary fields show. */}
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-ink-0">
            Backup schedule
          </legend>
          <p className="mb-2 text-[11px] text-muted">
            How often the portal automatically takes a backup. You can
            also use "Run now" below any time to take one on demand.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={draft.scheduleMode}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  scheduleMode: e.target.value as BackupConfig['scheduleMode'],
                })
              }
              className="rounded border border-border bg-surface-0 px-2 py-1 text-sm"
            >
              <option value="off">Off (never automatically)</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
              <option value="custom">Custom schedule</option>
            </select>

            {draft.scheduleMode === 'weekly' ? (
              <>
                <span className="text-xs text-muted">on</span>
                <select
                  value={draft.scheduleDayOfWeek ?? 0}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      scheduleDayOfWeek: Number(e.target.value),
                    })
                  }
                  className="rounded border border-border bg-surface-0 px-2 py-1 text-sm"
                >
                  {[
                    'Sunday',
                    'Monday',
                    'Tuesday',
                    'Wednesday',
                    'Thursday',
                    'Friday',
                    'Saturday',
                  ].map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            {draft.scheduleMode === 'monthly' ? (
              <>
                <span className="text-xs text-muted">on day</span>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={draft.scheduleDayOfMonth ?? 1}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      scheduleDayOfMonth: clampInt(e.target.value, 1, 28, 1),
                    })
                  }
                  className="w-20 rounded border border-border bg-surface-0 px-2 py-1 text-sm"
                />
                <span className="text-[11px] text-muted">
                  (1-28 so it works in every month)
                </span>
              </>
            ) : null}

            {draft.scheduleMode === 'daily' ||
            draft.scheduleMode === 'weekly' ||
            draft.scheduleMode === 'monthly' ? (
              <>
                <span className="text-xs text-muted">at</span>
                <input
                  type="time"
                  value={`${String(draft.scheduleHour).padStart(2, '0')}:${String(
                    draft.scheduleMinute,
                  ).padStart(2, '0')}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(':').map(Number);
                    setDraft({
                      ...draft,
                      scheduleHour: clampInt(String(h ?? 0), 0, 23, 0),
                      scheduleMinute: clampInt(String(m ?? 0), 0, 59, 0),
                    });
                  }}
                  className="rounded border border-border bg-surface-0 px-2 py-1 text-sm"
                />
              </>
            ) : null}

            {draft.scheduleMode === 'custom' ? (
              <input
                type="text"
                value={draft.customCron ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, customCron: e.target.value })
                }
                placeholder="e.g. 0 2 * * *"
                className="w-56 rounded border border-border bg-surface-0 px-2 py-1 font-mono text-xs"
              />
            ) : null}
          </div>
          {draft.scheduleMode === 'custom' ? (
            <p className="mt-1 text-[11px] text-muted">
              5-field cron expression (minute hour day-of-month month
              day-of-week).
            </p>
          ) : null}
        </fieldset>

        {/* Retention. Plain number + an inline explanation. */}
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-ink-0">
            How many backups to keep
          </legend>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={1000}
              value={draft.retentionCount}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  retentionCount: clampInt(e.target.value, 1, 1000, 7),
                })
              }
              className="w-24 rounded border border-border bg-surface-0 px-2 py-1 text-sm"
            />
            <p className="text-[11px] text-muted">
              Older successful backups are removed once this many newer
              ones exist. Failed runs are kept so you can diagnose them
              and aren't counted against this number.
            </p>
          </div>
        </fieldset>

        {/* Advanced: archive directory. Folded away because 99% of
            admins shouldn't have to touch it. */}
        <div className="rounded border border-border bg-surface-0">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-2"
          >
            <span className="font-medium uppercase tracking-wide">
              Advanced
            </span>
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {advancedOpen ? (
            <div className="space-y-3 border-t border-border px-3 py-3">
              <div>
                <label className="block text-xs font-medium text-ink-0">
                  Where backups are saved
                </label>
                <p className="mb-1 text-[11px] text-muted">
                  Absolute path on the portal server. Leave blank to
                  use the deployment's default location.
                </p>
                <input
                  type="text"
                  value={draft.archiveDirectory}
                  onChange={(e) =>
                    setDraft({ ...draft, archiveDirectory: e.target.value })
                  }
                  className="w-full rounded border border-border bg-surface-0 px-2 py-1 font-mono text-xs"
                  placeholder="e.g. D:\\gratis-gis-backups"
                />
                <p className="mt-1 text-[10px] text-muted">
                  Moving this doesn't move existing backup files: any
                  backups in the old folder stay there (but won't show
                  in the list).
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {saveError ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            {saveError}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-2 rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Saved
            </span>
          ) : dirty ? (
            <span className="text-xs text-muted">Unsaved changes</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function clampInt(raw: string, lo: number, hi: number, fallback: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------
// Per-row history
// ---------------------------------------------------------------

function RunRow({
  run,
  confirming,
  deleting,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
  onRestore,
}: {
  run: BackupRun;
  confirming: boolean;
  deleting: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const started = new Date(run.startedAt);
  const finished = run.finishedAt ? new Date(run.finishedAt) : null;
  const durationMs = finished ? finished.getTime() - started.getTime() : null;
  const size = run.sizeBytes ? formatBytes(BigInt(run.sizeBytes)) : '-';
  const triggeredBy = run.trigger === 'scheduled' ? 'Scheduled' : 'Manual';

  return (
    <tr className="hover:bg-surface-2/50">
      <td className="px-4 py-2 text-ink-1">
        <span title={started.toISOString()}>{started.toLocaleString()}</span>
      </td>
      <td className="px-4 py-2 text-muted">
        {durationMs === null ? '-' : formatDuration(durationMs)}
      </td>
      <td className="px-4 py-2 text-muted">{triggeredBy}</td>
      <td className="px-4 py-2">
        <StatusBadge status={run.status} error={run.error} />
      </td>
      <td className="px-4 py-2 text-muted">{size}</td>
      <td className="px-4 py-2 text-right">
        {confirming ? (
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={onCancelDelete}
              disabled={deleting}
              className="rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className="inline-flex items-center gap-1 rounded border border-danger bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger hover:bg-danger/20 disabled:opacity-60"
            >
              {deleting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              Delete
            </button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            {run.status === 'succeeded' && run.filename ? (
              <>
                <a
                  href={`/api/portal/admin/backup/runs/${run.id}/download`}
                  className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2"
                >
                  <Download className="h-3 w-3" />
                  Download
                </a>
                <button
                  type="button"
                  onClick={onRestore}
                  className="inline-flex items-center gap-1 rounded border border-danger/40 bg-danger/5 px-2 py-0.5 text-[11px] font-medium text-danger hover:bg-danger/10"
                  title="Roll the whole portal back to this backup. Anything changed since then will be lost."
                >
                  <ShieldAlert className="h-3 w-3" />
                  Restore
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={onConfirmDelete}
              className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

function StatusBadge({
  status,
  error,
}: {
  status: BackupRun['status'];
  error: string | null;
}) {
  switch (status) {
    case 'running':
      return (
        <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
          <Loader2 className="h-3 w-3 animate-spin" />
          In progress
        </span>
      );
    case 'succeeded':
      return (
        <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">
          <CheckCircle2 className="h-3 w-3" />
          Success
        </span>
      );
    case 'failed':
      return (
        <span
          className="inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-800"
          title={error ?? undefined}
        >
          <XCircle className="h-3 w-3" />
          Failed
        </span>
      );
  }
}

function WhatsIncluded() {
  return (
    <section className="rounded-lg border border-border bg-surface-0 p-4">
      <header className="mb-2 flex items-center gap-2">
        <Info className="h-3.5 w-3.5 text-muted" />
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          What's in a backup
        </h3>
      </header>
      <ul className="list-inside list-disc space-y-1 text-xs text-ink-1">
        <li>
          <span className="font-medium">All your portal content</span>
          maps, layers, data, forms, groups, sharing settings, basemaps,
          branding, and the full revision history of feature data.
        </li>
        <li>
          <span className="font-medium">All uploaded files</span>
          item thumbnails, hero images, and every attachment on a
          feature (photos, PDFs, etc.).
        </li>
        <li>
          <span className="font-medium">Not included (yet):</span> user
          accounts, which are stored in the portal's identity provider
          and need a separate backup for now. Items keep a record of
          their owner's id, so restoring a backup onto a fresh
          deployment works as long as the same users are re-created.
        </li>
        <li>
          <span className="font-medium">Not included:</span> server
          secrets, SSL material, and Docker configuration: those live
          in your deployment repo or secret store.
        </li>
      </ul>
      <p className="mt-3 text-[11px] text-muted">
        Each backup is a single <code className="font-mono">.tar.gz</code>{' '}
        file in the folder shown under Advanced settings. You can copy
        them to external storage, object storage, or a backup service
        they're portable files.
      </p>
    </section>
  );
}

function formatBytes(n: bigint): string {
  if (n < 1024n) return `${n} B`;
  if (n < 1024n * 1024n) return `${(Number(n) / 1024).toFixed(0)} KB`;
  if (n < 1024n * 1024n * 1024n) return `${(Number(n) / 1024 / 1024).toFixed(1)} MB`;
  return `${(Number(n) / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}
