// SPDX-License-Identifier: AGPL-3.0-or-later
import { NmeaFixBuilder, parseSentence } from './nmea';

/** Wrap a sentence body with `$` and its checksum. */
function s(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) sum ^= body.charCodeAt(i);
  return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
}

const NOW = Date.UTC(2026, 10, 23, 18, 0, 0);

describe('parseSentence', () => {
  it('checks the checksum and strips the talker', () => {
    expect(parseSentence(s('GNGGA,1,2'))).toEqual({ type: 'GGA', fields: ['1', '2'] });
    expect(parseSentence('$GNGGA,1,2*00')).toBeNull();
    expect(parseSentence('garbage')).toBeNull();
  });
});

describe('NmeaFixBuilder', () => {
  it('builds an RTK fix with receiver error estimates', () => {
    const b = new NmeaFixBuilder(() => NOW);
    expect(
      b.push(s('GNRMC,175959.00,A,3355.1234,N,11701.5678,W,1.944,90.0,231126,,,R')),
    ).toBeNull();
    expect(b.push(s('GNGSA,A,3,01,02,03,04,05,06,07,08,,,,,1.20,0.70,0.95'))).toBeNull();
    expect(b.push(s('GNGST,175959.00,0.5,0.02,0.01,45.0,0.012,0.016,0.030'))).toBeNull();
    const fix = b.push(
      s('GNGGA,175959.00,3355.1234,N,11701.5678,W,4,18,0.70,450.20,M,-32.10,M,1.0,0042'),
    )!;
    expect(fix.lat).toBeCloseTo(33 + 55.1234 / 60, 8);
    expect(fix.lon).toBeCloseTo(-(117 + 1.5678 / 60), 8);
    expect(fix.fixType).toBe(4);
    expect(fix.satellites).toBe(18);
    expect(fix.altitudeM).toBeCloseTo(418.1, 6);
    expect(fix.pdop).toBe(1.2);
    expect(fix.vdop).toBe(0.95);
    expect(fix.hdop).toBe(0.7);
    expect(fix.correctionAgeS).toBe(1);
    expect(fix.stationId).toBe('0042');
    expect(fix.hRmsM).toBeCloseTo(0.02, 6);
    expect(fix.vRmsM).toBe(0.03);
    expect(fix.accuracyM).toBeCloseTo(0.02, 6);
    expect(fix.accuracyFromReceiver).toBe(true);
    expect(fix.speedMps).toBeCloseTo(1, 3);
    expect(fix.courseDeg).toBe(90);
    expect(fix.fixAt).toBe(Date.UTC(2026, 10, 23, 17, 59, 59));
  });

  it('estimates accuracy from HDOP without GST, and skips a no-fix line', () => {
    const b = new NmeaFixBuilder(() => NOW);
    expect(b.push(s('GPGGA,175959,3355.0,N,11701.0,W,0,0,,,M,,M,,'))).toBeNull();
    const fix = b.push(s('GPGGA,175959,3355.0,S,11701.0,E,1,7,1.5,100.0,M,,M,,'))!;
    expect(fix.lat).toBeLessThan(0);
    expect(fix.lon).toBeGreaterThan(0);
    expect(fix.accuracyFromReceiver).toBe(false);
    expect(fix.accuracyM).toBeCloseTo(6, 6);
    expect(fix.stationId).toBeNull();
  });
});
