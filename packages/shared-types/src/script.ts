// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `script` item payload (#221).
 *
 * User-authored Python, stored as an item and run server-side. The
 * portal deliberately ships no editor beyond a plain text area: every
 * operator running GratisGIS already has a machine and an editor, and
 * a browser IDE is the least valuable part of what the hosted GIS
 * products bundle. What the portal uniquely provides is a machine that
 * is awake at 3am.
 *
 * The script talks to the portal the same way a script on the author's
 * laptop does: over the public HTTP API, with an API key, through the
 * `gratisgis` Python client. There is no privileged in-process mode,
 * so the identical file runs in both places. That is the point.
 */
export interface ScriptData {
  /** Payload version, for future migrations of this shape. */
  version: 1;

  /**
   * The Python source. Stored on the item rather than in object
   * storage so it versions through item_data_snapshot like any other
   * item's content, and so a run can snapshot exactly what it ran.
   */
  source: string;

  /**
   * Hard wall-clock limit for one run, in seconds. The worker kills
   * the process at this point. Bounded server-side too: a script item
   * cannot raise its own ceiling past the deployment's maximum, or
   * the timeout would be advisory rather than a limit.
   */
  timeoutSeconds?: number;

  /**
   * Author's note about what the script does and what it touches.
   * Distinct from the item description, which is the portal-wide
   * "what is this item" field: this one is aimed at whoever is
   * deciding whether it is safe to press Run.
   */
  notes?: string;

  /**
   * When to run this on its own. Absent or `mode: 'off'` means the
   * Run button is the only way it ever executes.
   *
   * Lives here with the source rather than in its own table so a
   * schedule change versions through item_data_snapshot alongside the
   * code it runs. Restoring an old version of a script restores the
   * cadence it ran at, which is the behaviour that stops surprising
   * people.
   */
  schedule?: ScriptSchedule;
}

/**
 * How often a script runs by itself.
 *
 * Structured fields rather than a cron expression, matching the backup
 * and housekeeping schedules. A cron box would be a smaller amount of
 * code here and a worse product: this is an item page a contributor
 * sees, not an admin console, and `0 3 * * 1` is not something a county
 * GIS technician should have to learn to run a layer refresh on Monday
 * mornings.
 *
 * There is deliberately no `custom` cron mode yet, unlike backups. If
 * someone needs "every six hours" the honest answer is that we should
 * hear that as a request rather than pre-emptively put a cron parser
 * in front of everybody.
 */
export type ScriptScheduleMode =
  | 'off'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly';

export interface ScriptSchedule {
  mode: ScriptScheduleMode;
  /** Minute past the hour, 0 to 59. Every mode uses it. */
  minute?: number;
  /** Hour of the day, 0 to 23, in the server's time zone. Not used by
   *  `hourly`. */
  hour?: number;
  /** 0 is Sunday. `weekly` only. */
  dayOfWeek?: number;
  /**
   * Day of the month, 1 to 28. `monthly` only.
   *
   * Capped at 28 on purpose. Allowing 29 to 31 produces a schedule
   * that silently does not run in February, which reads as a broken
   * script rather than as a calendar.
   */
  dayOfMonth?: number;
}

const clampInt = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(Math.max(Math.floor(v), lo), hi)
    : fallback;

/** Normalize whatever is on data_json into a schedule we can trust. */
export function normalizeScriptSchedule(
  raw: unknown,
): ScriptSchedule | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Partial<ScriptSchedule>;
  const mode: ScriptScheduleMode =
    s.mode === 'hourly' ||
    s.mode === 'daily' ||
    s.mode === 'weekly' ||
    s.mode === 'monthly'
      ? s.mode
      : 'off';
  if (mode === 'off') return { mode: 'off' };
  return {
    mode,
    minute: clampInt(s.minute, 0, 59, 0),
    hour: clampInt(s.hour, 0, 23, 3),
    dayOfWeek: clampInt(s.dayOfWeek, 0, 6, 1),
    dayOfMonth: clampInt(s.dayOfMonth, 1, 28, 1),
  };
}

/** The cron expression a schedule means, or null for "never". */
export function buildScriptCron(schedule: ScriptSchedule | undefined): string | null {
  const s = normalizeScriptSchedule(schedule);
  if (!s || s.mode === 'off') return null;
  const minute = s.minute ?? 0;
  const hour = s.hour ?? 3;
  switch (s.mode) {
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${s.dayOfWeek ?? 1}`;
    case 'monthly':
      return `${minute} ${hour} ${s.dayOfMonth ?? 1} * *`;
  }
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const ordinal = (n: number) => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
};

/** One line of plain English for a schedule, for the UI and the logs. */
export function summarizeScriptSchedule(
  schedule: ScriptSchedule | undefined,
): string {
  const s = normalizeScriptSchedule(schedule);
  if (!s || s.mode === 'off') return 'Only when someone runs it';
  const mm = String(s.minute ?? 0).padStart(2, '0');
  const at = `${String(s.hour ?? 3).padStart(2, '0')}:${mm}`;
  switch (s.mode) {
    case 'hourly':
      return `Every hour at :${mm}`;
    case 'daily':
      return `Every day at ${at}`;
    case 'weekly':
      return `Every ${DAY_NAMES[s.dayOfWeek ?? 1]} at ${at}`;
    case 'monthly':
      return `The ${ordinal(s.dayOfMonth ?? 1)} of each month at ${at}`;
  }
}

/** Lifecycle of one execution. Mirrors the analysis-job vocabulary so
 *  the two queues read the same way in logs and UI. */
export type ScriptRunState =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'failed'
  | 'done'
  /**
   * A scheduled fire that found the previous run still going.
   *
   * Recorded rather than dropped. A script whose schedule is tighter
   * than its runtime silently loses most of its runs, and the only
   * thing worse than that happening is it happening invisibly: the
   * history would show a tidy row of successes and no hint that
   * two-thirds of the ticks never happened. Terminal, never claimed.
   */
  | 'skipped';

/** What started a run. `schedule` arrives with the timer slice; the
 *  column exists from the first release so run history does not need
 *  a backfill. */
export type ScriptRunTrigger = 'manual' | 'schedule';

export interface ScriptRunSummary {
  id: string;
  scriptId: string;
  state: ScriptRunState;
  trigger: ScriptRunTrigger;
  exitCode: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ScriptRunDetail extends ScriptRunSummary {
  /** Interleaved stdout and stderr as the process emitted them. */
  log: string | null;
  /** The source as it was when this run started, so a month-old
   *  failure is readable against the code that actually failed. */
  sourceSnapshot: string | null;
}

/** Default and ceiling for a run's wall clock. A script that hangs on
 *  a third-party endpoint must not hold a worker slot forever. */
export const SCRIPT_DEFAULT_TIMEOUT_SECONDS = 300;
export const SCRIPT_MAX_TIMEOUT_SECONDS = 3600;

/** Largest source we accept. Generous for a maintenance script, small
 *  enough that the item row stays sane. */
export const SCRIPT_MAX_SOURCE_BYTES = 256 * 1024;

export function clampScriptTimeout(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return SCRIPT_DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(
    Math.max(Math.floor(seconds), 1),
    SCRIPT_MAX_TIMEOUT_SECONDS,
  );
}
