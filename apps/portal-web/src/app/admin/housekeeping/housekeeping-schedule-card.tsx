'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Loader2,
  PlayCircle,
  Save,
} from 'lucide-react';

export interface HousekeepingConfig {
  autoTrashEnabled: boolean;
  autoTrashDays: number;
  autoDisableEnabled: boolean;
  autoDisableDays: number;
  scheduleMode: 'off' | 'daily' | 'weekly';
  scheduleHour: number;
  scheduleMinute: number;
  scheduleDayOfWeek: number | null;
  scheduleSummary: string;
  effectiveCron: string | null;
}

export interface HousekeepingRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  trigger: 'manual' | 'scheduled';
  itemsTrashed: number;
  usersDisabled: number;
  error: string | null;
}

interface Props {
  initialConfig: HousekeepingConfig;
  initialRuns: HousekeepingRun[];
}

const DAYS_OF_WEEK = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

/**
 * Configures the scheduled housekeeping pass and surfaces the most
 * recent runs. Pure CRUD against /api/admin/housekeeping/{config,
 * runs, run}; AdminGuard on the API enforces the role gate.
 *
 * The two auto-actions (trash stale items, disable quiet users) are
 * gated by separate checkboxes so an admin can opt into one without
 * the other. The schedule itself only registers a cron when at least
 * one action is enabled and scheduleMode != 'off' (the API computes
 * `effectiveCron` accordingly).
 */
export function HousekeepingScheduleCard({
  initialConfig,
  initialRuns,
}: Props) {
  const router = useRouter();
  const [config, setConfig] = useState<HousekeepingConfig>(initialConfig);
  const [runs, setRuns] = useState<HousekeepingRun[]>(initialRuns);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof HousekeepingConfig>(
    key: K,
    value: HousekeepingConfig[K],
  ) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/portal/admin/housekeeping/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          autoTrashEnabled: config.autoTrashEnabled,
          autoTrashDays: config.autoTrashDays,
          autoDisableEnabled: config.autoDisableEnabled,
          autoDisableDays: config.autoDisableDays,
          scheduleMode: config.scheduleMode,
          scheduleHour: config.scheduleHour,
          scheduleMinute: config.scheduleMinute,
          scheduleDayOfWeek:
            config.scheduleMode === 'weekly'
              ? (config.scheduleDayOfWeek ?? 1)
              : null,
        }),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      const next = (await res.json()) as HousekeepingConfig;
      setConfig(next);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch('/api/portal/admin/housekeeping/run', {
        method: 'POST',
      });
      if (!res.ok) {
        setError(`Run failed: ${res.status} ${await res.text()}`);
        return;
      }
      const run = (await res.json()) as HousekeepingRun;
      setRuns((cur) => [run, ...cur].slice(0, 10));
      router.refresh();
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-1 p-5 shadow-card">
      <header className="mb-3 flex items-center gap-2">
        <CalendarClock className="h-5 w-5 text-accent" />
        <h2 className="text-base font-semibold tracking-tight">
          Scheduled cleanup
        </h2>
        <span className="ml-auto text-xs text-muted">
          {config.scheduleSummary}
          {config.effectiveCron ? (
            <span className="ml-2 font-mono text-[10px] text-muted">
              ({config.effectiveCron})
            </span>
          ) : null}
        </span>
      </header>
      <p className="mb-4 text-xs text-muted">
        Off by default. Opt in to either auto-trash or auto-disable
        and pick a cadence; the cron job runs both passes back to back
        on the schedule. Manual bulk-actions on the lists below keep
        working regardless.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <fieldset className="space-y-2 rounded-md border border-border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={config.autoTrashEnabled}
              onChange={(e) => set('autoTrashEnabled', e.target.checked)}
              className="h-4 w-4 rounded border-border text-accent focus:ring-accent/30"
            />
            Auto-trash stale items
          </label>
          <label className="block text-xs text-ink-1">
            Items with no edits and no shares older than{' '}
            <input
              type="number"
              min={1}
              max={3650}
              value={config.autoTrashDays}
              onChange={(e) =>
                set('autoTrashDays', Math.max(1, Number(e.target.value)))
              }
              disabled={!config.autoTrashEnabled}
              className="inline h-7 w-20 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
            />{' '}
            days. Soft-deleted; restorable from the trash.
          </label>
        </fieldset>

        <fieldset className="space-y-2 rounded-md border border-border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={config.autoDisableEnabled}
              onChange={(e) => set('autoDisableEnabled', e.target.checked)}
              className="h-4 w-4 rounded border-border text-accent focus:ring-accent/30"
            />
            Auto-disable quiet users
          </label>
          <label className="block text-xs text-ink-1">
            Non-admin users not seen for{' '}
            <input
              type="number"
              min={1}
              max={3650}
              value={config.autoDisableDays}
              onChange={(e) =>
                set('autoDisableDays', Math.max(1, Number(e.target.value)))
              }
              disabled={!config.autoDisableEnabled}
              className="inline h-7 w-20 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
            />{' '}
            days. Reversible from /admin/users.
          </label>
        </fieldset>
      </div>

      <fieldset className="mt-4 grid gap-2 rounded-md border border-border p-3 md:grid-cols-4">
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Cadence
          </span>
          <select
            value={config.scheduleMode}
            onChange={(e) =>
              set(
                'scheduleMode',
                e.target.value as HousekeepingConfig['scheduleMode'],
              )
            }
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Hour (0-23)
          </span>
          <input
            type="number"
            min={0}
            max={23}
            value={config.scheduleHour}
            onChange={(e) =>
              set(
                'scheduleHour',
                Math.min(23, Math.max(0, Number(e.target.value))),
              )
            }
            disabled={config.scheduleMode === 'off'}
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Minute (0-59)
          </span>
          <input
            type="number"
            min={0}
            max={59}
            value={config.scheduleMinute}
            onChange={(e) =>
              set(
                'scheduleMinute',
                Math.min(59, Math.max(0, Number(e.target.value))),
              )
            }
            disabled={config.scheduleMode === 'off'}
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Day (weekly)
          </span>
          <select
            value={config.scheduleDayOfWeek ?? 1}
            onChange={(e) =>
              set('scheduleDayOfWeek', Number(e.target.value))
            }
            disabled={config.scheduleMode !== 'weekly'}
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
          >
            {DAYS_OF_WEEK.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      {error ? (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded border border-danger/30 bg-danger/5 px-2 py-1 text-xs text-danger"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={runNow}
          disabled={running || saving}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PlayCircle className="h-3.5 w-3.5" />
          )}
          Run now
        </button>
        <div className="flex items-center gap-2">
          {savedFlash ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save schedule
          </button>
        </div>
      </div>

      {runs.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Recent runs
          </h3>
          <ul className="space-y-1">
            {runs.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-2 text-xs text-ink-1"
              >
                <span className="font-mono text-[11px] text-muted">
                  {new Date(r.startedAt).toLocaleString()}
                </span>
                <StatusPill status={r.status} />
                <span className="text-muted">
                  ({r.trigger})
                </span>
                <span>
                  trashed: {r.itemsTrashed}, disabled: {r.usersDisabled}
                </span>
                {r.error ? (
                  <span
                    className="truncate text-danger"
                    title={r.error}
                  >
                    {r.error}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function StatusPill({ status }: { status: HousekeepingRun['status'] }) {
  const cls =
    status === 'succeeded'
      ? 'bg-success/15 text-success'
      : status === 'failed'
        ? 'bg-danger/15 text-danger'
        : 'bg-warning/15 text-warning';
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {status}
    </span>
  );
}
