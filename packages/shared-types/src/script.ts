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
}

/** Lifecycle of one execution. Mirrors the analysis-job vocabulary so
 *  the two queues read the same way in logs and UI. */
export type ScriptRunState =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'failed'
  | 'done';

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
