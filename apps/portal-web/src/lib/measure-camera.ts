// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Camera helpers for the Measure tool.
 *
 * Pitched 3D foreshortens the view so a sketch that "covers" a
 * parcel on screen can be far smaller in planimetric (and slope)
 * area than the parcel deed acres. Flattening pitch while
 * measuring makes the scale bar and the drawn ring agree with
 * what the user sees.
 *
 * Flatten is instantaneous (`jumpTo` / `setPitch`) and maxPitch is
 * clamped to 0 for the life of the tool so the first vertex — and
 * every later one — cannot land under a pitched camera. Restore on
 * close eases pitch / maxPitch back.
 */

/** Pitch (degrees) above which Measure flattens the camera. */
export const MEASURE_FLATTEN_PITCH_DEG = 2;

export function shouldFlattenPitchForMeasure(pitch: number): boolean {
  return Number.isFinite(pitch) && pitch > MEASURE_FLATTEN_PITCH_DEG;
}

type FlattenMap = {
  getPitch: () => number;
  getMaxPitch?: () => number;
  setMaxPitch?: (pitch: number) => void;
  jumpTo?: (opts: { pitch: number }) => void;
  setPitch?: (pitch: number) => void;
  easeTo?: (opts: { pitch: number; duration?: number }) => void;
};

function setPitchImmediate(map: FlattenMap, pitch: number): void {
  if (typeof map.jumpTo === 'function') {
    map.jumpTo({ pitch });
    return;
  }
  if (typeof map.setPitch === 'function') {
    map.setPitch(pitch);
    return;
  }
  if (typeof map.easeTo === 'function') {
    map.easeTo({ pitch, duration: 0 });
  }
}

/**
 * Jump to top-down and lock pitch for the Measure session. Returns
 * a restore that puts maxPitch + pitch back (no-op when already
 * flat and unlocked). Always clamps maxPitch while open so the
 * user cannot re-tilt mid-sketch.
 */
export function flattenPitchForMeasure(map: FlattenMap): () => void {
  let priorPitch = 0;
  let priorMaxPitch: number | null = null;
  try {
    priorPitch = map.getPitch();
    if (typeof map.getMaxPitch === 'function') {
      priorMaxPitch = map.getMaxPitch();
    }
  } catch {
    return () => undefined;
  }

  const needsFlatten = shouldFlattenPitchForMeasure(priorPitch);
  const canLockMax =
    typeof map.setMaxPitch === 'function' &&
    priorMaxPitch != null &&
    priorMaxPitch > 0;

  if (!needsFlatten && !canLockMax) {
    return () => undefined;
  }

  try {
    if (needsFlatten) {
      setPitchImmediate(map, 0);
    }
    if (canLockMax) {
      map.setMaxPitch!(0);
    }
  } catch {
    return () => undefined;
  }

  return () => {
    try {
      if (canLockMax && priorMaxPitch != null) {
        map.setMaxPitch!(priorMaxPitch);
      }
      if (needsFlatten) {
        if (typeof map.easeTo === 'function') {
          map.easeTo({ pitch: priorPitch, duration: 280 });
        } else {
          setPitchImmediate(map, priorPitch);
        }
      }
    } catch {
      /* style / map gone */
    }
  };
}
