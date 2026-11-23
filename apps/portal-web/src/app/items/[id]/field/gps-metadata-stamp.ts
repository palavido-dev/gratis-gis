// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GPS metadata stamping for field-runtime feature inserts (#225 item 3).
 *
 * Field Maps publishes a canonical GPS-metadata schema admins can opt
 * into by adding columns with familiar names to their layer. We mirror
 * that pattern here: when an add-mode form is submitted with a live
 * GPS fix, walk the layer's declared fields and populate any whose
 * name matches one of the canonical aliases (case-insensitive). We
 * never create attributes that aren't already in the schema, so the
 * shape of a captured row stays the responsibility of the layer.
 *
 * What we deliberately do NOT do:
 *   - Stamp underscore-prefixed `_gps_*` columns on every layer
 *     regardless of whether the layer has them. (Phase A's earlier
 *     behaviour did this; superseded.)
 *   - Overwrite a value the form already supplied. The form's value
 *     wins; this only fills blanks.
 *   - Stamp on edit. The fix that mattered was the one taken when
 *     the row was created.
 *
 * Aliases map (case-insensitive, leading underscore tolerated):
 *
 *   longitude    : lon, longitude, x, gps_lon, _gps_lon
 *   latitude     : lat, latitude, y, gps_lat, _gps_lat
 *   h_accuracy   : h_accuracy, horizontal_accuracy, horiz_accuracy,
 *                  accuracy, gps_accuracy_m, _gps_accuracy_m
 *   altitude     : altitude, alt, alt_m, z, gps_altitude_m,
 *                  _gps_altitude_m
 *   v_accuracy   : v_accuracy, vertical_accuracy, vert_accuracy,
 *                  altitude_accuracy, gps_altitude_accuracy_m,
 *                  _gps_altitude_accuracy_m
 *   heading      : heading, heading_deg, gps_heading_deg,
 *                  _gps_heading_deg
 *   speed        : speed, speed_mps, gps_speed_mps, _gps_speed_mps
 *   fix_at       : fix_at, captured_at, gps_fix_at, _gps_fix_at,
 *                  position_timestamp
 *   src_type     : position_source_type
 *   capture      : capture_method
 *
 * The generic names (x, y, z, lat, lon, alt, accuracy, heading,
 * speed) are kept on purpose. Layers built for Field Maps style
 * collection use them, and stamping only happens when the new point
 * sits at the live fix (placedAtGpsFix in lib/gps-placement.ts,
 * checked at the call site), so a point tapped away from the fix, a
 * line, a polygon or a table row is never stamped. Requiring a gps_ prefix would stop filling columns that
 * layers rely on today. capture_method is always 'point-collected'
 * for the same reason: nothing else reaches the stamp.
 *
 * Receiver details (fix type, satellites, DOP, correction age, base
 * station, error estimates, receiver name) come only from an external
 * GNSS receiver; the browser's location has none of them, so those
 * columns stay empty on a phone's own fix. Field Maps' `esrignss_*`
 * names are recognised too, so a layer moved from ArcGIS Online fills
 * the same columns it did there. Codes follow Esri: `esrignss_fixtype`
 * is the GGA fix quality, `esrignss_positionsourcetype` is 2 for the
 * device's own location and 3 for an external receiver, and
 * `esrignss_speed` is km/h.
 */

import type { FeatureField } from '@gratis-gis/shared-types';
import type { Response as FormResponse } from '@gratis-gis/form-schema';
import type { GpsPosition } from './use-geolocation';

type GpsSlot =
  | 'longitude'
  | 'latitude'
  | 'h_accuracy'
  | 'altitude'
  | 'v_accuracy'
  | 'heading'
  | 'speed'
  | 'fix_at'
  | 'src_type'
  | 'src_type_code'
  | 'capture'
  | 'receiver'
  | 'fix_type'
  | 'num_sats'
  | 'pdop'
  | 'hdop'
  | 'vdop'
  | 'corr_age'
  | 'station_id'
  | 'h_rms'
  | 'v_rms'
  | 'speed_kmh';

// Generic aliases stay; see "The generic names" in the header.
const ALIASES: Record<GpsSlot, string[]> = {
  longitude: ['lon', 'longitude', 'x', 'gps_lon', '_gps_lon', 'esrignss_longitude'],
  latitude: ['lat', 'latitude', 'y', 'gps_lat', '_gps_lat', 'esrignss_latitude'],
  h_accuracy: [
    'h_accuracy',
    'horizontal_accuracy',
    'horiz_accuracy',
    'accuracy',
    'gps_accuracy_m',
    '_gps_accuracy_m',
  ],
  altitude: ['altitude', 'alt', 'alt_m', 'z', 'gps_altitude_m', '_gps_altitude_m', 'esrignss_altitude'],
  v_accuracy: [
    'v_accuracy',
    'vertical_accuracy',
    'vert_accuracy',
    'altitude_accuracy',
    'gps_altitude_accuracy_m',
    '_gps_altitude_accuracy_m',
  ],
  heading: ['heading', 'heading_deg', 'gps_heading_deg', '_gps_heading_deg', 'esrignss_direction'],
  speed: ['speed', 'speed_mps', 'gps_speed_mps', '_gps_speed_mps'],
  fix_at: [
    'fix_at',
    'captured_at',
    'gps_fix_at',
    '_gps_fix_at',
    'position_timestamp',
    'esrignss_fixdatetime',
  ],
  src_type: ['position_source_type'],
  src_type_code: ['esrignss_positionsourcetype'],
  capture: ['capture_method'],
  receiver: ['gnss_receiver', 'esrignss_receiver'],
  fix_type: ['fix_type', 'gnss_fix_type', 'esrignss_fixtype'],
  num_sats: ['num_sats', 'sat_count', 'esrignss_numsats'],
  pdop: ['pdop', 'esrignss_pdop'],
  hdop: ['hdop', 'esrignss_hdop'],
  vdop: ['vdop', 'esrignss_vdop'],
  corr_age: ['corr_age', 'correction_age', 'dgps_age', 'esrignss_correctionage'],
  station_id: ['station_id', 'esrignss_stationid'],
  h_rms: ['h_rms', 'esrignss_h_rms'],
  v_rms: ['v_rms', 'esrignss_v_rms'],
  speed_kmh: ['esrignss_speed'],
};

// Reverse lookup: lowercased alias → slot. Built once at module load.
const ALIAS_TO_SLOT: Map<string, GpsSlot> = (() => {
  const m = new Map<string, GpsSlot>();
  for (const [slot, names] of Object.entries(ALIASES) as [GpsSlot, string[]][]) {
    for (const n of names) m.set(n.toLowerCase(), slot);
  }
  return m;
})();

/**
 * Try to classify a field name (or property key) into one of the
 * canonical GPS slots. Returns null when the name doesn't match any
 * alias. Case-insensitive; leading underscore tolerated.
 */
export function classifyGpsField(name: string): GpsSlot | null {
  const key = name.toLowerCase();
  // Direct hit including any leading underscores.
  const direct = ALIAS_TO_SLOT.get(key);
  if (direct) return direct;
  // Some aliases include leading underscores; try stripping any
  // additional ones the user might have added (`__gps_lat`).
  const stripped = key.replace(/^_+/, '');
  const alt = ALIAS_TO_SLOT.get(stripped);
  if (alt) return alt;
  return null;
}

/** Field types that hold numbers. */
const NUMERIC = new Set(['number']);

function valueForSlot(slot: GpsSlot, pos: GpsPosition, fieldType: string): unknown {
  const g = pos.gnss;
  switch (slot) {
    case 'longitude':
      return pos.lon;
    case 'latitude':
      return pos.lat;
    case 'h_accuracy':
      return pos.accuracyM;
    case 'altitude':
      return pos.altitudeM;
    case 'v_accuracy':
      return pos.altitudeAccuracyM;
    case 'heading':
      return pos.headingDeg;
    case 'speed':
      return pos.speedMps;
    case 'fix_at':
      return new Date(pos.fixAt).toISOString();
    case 'src_type':
      return g ? 'external-gnss' : 'browser-geolocation';
    case 'src_type_code':
      return g ? 3 : 2;
    case 'capture':
      return 'point-collected';
    case 'receiver':
      return g?.receiver;
    case 'fix_type':
      if (!g) return undefined;
      return NUMERIC.has(fieldType) ? g.fixType : g.fixTypeLabel;
    case 'num_sats':
      return g?.satellites;
    case 'pdop':
      return g?.pdop;
    case 'hdop':
      return g?.hdop;
    case 'vdop':
      return g?.vdop;
    case 'corr_age':
      return g?.correctionAgeS;
    case 'station_id':
      return g?.stationId;
    case 'h_rms':
      return g?.hRmsM;
    case 'v_rms':
      return g?.vRmsM;
    case 'speed_kmh':
      return pos.speedMps === null ? null : pos.speedMps * 3.6;
  }
}

/**
 * Given a layer's declared fields, the form-submitted response, and
 * the current GPS fix, return a new properties object that merges the
 * GPS-derived defaults into any matching columns the layer has,
 * without overwriting values the form already supplied.
 *
 * If `position` is null, returns the response unchanged.
 */
export function stampGpsMetadata(
  fields: ReadonlyArray<FeatureField>,
  response: FormResponse,
  position: GpsPosition | null,
): FormResponse {
  if (!position) return response;
  const out: FormResponse = { ...response };
  for (const f of fields) {
    const slot = classifyGpsField(f.name);
    if (!slot) continue;
    // Form-supplied value wins. We only fill blanks.
    if (out[f.name] !== undefined && out[f.name] !== null && out[f.name] !== '') {
      continue;
    }
    const v = valueForSlot(slot, position, String(f.type));
    if (v === null || v === undefined) continue;
    out[f.name] = v as FormResponse[string];
  }
  return out;
}
