// SPDX-License-Identifier: AGPL-3.0-or-later
import { isOwnEditEcho, replayOutcomeForStatus } from './sync-outcome.js';

describe('replayOutcomeForStatus', () => {
  it('treats any 2xx as done', () => {
    expect(replayOutcomeForStatus(200, 'insert')).toBe('done');
    expect(replayOutcomeForStatus(201, 'insert')).toBe('done');
    expect(replayOutcomeForStatus(204, 'delete')).toBe('done');
  });

  it('treats a 404 on delete as done, and on anything else as rejected', () => {
    expect(replayOutcomeForStatus(404, 'delete')).toBe('done');
    expect(replayOutcomeForStatus(404, 'update')).toBe('rejected');
    expect(replayOutcomeForStatus(404, 'insert')).toBe('rejected');
  });

  it('parks deterministic refusals', () => {
    // The validator (400), sharing (403), a conflict (409), a body
    // cap (413), and a semantic refusal (422) all answer the same
    // way to the same bytes, so retrying cannot help.
    for (const s of [400, 403, 405, 409, 413, 415, 422]) {
      expect(replayOutcomeForStatus(s, 'insert')).toBe('rejected');
    }
  });

  it('keeps transient 4xx retryable', () => {
    for (const s of [401, 408, 425, 429]) {
      expect(replayOutcomeForStatus(s, 'update')).toBe('retry');
    }
  });

  it('keeps 5xx and anything unexpected retryable', () => {
    expect(replayOutcomeForStatus(500, 'insert')).toBe('retry');
    expect(replayOutcomeForStatus(502, 'insert')).toBe('retry');
    expect(replayOutcomeForStatus(503, 'delete')).toBe('retry');
    expect(replayOutcomeForStatus(0, 'insert')).toBe('retry');
    expect(replayOutcomeForStatus(302, 'insert')).toBe('retry');
  });
});

describe('isOwnEditEcho', () => {
  const point = { type: 'Point', coordinates: [-120.123456789, 38.5] };

  it('treats a 409 whose current already holds the queued values as done', () => {
    expect(
      isOwnEditEcho(
        { op: 'update', geometry: point, properties: { status: 'done', count: 3 } },
        {
          geometry: { type: 'Point', coordinates: [-120.1234567890001, 38.5] },
          properties: {
            status: 'done',
            count: 3,
            other: 'kept',
            _observation_id: 'mine',
          },
        },
      ),
    ).toBe(true);
  });

  it('is a real conflict when any queued value differs', () => {
    expect(
      isOwnEditEcho(
        { op: 'update', geometry: null, properties: { status: 'done' } },
        { geometry: point, properties: { status: 'open' } },
      ),
    ).toBe(false);
  });

  it('is a real conflict when the geometry moved', () => {
    expect(
      isOwnEditEcho(
        { op: 'update', geometry: point, properties: {} },
        { geometry: { type: 'Point', coordinates: [-120.1, 38.5] }, properties: {} },
      ),
    ).toBe(false);
  });

  it('never applies to a delete or a deleted feature', () => {
    expect(isOwnEditEcho({ op: 'delete', geometry: null, properties: null }, { properties: {} })).toBe(false);
    expect(isOwnEditEcho({ op: 'update', geometry: null, properties: {} }, null)).toBe(false);
  });

  it('treats a missing key and null as the same value', () => {
    expect(
      isOwnEditEcho(
        { op: 'update', geometry: null, properties: { note: null } },
        { properties: {} },
      ),
    ).toBe(true);
  });
});
