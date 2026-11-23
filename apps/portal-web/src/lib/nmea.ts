// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * NMEA 0183 reading for external GNSS receivers.
 *
 * A receiver streams lines such as `$GNGGA,...*4F`. A fix is put
 * together from several of them: GGA gives the position, fix type,
 * satellites and correction age; GSA the dilution of precision; GST
 * the error estimates; RMC the date, speed and course. Each GGA line
 * closes one fix, using the latest of the others.
 *
 * Talker ids (GP, GN, GL, GA, GB) are ignored, so mixed constellations
 * read the same. Lines with a bad checksum are dropped.
 */

/** GGA fix quality, which is also Esri's `esrignss_fixtype` code. */
export const FIX_TYPES: Record<number, string> = {
  0: 'No fix',
  1: 'GPS',
  2: 'DGPS',
  3: 'PPS',
  4: 'RTK fixed',
  5: 'RTK float',
  6: 'Estimated',
  7: 'Manual',
  8: 'Simulation',
};

export interface GnssFix {
  lat: number;
  lon: number;
  /** Height above the ellipsoid in meters, when the receiver sends it. */
  altitudeM: number | null;
  /** GGA fix quality code; see FIX_TYPES. */
  fixType: number;
  satellites: number | null;
  hdop: number | null;
  pdop: number | null;
  vdop: number | null;
  /** Seconds since the last differential correction. */
  correctionAgeS: number | null;
  stationId: string | null;
  /** Horizontal and vertical error estimates (1 sigma, meters), from GST. */
  hRmsM: number | null;
  vRmsM: number | null;
  /**
   * Horizontal accuracy in meters: the GST estimate when the receiver
   * sends one, otherwise a rough figure from HDOP and the fix type.
   */
  accuracyM: number;
  /** True when accuracyM is the receiver's own estimate. */
  accuracyFromReceiver: boolean;
  speedMps: number | null;
  courseDeg: number | null;
  /** Fix time, epoch ms. */
  fixAt: number;
}

/** Check a line's checksum and split it into fields. */
export function parseSentence(line: string): { type: string; fields: string[] } | null {
  const s = line.trim();
  if (!s.startsWith('$') && !s.startsWith('!')) return null;
  const star = s.lastIndexOf('*');
  const body = star === -1 ? s.slice(1) : s.slice(1, star);
  if (star !== -1) {
    const given = Number.parseInt(s.slice(star + 1, star + 3), 16);
    let sum = 0;
    for (let i = 0; i < body.length; i += 1) sum ^= body.charCodeAt(i);
    if (!Number.isFinite(given) || given !== sum) return null;
  }
  const fields = body.split(',');
  const tag = fields[0] ?? '';
  if (tag.length < 5) return null;
  return { type: tag.slice(-3).toUpperCase(), fields: fields.slice(1) };
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `ddmm.mmmm` plus hemisphere to decimal degrees. */
function coord(v: string | undefined, hemi: string | undefined, degDigits: number): number | null {
  if (!v || !hemi) return null;
  const deg = Number(v.slice(0, degDigits));
  const min = Number(v.slice(degDigits));
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  const d = deg + min / 60;
  return hemi === 'S' || hemi === 'W' ? -d : d;
}

/** `hhmmss.ss` on a given UTC day (epoch ms of midnight) to epoch ms. */
function timeOn(day: number, hhmmss: string | undefined): number | null {
  if (!hhmmss || hhmmss.length < 6) return null;
  const h = Number(hhmmss.slice(0, 2));
  const m = Number(hhmmss.slice(2, 4));
  const s = Number(hhmmss.slice(4));
  if (![h, m, s].every(Number.isFinite)) return null;
  return day + ((h * 60 + m) * 60 + s) * 1000;
}

/** Typical one-sigma error per HDOP unit, by fix type, in meters. */
const UERE: Record<number, number> = { 1: 4, 2: 1, 3: 1, 4: 0.02, 5: 0.3, 6: 10 };

/** Builds fixes from a stream of sentences. */
export class NmeaFixBuilder {
  private pdop: number | null = null;
  private vdop: number | null = null;
  private gsaHdop: number | null = null;
  private hRms: number | null = null;
  private vRms: number | null = null;
  private speedMps: number | null = null;
  private courseDeg: number | null = null;
  /** UTC midnight of the last RMC date, epoch ms. */
  private day: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed one line. Returns a fix when the line completes one. */
  push(line: string): GnssFix | null {
    const p = parseSentence(line);
    if (!p) return null;
    const f = p.fields;
    switch (p.type) {
      case 'GSA':
        this.pdop = num(f[14]);
        this.gsaHdop = num(f[15]);
        this.vdop = num(f[16]);
        return null;
      case 'GST': {
        const latErr = num(f[5]);
        const lonErr = num(f[6]);
        this.hRms =
          latErr !== null && lonErr !== null ? Math.sqrt(latErr * latErr + lonErr * lonErr) : null;
        this.vRms = num(f[7]);
        return null;
      }
      case 'RMC': {
        const knots = num(f[6]);
        this.speedMps = knots === null ? null : knots * 0.514444;
        this.courseDeg = num(f[7]);
        const d = f[8];
        if (d && d.length === 6) {
          const dd = Number(d.slice(0, 2));
          const mm = Number(d.slice(2, 4));
          const yy = Number(d.slice(4, 6));
          if ([dd, mm, yy].every(Number.isFinite)) this.day = Date.UTC(2000 + yy, mm - 1, dd);
        }
        return null;
      }
      case 'GGA':
        return this.fromGga(f);
      default:
        return null;
    }
  }

  private fromGga(f: string[]): GnssFix | null {
    const fixType = num(f[5]) ?? 0;
    if (fixType === 0) return null;
    const lat = coord(f[1], f[2], 2);
    const lon = coord(f[3], f[4], 3);
    if (lat === null || lon === null) return null;
    const msl = num(f[8]);
    const geoid = num(f[10]);
    const hdop = num(f[7]) ?? this.gsaHdop;
    const now = this.now();
    const today =
      this.day ??
      Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate(),
      );
    let fixAt = timeOn(today, f[0]) ?? now;
    // A time just after midnight read against yesterday's date.
    if (fixAt - now > 12 * 3600 * 1000) fixAt -= 24 * 3600 * 1000;
    const fromReceiver = this.hRms !== null;
    const estimate = hdop !== null ? hdop * (UERE[fixType] ?? 4) : null;
    return {
      lat,
      lon,
      altitudeM: msl !== null ? msl + (geoid ?? 0) : null,
      fixType,
      satellites: num(f[6]),
      hdop,
      pdop: this.pdop,
      vdop: this.vdop,
      correctionAgeS: num(f[12]),
      stationId: f[13]?.trim() ? f[13].trim() : null,
      hRmsM: this.hRms,
      vRmsM: this.vRms,
      accuracyM: this.hRms ?? estimate ?? 10,
      accuracyFromReceiver: fromReceiver,
      speedMps: this.speedMps,
      courseDeg: this.courseDeg,
      fixAt,
    };
  }
}
