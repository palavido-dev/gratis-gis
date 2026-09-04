// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  SMART_DETECT_LIMITS,
  detectCsvColumnPair,
  detectCsvColumnPairFromPrefix,
} from './csv-smart-detect';

/**
 * The detection half, split out from emission so the ingest path can
 * name a CSV's coordinate columns from a fixed prefix and then hand
 * those names to GDAL, instead of materialising the whole file as a
 * FeatureCollection (which does not survive the 1 GB upload cap).
 *
 * The prefix cases are the point: everything the detector needs is in
 * the header plus a sample, so cutting the file mid-row must not
 * change its answer.
 */
describe('detectCsvColumnPair', () => {
  it('names the pair without emitting features', () => {
    const r = detectCsvColumnPair('LAT,LNG,NAME\n40.5,-79.2,a\n41.0,-80.0,b\n');
    expect(r.kind).toBe('detected');
    if (r.kind !== 'detected') return;
    expect(r.latColumn).toBe('LAT');
    expect(r.lngColumn).toBe('LNG');
    expect(r.latIndex).toBe(0);
    expect(r.lngIndex).toBe(1);
    expect(r).not.toHaveProperty('geojson');
  });

  it('reports the delimiter it sniffed', () => {
    const r = detectCsvColumnPair('lat\tlon\tn\n40.5\t-79.2\ta\n41\t-80\tb\n');
    expect(r.kind).toBe('detected');
    if (r.kind !== 'detected') return;
    expect(r.delimiter).toBe('\t');
  });

  it('declines a file with no coordinate-looking columns', () => {
    const r = detectCsvColumnPair('name,qty\nwidget,3\ncog,4\n');
    expect(r.kind).toBe('no-coords');
  });

  it('declines when the values are out of coordinate range', () => {
    // Named right, but these are not degrees. Importing them as
    // points would put the data in the ocean, silently.
    const r = detectCsvColumnPair('lat,lng\n5000,9000\n5100,9100\n');
    expect(r.kind).toBe('no-coords');
  });
});

describe('detectCsvColumnPairFromPrefix', () => {
  /** A file far longer than any prefix we would read. */
  function bigCsv(rows: number): string {
    let out = 'id,LAT,LNG,note\n';
    for (let i = 0; i < rows; i += 1) {
      out += `${i},${40 + (i % 10) / 100},${-79 - (i % 10) / 100},row ${i}\n`;
    }
    return out;
  }

  it('finds the pair in a prefix of a large file', () => {
    const whole = Buffer.from(bigCsv(50_000), 'utf8');
    const prefix = whole.subarray(0, 64 * 1024);
    expect(prefix.length).toBeLessThan(whole.length);

    const r = detectCsvColumnPairFromPrefix(prefix, true);
    expect(r.kind).toBe('detected');
    if (r.kind !== 'detected') return;
    expect(r.latColumn).toBe('LAT');
    expect(r.lngColumn).toBe('LNG');
  });

  it('gives the same answer from a prefix as from the whole file', () => {
    const whole = Buffer.from(bigCsv(50_000), 'utf8');
    const fromWhole = detectCsvColumnPair(whole.toString('utf8'));
    const fromPrefix = detectCsvColumnPairFromPrefix(
      whole.subarray(0, 64 * 1024),
      true,
    );
    expect(fromPrefix).toMatchObject({
      kind: 'detected',
      latColumn: (fromWhole as { latColumn: string }).latColumn,
      lngColumn: (fromWhole as { lngColumn: string }).lngColumn,
    });
  });

  it('survives a cut mid-row', () => {
    const csv = 'LAT,LNG,name\n40.5,-79.2,alpha\n41.0,-80.0,brav';
    const r = detectCsvColumnPairFromPrefix(Buffer.from(csv, 'utf8'), true);
    expect(r.kind).toBe('detected');
  });

  it('survives a cut mid multi-byte character', () => {
    const csv = 'LAT,LNG,name\n40.5,-79.2,alpha\n41.0,-80.0,café';
    const buf = Buffer.from(csv, 'utf8');
    // Drop the final byte of the two-byte 'é'.
    const r = detectCsvColumnPairFromPrefix(buf.subarray(0, buf.length - 1), true);
    expect(r.kind).toBe('detected');
  });

  it('keeps the last line when the buffer is the whole file', () => {
    // Not truncated, so the final row is real data and counts toward
    // the validation sample. With only one data row, dropping it
    // would fail detection.
    const csv = 'LAT,LNG\n40.5,-79.2\n';
    expect(detectCsvColumnPairFromPrefix(Buffer.from(csv, 'utf8'), false).kind).toBe(
      'detected',
    );
  });

  it('declines a prefix that holds only the header', () => {
    const r = detectCsvColumnPairFromPrefix(
      Buffer.from('LAT,LNG,name\n', 'utf8'),
      true,
    );
    expect(r.kind).toBe('no-coords');
  });

  it('needs no more than the sampled rows to decide', () => {
    // Guards the premise behind reading a fixed prefix at all.
    const rows = SMART_DETECT_LIMITS.VALIDATION_SAMPLE_ROWS;
    let csv = 'LAT,LNG\n';
    for (let i = 0; i < rows; i += 1) csv += `40.${i},-79.${i}\n`;
    expect(detectCsvColumnPair(csv).kind).toBe('detected');
  });
});
