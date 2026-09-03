// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isServerStampedField,
  SERVER_STAMPED_FIELDS,
  stampSubmissionMetadata,
} from './submission-stamp.js';
import { validateFeatureProperties } from './feature-validate.js';
import type { FeatureField } from './data-layer.js';

/**
 * The paired-layer template every form gets. `submitted_at` is
 * required, which is the whole reason this stamp has to exist: the
 * field runtime writes to the feature endpoint directly, so if it does
 * not fill that column the write is rejected.
 */
const SUBMISSIONS_FIELDS: FeatureField[] = [
  { name: 'submitted_at', type: 'date', label: 'Submitted at', nullable: false },
  { name: 'submitted_by', type: 'string', label: 'Submitted by', nullable: true },
  { name: 'schema_version', type: 'number', label: 'Schema version', nullable: true },
  { name: 'issue_type', type: 'string', label: 'Issue type', nullable: true },
];

const CTX = { userId: 'user-1', capturedAt: '2026-08-24T13:47:33.351Z' };

describe('stampSubmissionMetadata', () => {
  it('fills the bookkeeping columns the layer declares', () => {
    const out = stampSubmissionMetadata(
      SUBMISSIONS_FIELDS,
      { issue_type: 'washout' },
      CTX,
    );
    expect(out.submitted_at).toBe(CTX.capturedAt);
    expect(out.submitted_by).toBe('user-1');
    expect(out.issue_type).toBe('washout');
  });

  it('produces a row that passes create validation', () => {
    // The point of the whole exercise. Without the stamp this exact
    // payload is what the field runtime used to send, and it is what
    // the 2026-08-24 row on the demo looks like.
    const raw = { issue_type: 'washout' };
    expect(
      validateFeatureProperties(SUBMISSIONS_FIELDS, raw, { mode: 'create' }).ok,
    ).toBe(false);
    expect(
      validateFeatureProperties(
        SUBMISSIONS_FIELDS,
        stampSubmissionMetadata(SUBMISSIONS_FIELDS, raw, CTX),
        { mode: 'create' },
      ).ok,
    ).toBe(true);
  });

  it('does not invent columns the layer does not declare', () => {
    // The field runtime collects into ordinary data layers too, not
    // only form-paired ones. Writing these onto a layer that never
    // declared them would put values where nothing displays them.
    const out = stampSubmissionMetadata(
      [{ name: 'species', type: 'string', label: 'Species', nullable: true }],
      { species: 'oak' },
      CTX,
    );
    expect(out).toEqual({ species: 'oak' });
  });

  it('leaves a value the form already supplied alone', () => {
    const out = stampSubmissionMetadata(
      SUBMISSIONS_FIELDS,
      { submitted_at: '2020-01-01T00:00:00.000Z' },
      CTX,
    );
    expect(out.submitted_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('treats blank text as unfilled', () => {
    const out = stampSubmissionMetadata(
      SUBMISSIONS_FIELDS,
      { submitted_at: '   ' },
      CTX,
    );
    expect(out.submitted_at).toBe(CTX.capturedAt);
  });

  it('never stamps schema_version', () => {
    // It records which form schema the response was captured against,
    // and the forms service rejects a mismatch. A direct feature write
    // cannot know it, and guessing would defeat that check.
    const out = stampSubmissionMetadata(SUBMISSIONS_FIELDS, {}, CTX);
    expect(out.schema_version).toBeUndefined();
  });

  it('is a no-op on a layer with no declared fields', () => {
    expect(stampSubmissionMetadata(undefined, { a: 1 }, CTX)).toEqual({ a: 1 });
    expect(stampSubmissionMetadata([], { a: 1 }, CTX)).toEqual({ a: 1 });
  });
});

describe('isServerStampedField', () => {
  it('covers exactly the columns the stamp and the forms service fill', () => {
    // A form must never ask a person for these; the map builder's New
    // feature form once required submitted_at and refused to submit.
    expect([...SERVER_STAMPED_FIELDS].sort()).toEqual([
      'schema_version',
      'submitted_at',
      'submitted_by',
    ]);
    expect(isServerStampedField('submitted_at')).toBe(true);
    expect(isServerStampedField('issue_type')).toBe(false);
    expect(isServerStampedField('_created_at')).toBe(false);
  });
});
