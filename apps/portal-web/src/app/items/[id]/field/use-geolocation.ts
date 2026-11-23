// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  geolocationBlock,
  geolocationErrorOutcome,
  INSECURE_GEOLOCATION_MESSAGE,
} from '@/lib/geolocation-context';
import {
  ExternalGnssConnection,
  externalGnssSupported,
} from '@/lib/external-gnss';
import { FIX_TYPES, type GnssFix } from '@/lib/nmea';

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
  /** Set when the fix came from an external GNSS receiver. */
  gnss?: GnssDetails;
}

/** What an external receiver reports beyond a browser fix. */
export interface GnssDetails {
  receiver: string;
  /** GGA fix quality code (Esri's esrignss_fixtype). */
  fixType: number;
  fixTypeLabel: string;
  satellites: number | null;
  hdop: number | null;
  pdop: number | null;
  vdop: number | null;
  correctionAgeS: number | null;
  stationId: string | null;
  hRmsM: number | null;
  vRmsM: number | null;
  /** True when accuracyM is the receiver's own estimate, not one from HDOP. */
  accuracyFromReceiver: boolean;
}

export type ExternalGnssStatus = 'off' | 'connecting' | 'waiting' | 'connected' | 'error';

export interface ExternalGnssState {
  /** The browser can reach a receiver (Web Serial). */
  supported: boolean;
  status: ExternalGnssStatus;
  receiver: string | null;
  errorMessage: string | null;
}

/**
 * A browser fix arriving while a receiver is connected is ignored
 * unless the receiver has gone quiet for this long.
 */
const EXTERNAL_STALE_MS = 5000;

/** A receiver fix as a position. */
export function positionFromGnss(fix: GnssFix, receiver: string): GpsPosition {
  return {
    lon: fix.lon,
    lat: fix.lat,
    accuracyM: fix.accuracyM,
    altitudeM: fix.altitudeM,
    altitudeAccuracyM: fix.vRmsM,
    headingDeg: fix.courseDeg,
    speedMps: fix.speedMps,
    fixAt: fix.fixAt,
    gnss: {
      receiver,
      fixType: fix.fixType,
      fixTypeLabel: FIX_TYPES[fix.fixType] ?? `Type ${fix.fixType}`,
      satellites: fix.satellites,
      hdop: fix.hdop,
      pdop: fix.pdop,
      vdop: fix.vdop,
      correctionAgeS: fix.correctionAgeS,
      stationId: fix.stationId,
      hRmsM: fix.hRmsM,
      vRmsM: fix.vRmsM,
      accuracyFromReceiver: fix.accuracyFromReceiver,
    },
  };
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
  /** External receiver state. */
  external: ExternalGnssState;
  /** Pick and connect a receiver. Must run from a tap. */
  connectExternal: () => Promise<void>;
  /** Disconnect the receiver and go back to the device's location. */
  disconnectExternal: () => void;
}

export function useGeolocation(): UseGeolocation {
  const [state, setState] = useState<GeolocationState>({
    status: 'idle',
    position: null,
    errorMessage: null,
    follow: false,
  });
  const watchIdRef = useRef<number | null>(null);
  const [external, setExternal] = useState<ExternalGnssState>(() => ({
    supported: externalGnssSupported(),
    status: 'off',
    receiver: null,
    errorMessage: null,
  }));
  const externalRef = useRef<ExternalGnssConnection | null>(null);
  /** Epoch ms of the last receiver fix; 0 when none. */
  const lastExternalAtRef = useRef(0);

  const stop = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined') {
      navigator.geolocation?.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    // Drop the last fix too: callers capture at `position` whenever it
    // is set, and a stopped watch can no longer vouch for it.
    setState((prev) => ({
      ...prev,
      status: 'idle',
      follow: false,
      position: null,
    }));
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
        // A connected receiver that is still sending wins.
        if (externalRef.current && Date.now() - lastExternalAtRef.current < EXTERNAL_STALE_MS) return;
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
        const outcome = geolocationErrorOutcome(err.code, err.message);
        // The fix is dropped on every error, so a one-tap Add cannot
        // commit at a position from before the signal was lost; the
        // next fix brings it back. See geolocationErrorOutcome.
        setState((prev) => ({
          ...prev,
          status: outcome.status,
          position: null,
          errorMessage: outcome.insecure
            ? INSECURE_GEOLOCATION_MESSAGE
            : err.message,
        }));
        // End the watch only on a refusal; the caller can re-start
        // after the user fixes permissions.
        if (!outcome.keepWatching && watchIdRef.current !== null) {
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

  const disconnectExternal = useCallback(() => {
    const conn = externalRef.current;
    externalRef.current = null;
    lastExternalAtRef.current = 0;
    void conn?.disconnect();
    setExternal((prev) => ({ ...prev, status: 'off', receiver: null, errorMessage: null }));
  }, []);

  const connectExternal = useCallback(async () => {
    if (externalRef.current) return;
    setExternal((prev) => ({ ...prev, status: 'connecting', errorMessage: null }));
    // Set once connect() resolves; lines read before then are ignored.
    let conn: ExternalGnssConnection | null = null;
    try {
      conn = await ExternalGnssConnection.connect({
        onFix: (fix) => {
          if (!conn || externalRef.current !== conn) return;
          const receiver = conn.name;
          lastExternalAtRef.current = Date.now();
          setExternal((prev) => (prev.status === 'connected' ? prev : { ...prev, status: 'connected' }));
          setState((prev) => ({
            ...prev,
            status: 'watching',
            errorMessage: null,
            position: positionFromGnss(fix, receiver),
          }));
        },
        onNoFix: () => {
          if (!conn || externalRef.current !== conn) return;
          setExternal((prev) => ({ ...prev, status: 'waiting' }));
        },
        onClose: (error) => {
          if (!conn || externalRef.current !== conn) return;
          externalRef.current = null;
          lastExternalAtRef.current = 0;
          setExternal((prev) => ({
            ...prev,
            status: error ? 'error' : 'off',
            receiver: null,
            errorMessage: error,
          }));
          // Drop the receiver's last fix; the device watch refills it.
          setState((prev) => (prev.position?.gnss ? { ...prev, position: null } : prev));
        },
      });
      externalRef.current = conn;
      const name = conn.name;
      setExternal((prev) => ({ ...prev, status: 'waiting', receiver: name }));
    } catch (e) {
      // Closing the picker is not an error.
      const cancelled = e instanceof DOMException && e.name === 'NotFoundError';
      setExternal((prev) => ({
        ...prev,
        status: cancelled ? 'off' : 'error',
        errorMessage: cancelled ? null : e instanceof Error ? e.message : String(e),
      }));
    }
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null && typeof navigator !== 'undefined') {
        navigator.geolocation?.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      void externalRef.current?.disconnect();
      externalRef.current = null;
    };
  }, []);

  return {
    ...state,
    start,
    stop,
    toggleFollow,
    external,
    connectExternal,
    disconnectExternal,
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
