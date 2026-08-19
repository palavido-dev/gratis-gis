// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Auto-refresh for data-bound app widgets.
 *
 * This is the first deliberate polling loop in a runtime: every other
 * timer in the item tree is job-status polling or an animation clock.
 * It lives in one hook rather than inside the widgets so the three
 * behaviours that make polling tolerable cannot be forgotten by the
 * next widget that wants it:
 *
 *   - **A floor.** An author can type 5 into the inspector; a wall of
 *     widgets at 5s is a self-inflicted load test. Anything below the
 *     floor is raised to it.
 *   - **Visibility pausing.** A dashboard left open on a background
 *     tab (which is where dashboards live) must not keep fetching.
 *     The timer stops on hide and fires once on show, so the numbers
 *     are fresh the moment the user looks and idle while they do not.
 *   - **Jitter.** Widgets mount together, so a fixed period lines
 *     them up into a stampede that repeats forever, and a room of
 *     wall displays started by the same script lines up across
 *     machines. Each widget gets its own offset within the period.
 *
 * Returns a counter that increments on every due refresh. Callers use
 * it as a fetch dependency; it deliberately carries no data of its own
 * so the hook never has to know what a widget fetches.
 */

/** Floor for any configured interval, in seconds. */
export const REFRESH_MIN_SECONDS = 15;

/**
 * Resolve a widget's effective cadence from the per-widget override
 * and the app default. `0` at either level means "manual", and the
 * widget-level value wins so an author can pin an expensive table
 * still while the KPI row ticks.
 */
export function resolveRefreshSeconds(
  widgetSeconds: number | undefined,
  appSeconds: number | undefined,
): number {
  const raw = widgetSeconds ?? appSeconds ?? 0;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(REFRESH_MIN_SECONDS, Math.floor(raw));
}

export function useAutoRefresh(seconds: number): number {
  const [tick, setTick] = useState(0);
  // Stable per-mount jitter in [0, 1): the widget's slot inside the
  // period. Computed once so a re-render never re-rolls it.
  const jitter = useRef(Math.random());

  useEffect(() => {
    if (seconds <= 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    // Tracked so a tab that was hidden across several periods fires
    // exactly once on return rather than replaying every missed tick.
    let lastRun = Date.now();

    const periodMs = seconds * 1000;

    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        if (cancelled) return;
        if (document.visibilityState === 'hidden') {
          // Do not fetch behind the user's back; the visibility
          // listener below picks it up when they come back.
          schedule(periodMs);
          return;
        }
        lastRun = Date.now();
        setTick((n) => n + 1);
        schedule(periodMs);
      }, Math.max(0, delay));
    };

    // First fire lands at a jittered offset inside the first period,
    // so N widgets mounting together spread across it.
    schedule(periodMs * (0.5 + jitter.current * 0.5));

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRun < periodMs) return;
      lastRun = Date.now();
      setTick((n) => n + 1);
      if (timer) clearTimeout(timer);
      schedule(periodMs);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [seconds]);

  return tick;
}
