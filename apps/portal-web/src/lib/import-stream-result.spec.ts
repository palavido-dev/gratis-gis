// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ImportStreamError,
  importStreamErrorText,
  readImportStreamResult,
} from './import-stream-result';

const lines = (...evs: object[]) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('readImportStreamResult', () => {
  it('returns the done event of a multi-line success stream', () => {
    const body = lines(
      { event: 'start', total: 3 },
      { event: 'progress', processed: 3, total: 3 },
      { event: 'done', driver: 'GeoJSON', sourceLayer: null, inserted: 3, mode: 'append' },
    );
    expect(readImportStreamResult(body)).toEqual({
      event: 'done',
      driver: 'GeoJSON',
      sourceLayer: null,
      inserted: 3,
      mode: 'append',
    });
  });

  it('throws the server message for an error line, even alone under 200', () => {
    expect(() =>
      readImportStreamResult(lines({ event: 'error', message: 'That item or layer was not found.' })),
    ).toThrow(new ImportStreamError('That item or layer was not found.'));
    expect(() =>
      readImportStreamResult(
        lines({ event: 'start' }, { event: 'error', message: 'Ingest failed.' }),
      ),
    ).toThrow('Ingest failed.');
  });

  it('throws when the stream ends without a terminal event', () => {
    expect(() =>
      readImportStreamResult(lines({ event: 'start' }) + '{"event":"progr'),
    ).toThrow(ImportStreamError);
    expect(() => readImportStreamResult('')).toThrow(ImportStreamError);
  });

  it('keeps the replaced count of a replace import', () => {
    const out = readImportStreamResult(
      lines({ event: 'done', driver: 'CSV', inserted: 2, mode: 'replace', replaced: 5 }),
    );
    expect(out.replaced).toBe(5);
  });
});

describe('importStreamErrorText', () => {
  it('reads the message of an NDJSON or a Nest error body', () => {
    expect(importStreamErrorText(403, lines({ event: 'error', status: 403, message: 'No.' }))).toBe('No.');
    expect(importStreamErrorText(400, JSON.stringify({ statusCode: 400, message: 'Bad file.' }))).toBe('Bad file.');
    expect(importStreamErrorText(502, '<html>')).toBe('Import failed (502).');
  });
});
