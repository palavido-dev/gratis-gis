// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fill the submission bookkeeping columns a layer declares.
 *
 * Every form gets a paired data_layer whose "submissions" sublayer
 * declares `submitted_at`, `submitted_by` and `schema_version`. Two
 * different writers land rows there and only one of them filled those
 * columns:
 *
 *  - An online form post goes through the forms service, which stamps
 *    all three from the submission envelope.
 *  - The field runtime writes straight to the layer's feature endpoint
 *    with the raw form response, so its rows arrived with all three
 *    empty. Nothing complained, because nothing validated writes; the
 *    only visible trace was the responses view quietly falling back to
 *    `_created_at` when `submitted_at` was missing.
 *
 * So an offline-captured submission and an online one produced
 * different rows for the same act. This closes that: the field runtime
 * stamps what it knows before it writes, online and queued alike.
 *
 * `schema_version` is deliberately NOT stamped here. It records which
 * form schema a response was captured against, and the forms service
 * rejects a submission whose version does not match the form's current
 * one. Inventing a value would defeat that check, so a direct feature
 * write leaves it empty and the paired-layer template no longer marks
 * it required.
 *
 * Lives here rather than in the field runtime so it can be tested:
 * whether the writer satisfies a column the schema declares is exactly
 * the kind of thing that fails silently.
 */

import type { FeatureField } from './data-layer';

/** Columns this fills, and where each value comes from. */
export interface SubmissionStampContext {
  /** Id of the person submitting. Lands in `submitted_by`. */
  userId: string;
  /**
   * When the observation was CAPTURED, not when it synced. Offline is
   * the only place that knows the difference, and it is the difference
   * that matters: a row captured in the field on Tuesday and synced on
   * Friday is a Tuesday observation.
   */
  capturedAt: string;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Declared columns the server fills on create, so no form should ask
 * a person for them. The map builder's New feature form once did: it
 * rendered `submitted_at` as a required date input and refused to
 * submit until the user typed one, for a value portal-api was about
 * to stamp anyway. `schema_version` is listed too: it is set only by
 * the forms service and stays blank on a direct feature write, and a
 * person has nothing correct to put in it.
 */
export const SERVER_STAMPED_FIELDS: ReadonlySet<string> = new Set([
  'submitted_at',
  'submitted_by',
  'schema_version',
]);

export function isServerStampedField(name: string): boolean {
  return SERVER_STAMPED_FIELDS.has(name);
}

/**
 * Return a copy of `properties` with `submitted_at` / `submitted_by`
 * filled in, for whichever of them the layer actually declares.
 *
 * Two rules, both matching `stampGpsMetadata`, which solves the same
 * shape of problem for GPS columns:
 *
 *  - Only columns the layer declares are written. A layer the field
 *    runtime collects into is often not form-paired at all, and
 *    inventing columns would put values somewhere the attribute table
 *    never shows them.
 *  - A value already present wins. The stamp fills blanks; it does not
 *    overwrite a form that asked the user for one of these.
 */
export function stampSubmissionMetadata(
  fields: ReadonlyArray<FeatureField> | undefined,
  properties: Record<string, unknown>,
  ctx: SubmissionStampContext,
): Record<string, unknown> {
  if (!fields || fields.length === 0) return properties;
  const out = { ...properties };
  for (const field of fields) {
    if (!isBlank(out[field.name])) continue;
    if (field.name === 'submitted_at') out[field.name] = ctx.capturedAt;
    else if (field.name === 'submitted_by') out[field.name] = ctx.userId;
  }
  return out;
}
