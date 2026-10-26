// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';

export interface HousekeepingConfig {
  autoTrashEnabled: boolean;
  autoTrashDays: number;
  autoDisableEnabled: boolean;
  autoDisableDays: number;
  /** Periodic recompute-extents pass (#93). Off by default. */
  recomputeExtentsEnabled: boolean;
  /** #276: stale threshold for the field-queues admin view + bulk
   *  forget endpoint. Defaults to 7. */
  fieldQueueStaleDays: number;
  /** #276: when on, the cron also auto-prunes field-queue rows
   *  with empty queues that have been silent past the threshold +
   *  grace window. Off by default. */
  fieldQueueAutoPruneEnabled: boolean;
  /** #276: extra days past the stale threshold the cron observes
   *  before deleting. Defaults to 90. */
  fieldQueueAutoPruneGraceDays: number;
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

const DAY_KEYS = [
  'daySunday',
  'dayMonday',
  'dayTuesday',
  'dayWednesday',
  'dayThursday',
  'dayFriday',
  'daySaturday',
] as const;

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
  const fmt = useFormat();
  const t = useT();
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
          recomputeExtentsEnabled: config.recomputeExtentsEnabled,
          fieldQueueStaleDays: config.fieldQueueStaleDays,
          fieldQueueAutoPruneEnabled: config.fieldQueueAutoPruneEnabled,
          fieldQueueAutoPruneGraceDays: config.fieldQueueAutoPruneGraceDays,
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
          {t('adminHousekeeping.scheduleTitle')}
        </h2>
        <span
          className="ml-auto text-xs text-muted"
          title={config.effectiveCron ?? undefined}
        >
          {config.scheduleSummary}
        </span>
      </header>
      <p className="mb-4 text-xs text-muted">
        {t('adminHousekeeping.scheduleIntro')}
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
            {t('adminHousekeeping.scheduleAutoTrash')}
          </label>
          <label className="block text-xs text-ink-1">
            {t('adminHousekeeping.scheduleAutoTrashBefore')}{' '}
            <input
              type="number"
              min={1}
              max={3650}
              value={config.autoTrashDays}
              onChange={(e) =>
                set('autoTrashDays', Math.max(1, Number(e.target.value)))
              }
              disabled={!config.autoTrashEnabled}
              className="inline h-7 w-20 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
            />{' '}
            {t('adminHousekeeping.scheduleAutoTrashAfter')}
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
            {t('adminHousekeeping.scheduleAutoDisable')}
          </label>
          <label className="block text-xs text-ink-1">
            {t('adminHousekeeping.scheduleAutoDisableBefore')}{' '}
            <input
              type="number"
              min={1}
              max={3650}
              value={config.autoDisableDays}
              onChange={(e) =>
                set('autoDisableDays', Math.max(1, Number(e.target.value)))
              }
              disabled={!config.autoDisableEnabled}
              className="inline h-7 w-20 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
            />{' '}
            {t('adminHousekeeping.scheduleAutoDisableAfter')}
          </label>
        </fieldset>

        <fieldset className="space-y-2 rounded-md border border-border p-3 md:col-span-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={config.recomputeExtentsEnabled}
              onChange={(e) =>
                set('recomputeExtentsEnabled', e.target.checked)
              }
              className="h-4 w-4 rounded border-border text-accent focus:ring-accent/30"
            />
            {t('adminHousekeeping.scheduleRecomputeExtents')}
          </label>
          <p className="block text-xs text-ink-1">
            {t('adminHousekeeping.scheduleRecomputeExtentsDetail')}
          </p>
        </fieldset>

        {/* #276: field-queue retention. Two knobs --
            staleDays drives the admin UI default-hide filter +
            the bulk-forget cutoff; autoPrune (off by default) lets
            the cron also delete rows older than staleDays + grace.
            Both span both columns since the explanatory copy is
            longer. */}
        <fieldset className="space-y-3 rounded-md border border-border p-3 md:col-span-2">
          <p className="text-sm font-medium">
            {t('adminHousekeeping.scheduleFieldQueueTitle')}
          </p>
          <label className="block text-xs text-ink-1">
            {t('adminHousekeeping.scheduleFieldQueueStaleBefore')}{' '}
            <input
              type="number"
              min={1}
              max={3650}
              value={config.fieldQueueStaleDays}
              onChange={(e) =>
                set(
                  'fieldQueueStaleDays',
                  Math.max(1, Number(e.target.value)),
                )
              }
              className="inline h-7 w-20 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
            />{' '}
            {t('adminHousekeeping.scheduleFieldQueueStaleAfter')}
          </label>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={config.fieldQueueAutoPruneEnabled}
              onChange={(e) =>
                set('fieldQueueAutoPruneEnabled', e.target.checked)
              }
              className="h-4 w-4 rounded border-border text-accent focus:ring-accent/30"
            />
            {t('adminHousekeeping.scheduleFieldQueueAutoPrune')}
          </label>
          <label className="block text-xs text-ink-1">
            {t('adminHousekeeping.scheduleFieldQueueAutoPruneBefore')}{' '}
            <input
              type="number"
              min={0}
              max={3650}
              value={config.fieldQueueAutoPruneGraceDays}
              onChange={(e) =>
                set(
                  'fieldQueueAutoPruneGraceDays',
                  Math.max(0, Number(e.target.value)),
                )
              }
              disabled={!config.fieldQueueAutoPruneEnabled}
              className="inline h-7 w-20 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
            />{' '}
            {t('adminHousekeeping.scheduleFieldQueueAutoPruneAfter')}
          </label>
        </fieldset>
      </div>

      <fieldset className="mt-4 grid gap-2 rounded-md border border-border p-3 md:grid-cols-4">
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            {t('adminHousekeeping.scheduleHowOften')}
          </span>
          <select
            value={config.scheduleMode}
            onChange={(e) =>
              set(
                'scheduleMode',
                e.target.value as HousekeepingConfig['scheduleMode'],
              )
            }
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
          >
            <option value="off">{t('adminHousekeeping.scheduleModeOff')}</option>
            <option value="daily">{t('adminHousekeeping.scheduleModeDaily')}</option>
            <option value="weekly">{t('adminHousekeeping.scheduleModeWeekly')}</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            {t('adminHousekeeping.scheduleHour')}
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
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            {t('adminHousekeeping.scheduleMinute')}
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
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            {t('adminHousekeeping.scheduleDayOfWeek')}
          </span>
          <select
            value={config.scheduleDayOfWeek ?? 1}
            onChange={(e) =>
              set('scheduleDayOfWeek', Number(e.target.value))
            }
            disabled={config.scheduleMode !== 'weekly'}
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
          >
            {DAY_KEYS.map((key, value) => (
              <option key={key} value={value}>
                {t(`adminHousekeeping.${key}`)}
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
          {t('adminHousekeeping.scheduleRunNow')}
        </button>
        <div className="flex items-center gap-2">
          {savedFlash ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" />
              {t('adminHousekeeping.scheduleSaved')}
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
            {t('adminHousekeeping.scheduleSave')}
          </button>
        </div>
      </div>

      {runs.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            {t('adminHousekeeping.scheduleRecent')}
          </h3>
          <ul className="space-y-1">
            {runs.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-2 text-xs text-ink-1"
              >
                <span className="font-mono text-2xs text-muted">
                  {fmt.dateTime(r.startedAt)}
                </span>
                <StatusPill status={r.status} />
                <span className="text-muted">
                  (
                  {r.trigger === 'manual'
                    ? t('adminHousekeeping.scheduleTriggerManual')
                    : t('adminHousekeeping.scheduleTriggerScheduled')}
                  )
                </span>
                <span>
                  {t('adminHousekeeping.scheduleRunSummary', {
                    items: r.itemsTrashed,
                    users: r.usersDisabled,
                  })}
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
  const t = useT();
  const label =
    status === 'succeeded'
      ? t('adminHousekeeping.statusSucceeded')
      : status === 'failed'
        ? t('adminHousekeeping.statusFailed')
        : t('adminHousekeeping.statusRunning');
  const cls =
    status === 'succeeded'
      ? 'bg-success/15 text-success'
      : status === 'failed'
        ? 'bg-danger/15 text-danger'
        : 'bg-warning/15 text-warning';
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-2xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}
