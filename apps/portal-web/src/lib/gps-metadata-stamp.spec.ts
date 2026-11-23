// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureField } from '@gratis-gis/shared-types';

import { stampGpsMetadata } from '@/app/items/[id]/field/gps-metadata-stamp';
import { positionFromGnss, type GpsPosition } from '@/app/items/[id]/field/use-geolocation';

const field = (name: string, type: FeatureField['type'] = 'number'): FeatureField => ({
  name,
  label: name,
  type,
  nullable: true,
});

const device: GpsPosition = {
  lon: -117,
  lat: 34,
  accuracyM: 4,
  altitudeM: null,
  altitudeAccuracyM: null,
  headingDeg: null,
  speedMps: 2,
  fixAt: Date.UTC(2026, 10, 23),
};

const receiver = positionFromGnss(
  {
    lat: 34,
    lon: -117,
    altitudeM: 400,
    fixType: 4,
    satellites: 18,
    hdop: 0.7,
    pdop: 1.2,
    vdop: 0.9,
    correctionAgeS: 1,
    stationId: '42',
    hRmsM: 0.02,
    vRmsM: 0.03,
    accuracyM: 0.02,
    accuracyFromReceiver: true,
    speedMps: 1,
    courseDeg: 90,
    fixAt: Date.UTC(2026, 10, 23),
  },
  'Bluetooth receiver',
);

describe('stampGpsMetadata with a receiver', () => {
  it('fills Field Maps esrignss columns', () => {
    const fields = [
      field('esrignss_fixtype'),
      field('esrignss_numsats'),
      field('esrignss_h_rms'),
      field('esrignss_v_rms'),
      field('esrignss_pdop'),
      field('esrignss_stationid', 'string'),
      field('esrignss_receiver', 'string'),
      field('esrignss_positionsourcetype'),
      field('esrignss_speed'),
      field('esrignss_latitude'),
    ];
    const out = stampGpsMetadata(fields, {}, receiver);
    expect(out).toMatchObject({
      esrignss_fixtype: 4,
      esrignss_numsats: 18,
      esrignss_h_rms: 0.02,
      esrignss_v_rms: 0.03,
      esrignss_pdop: 1.2,
      esrignss_stationid: '42',
      esrignss_receiver: 'Bluetooth receiver',
      esrignss_positionsourcetype: 3,
      esrignss_latitude: 34,
    });
    expect(out.esrignss_speed).toBeCloseTo(3.6, 6);
  });

  it('writes the fix type as text into a text column', () => {
    expect(stampGpsMetadata([field('fix_type', 'string')], {}, receiver)).toEqual({
      fix_type: 'RTK fixed',
    });
  });

  it('leaves receiver-only columns empty on a device fix', () => {
    const out = stampGpsMetadata(
      [
        field('esrignss_fixtype'),
        field('esrignss_positionsourcetype'),
        field('position_source_type', 'string'),
      ],
      {},
      device,
    );
    expect(out).toEqual({
      esrignss_positionsourcetype: 2,
      position_source_type: 'browser-geolocation',
    });
  });
});
