// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  geolocationBlock,
  INSECURE_GEOLOCATION_MESSAGE,
  isInsecureGeolocationMessage,
} from '@/lib/geolocation-context';

/**
 * Field-runtime geolocation hook. Wraps navigator.geolocation.watchPosition
 * with state that the runtime + GPS dot + Locate FAB + form's "Use my
 * location" affordance can all read.
 *
 * Permission handling is split into two stages:
 *
 *   - "idle": we haven't asked the browser yet. Some users will deny the
 *     prompt forever (iOS Safari makes denial sticky and only Settings
 *     can undo it), so we let the caller render an explainer card before
 *     calling start(). That gives the user the why and a Cancel option.
 *   - "watching": navigator handed us a position stream and we update
 *     `position` on every callback.
 *   - "denied" / "unavailable" / "error": terminal states the caller
 *     surfaces in the GPS quality pill.
 *
 * `enableHighAccuracy: true` is critical for survey work; without it
 * iOS will sometimes hand us a wifi-triangulated location that's
 * 1 km off. Battery cost is real but acceptable for a foreground
 * field-runtime tab.
 */

export type GpsStatus =
  | 'idle'
  | 'requesting'
  | 'watching'
  | 'denied'
  | 'unavailable'
  | 'error';

export interface GpsPosition {
  /** WGS84 longitude. */
  lon: number;
  /** WGS84 latitude. */
  lat: number;
  /** Reported horizontal accuracy in meters (95% confidence per spec). */
  accuracyM: number;
  /** Optional altitude in meters above WGS84 ellipsoid. */
  altitudeM: number | null;
  /** Optional altitude accuracy in meters. */
  altitudeAccuracyM: number | null;
  /** Heading in degrees clockwise from true north. NaN when stationary. */
  headingDeg: number | null;
  /** Speed over ground in meters/second. */
  speedMps: number | null;
  /** When the fix was acquired (browser-supplied epoch ms). */
  fixAt: number;
}

export interface GeolocationState {
  status: GpsStatus;
  position: GpsPosition | null;
  /** Browser-reported error message when status is 'error'. */
  errorMessage: string | null;
  /** True when the runtime is in follow-me mode (the map keeps recentering
   *  on each new fix). The hook stores it because Locate-me FAB and the
   *  More menu both need to read + toggle it. */
  follow: boolean;
}

export interface UseGeolocation extends GeolocationState {
  /** Begin watching. Triggers the browser's permission prompt if the user
   *  hasn't decided yet. Idempotent. */
  start: () => void;
  /** Stop watching and free the OS GPS subscription. */
  stop: () => void;
  /** Toggle follow-me mode. Implicitly calls start() if not already. */
  toggleFollow: () => void;
}

export function useGeolocation(): UseGeolocation {
  const [state, setState] = useState<GeolocationState>({
    status: 'idle',
    position: null,
    errorMessage: null,
    follow: false,
  });
  const watchIdRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined') {
      navigator.geolocation?.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setState((prev) => ({ ...prev, status: 'idle', follow: false }));
  }, []);

  const start = useCallback(() => {
    if (watchIdRef.current !== null) return;
    if (geolocationBlock() === 'insecure-context') {
      setState((prev) => ({
        ...prev,
        status: 'unavailable',
        errorMessage: INSECURE_GEOLOCATION_MESSAGE,
      }));
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState((prev) => ({
        ...prev,
        status: 'unavailable',
        errorMessage: 'Geolocation is not available in this browser.',
      }));
      return;
    }
    setState((prev) => ({ ...prev, status: 'requesting', errorMessage: null }));
    watchIdRef.current = navigator.geolocation.watchPosition(
      (geo) => {
        setState((prev) => ({
          ...prev,
          status: 'watching',
          errorMessage: null,
          position: {
            lon: geo.coords.longitude,
            lat: geo.coords.latitude,
            accuracyM: geo.coords.accuracy,
            altitudeM: geo.coords.altitude ?? null,
            altitudeAccuracyM: geo.coords.altitudeAccuracy ?? null,
            headingDeg: Number.isFinite(geo.coords.heading)
              ? (geo.coords.heading as number)
              : null,
            speedMps: geo.coords.speed ?? null,
            fixAt: geo.timestamp,
          },
        }));
      },
      (err) => {
        const status: GpsStatus =
          err.code === err.PERMISSION_DENIED
            ? 'denied'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'unavailable'
              : 'error';
        setState((prev) => ({
          ...prev,
          status: isInsecureGeolocationMessage(err.message) ? 'unavailable' : status,
          errorMessage: isInsecureGeolocationMessage(err.message)
            ? INSECURE_GEOLOCATION_MESSAGE
            : err.message,
        }));
        // Don't keep a watch we know is failing; the caller can re-start
        // after the user fixes permissions.
        if (watchIdRef.current !== null) {
          navigator.geolocation.clearWatch(watchIdRef.current);
          watchIdRef.current = null;
        }
      },
      {
        enableHighAccuracy: true,
        // 30 s max age keeps the marker fresh enough that walking to a new
        // parcel doesn't show the previous parcel as "your location."
        maximumAge: 30 * 1000,
        // 60 s timeout: longer than the typical cold-start GPS lock
        // (10-30 s outdoors) so we surface a real error rather than
        // a spurious "Position unavailable" on the first second indoors.
        timeout: 60 * 1000,
      },
    );
  }, []);

  const toggleFollow = useCallback(() => {
    setState((prev) => {
      const next = !prev.follow;
      // Implicitly start a watch when entering follow mode. Stopping is
      // not implicit on toggle-off because the user may still want to
      // see the dot, just not the auto-recenter.
      if (next && watchIdRef.current === null) {
        // Fall through to start() outside this setState.
        queueMicrotask(start);
      }
      return { ...prev, follow: next };
    });
  }, [start]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null && typeof navigator !== 'undefined') {
        navigator.geolocation?.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, []);

  return {
    ...state,
    start,
    stop,
    toggleFollow,
  };
}

/**
 * Categorize the reported accuracy into a UX bucket. Tunable; the
 * thresholds are taken from common consumer GPS quality bands.
 */
export function gpsAccuracyBand(
  accuracyM: number | null | undefined,
): 'excellent' | 'good' | 'fair' | 'poor' | 'unknown' {
  if (accuracyM === null || accuracyM === undefined) return 'unknown';
  if (accuracyM <= 5) return 'excellent';
  if (accuracyM <= 15) return 'good';
  if (accuracyM <= 50) return 'fair';
  return 'poor';
}
