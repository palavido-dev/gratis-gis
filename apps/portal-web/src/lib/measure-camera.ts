// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Camera helpers for the Measure tool.
 *
 * Pitched 3D foreshortens the view so a sketch that "covers" a
 * parcel on screen can be far smaller in planimetric (and slope)
 * area than the parcel deed acres. Flattening pitch while
 * measuring makes the scale bar and the drawn ring agree with
 * what the user sees.
 */

/** Pitch (degrees) above which Measure flattens the camera. */
export const MEASURE_FLATTEN_PITCH_DEG = 2;

export function shouldFlattenPitchForMeasure(pitch: number): boolean {
  return Number.isFinite(pitch) && pitch > MEASURE_FLATTEN_PITCH_DEG;
}

type EaseToMap = {
  getPitch: () => number;
  easeTo: (opts: { pitch: number; duration?: number }) => void;
};

/**
 * If the map is pitched, ease to top-down. Returns a restore
 * function that puts pitch back (no-op when already flat).
 */
export function flattenPitchForMeasure(map: EaseToMap): () => void {
  let prior: number;
  try {
    prior = map.getPitch();
  } catch {
    return () => undefined;
  }
  if (!shouldFlattenPitchForMeasure(prior)) {
    return () => undefined;
  }
  try {
    map.easeTo({ pitch: 0, duration: 280 });
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      map.easeTo({ pitch: prior, duration: 280 });
    } catch {
      /* style / map gone */
    }
  };
}
