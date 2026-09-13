// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The field engine surface.
 *
 * Everything the native field client needs to decide about a record
 * (is it valid, what is visible, what does a queued edit fold to, is
 * a row claimable, how does an HTTP status classify) lives in
 * `packages/form-schema` and `packages/shared-types` and already runs
 * unchanged on the server and in the web client. This file puts a
 * flat, JSON-in JSON-out face on those functions, and build.mjs turns
 * it into one dependency-free script that an embedded JS engine on
 * the phone loads at startup. The Kotlin side never reimplements any
 * of it; it marshals data classes to JSON and calls `call`.
 *
 * Rules for this file, in order of how much they matter:
 *
 *   1. Nothing here decides anything. A function in SURFACE unpacks
 *      one argument object, calls the shared implementation, and
 *      returns its result. If you find yourself writing an `if` that
 *      is not about argument shape, it belongs in the package that
 *      owns the behaviour.
 *   2. The names in SURFACE and the argument shapes are shipped
 *      contract. An installed app calls them by string. Add freely;
 *      rename or reshape only with an ENGINE_VERSION bump and a note
 *      in the README.
 *   3. Sibling packages are imported by relative SOURCE path, not by
 *      package name. esbuild then tree-shakes ESM modules instead of
 *      swallowing a CommonJS dist whole, and the bundle carries the
 *      files listed in docs/mobile-field-app.md and nothing else.
 *   4. No platform globals. The bundle runs where there is no
 *      `console`, no timers, no `TextEncoder` and no `fetch`. The
 *      spec loads it into a bare vm context to prove that.
 *   5. Time is an argument. Anything that depends on the clock takes
 *      `nowMs` from the caller, so the host controls it and tests are
 *      deterministic. (The form builtins `today` / `now` are the one
 *      exception, and they are the same exception on the web.)
 */

import {
  ENGINE_VERSION,
  applyCalculations,
  engineRequirement,
  evaluateFormState,
  generateFormFromLayer,
  pruneHidden,
  validate,
  type AutoFormOptions,
  type FormSchema,
  type LayerForGeneration,
  type Response,
} from '../../form-schema/src/index';
import {
  validateFeatureProperties,
  type ValidateFeatureOptions,
} from '../../shared-types/src/feature-validate';
import type { FeatureField } from '../../shared-types/src/data-layer';
import {
  isServerStampedField,
  stampSubmissionMetadata,
  type SubmissionStampContext,
} from '../../shared-types/src/submission-stamp';
import { matchesFilter } from '../../shared-types/src/filter-match';
import type { MapLayerFilter } from '../../shared-types/src/map';
import { foldQueuedChain, foldQueuedEdits, type FoldableEdit } from '../../shared-types/src/queue-fold';
import {
  QUEUE_CLAIM_STALE_MS,
  isQueueRowClaimable,
  isQueueRowOwnedBy,
  queueChainHeads,
  queueRetryDelayMs,
  type ClaimOptions,
  type OwnedRow,
  type ReplayableRow,
} from '../../shared-types/src/queue-replay';
import { replayOutcomeForStatus } from '../../shared-types/src/sync-outcome';
import { sanitizeOfflineMessage } from '../../shared-types/src/offline-message';

/**
 * Every function the host can call, keyed by its wire name. Each takes
 * exactly one JSON-shaped argument object and returns a JSON-shaped
 * value. Grouped by prefix: `engine.`, `form.`, `feature.`, `filter.`,
 * `queue.`, `sync.`, `message.`.
 */
export const SURFACE = {
  /** Which engine this is. The host compares `engineVersion` against
   *  the `requiredEngineVersion` stamped on each form. */
  'engine.info': (): {
    engineVersion: number;
    queueClaimStaleMs: number;
    functions: string[];
  } => ({
    engineVersion: ENGINE_VERSION,
    queueClaimStaleMs: QUEUE_CLAIM_STALE_MS,
    functions: SURFACE_NAMES,
  }),

  /** The engine version a form needs, and what this build did not
   *  recognise in it. */
  'form.requirement': (a: { form: FormSchema }) => engineRequirement(a.form),

  /** Validate a response. Same result the server produces on submit. */
  'form.validate': (a: { form: FormSchema; response: Response }) =>
    validate(a.form, a.response),

  /** Visible / required / read-only for every question occurrence. */
  'form.state': (a: { form: FormSchema; response: Response }) =>
    evaluateFormState(a.form, a.response),

  /** Recompute every `calculate` and return the updated response. */
  'form.applyCalculations': (a: { form: FormSchema; response: Response }) =>
    applyCalculations(a.form, a.response),

  /** Strip hidden questions' values before submit. */
  'form.pruneHidden': (a: { form: FormSchema; response: Response }) =>
    pruneHidden(a.form, a.response),

  /** The no-authoring fallback: a form derived from a layer schema. */
  'form.fromLayer': (a: { layer: LayerForGeneration; options: AutoFormOptions }) =>
    generateFormFromLayer(a.layer, a.options),

  /** Validate and coerce feature attributes against a layer schema.
   *  Persist `value`, not the input, when `ok`. */
  'feature.validate': (a: {
    fields?: FeatureField[];
    properties?: Record<string, unknown>;
    options?: ValidateFeatureOptions;
  }) => validateFeatureProperties(a.fields, a.properties, a.options ?? {}),

  /** Fill `submitted_at` / `submitted_by` where the layer declares them. */
  'feature.stamp': (a: {
    fields?: FeatureField[];
    properties: Record<string, unknown>;
    context: SubmissionStampContext;
  }) => stampSubmissionMetadata(a.fields, a.properties, a.context),

  /** Whether a column is one the server fills, so no form should ask. */
  'feature.isServerStampedField': (a: { name: string }) => isServerStampedField(a.name),

  /** Evaluate a map layer filter against one row's attributes. */
  'filter.matches': (a: {
    properties?: Record<string, unknown> | null;
    filter?: MapLayerFilter | null;
  }) => matchesFilter(a.properties, a.filter),

  /** Fold a new edit onto an unsynced prior edit of the same feature. */
  'queue.fold': (a: { prior: FoldableEdit; next: FoldableEdit }) =>
    foldQueuedEdits(a.prior, a.next),

  /** Fold a whole chain of edits, oldest first. */
  'queue.foldChain': (a: { chain: FoldableEdit[] }) => foldQueuedChain(a.chain),

  /** Backoff after this many failures, in milliseconds. */
  'queue.retryDelayMs': (a: { retryCount?: number }) => queueRetryDelayMs(a.retryCount),

  /** Whether a queued row may be picked up at `nowMs`. */
  'queue.isClaimable': (a: { row: ReplayableRow; nowMs: number; options?: ClaimOptions }) =>
    isQueueRowClaimable(a.row, a.nowMs, a.options ?? {}),

  /** Whether the signed-in account may see or send this row. */
  'queue.isOwnedBy': (a: { row: OwnedRow; currentUserId: string | null }) =>
    isQueueRowOwnedBy(a.row, a.currentUserId),

  /** The rows to replay this pass: at most one per feature, oldest
   *  first, and only when that oldest row is claimable. Rows come
   *  back as given, so the host can carry any extra fields through. */
  'queue.chainHeads': <T extends ReplayableRow>(a: {
    rows: T[];
    nowMs: number;
    options?: ClaimOptions;
  }) => queueChainHeads(a.rows, a.nowMs, a.options ?? {}),

  /** Classify the HTTP status of a replayed edit: done, retry, rejected. */
  'sync.outcome': (a: { status: number; op: 'insert' | 'update' | 'delete' }) =>
    replayOutcomeForStatus(a.status, a.op),

  /** Coerce a stored sync message into the code-plus-params envelope. */
  'message.sanitize': (a: { message: unknown }) => sanitizeOfflineMessage(a.message),
} as const;

export type SurfaceName = keyof typeof SURFACE;

/** Sorted so `engine.info` is stable across builds. */
export const SURFACE_NAMES: string[] = Object.keys(SURFACE).sort();

export type CallResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: { code: 'unknown-function' | 'bad-argument' | 'threw'; message: string };
    };

/**
 * The one entry point the host binds. String in, string out, never
 * throws: a host that has to handle a JS exception across a JNI
 * boundary is a host with a crash it cannot attribute. Errors come
 * back as data with a code the host can switch on.
 *
 * `argsJson` is the JSON text of the function's single argument
 * object; `"{}"` when it takes none.
 */
export function call(name: string, argsJson: string): string {
  return JSON.stringify(callParsed(name, argsJson));
}

function callParsed(name: string, argsJson: string): CallResult {
  if (!Object.prototype.hasOwnProperty.call(SURFACE, name)) {
    return {
      ok: false,
      error: { code: 'unknown-function', message: `No such function: ${name}` },
    };
  }
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch (e) {
    return { ok: false, error: { code: 'bad-argument', message: describe(e) } };
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      error: { code: 'bad-argument', message: 'Argument must be a JSON object' },
    };
  }
  try {
    const fn = SURFACE[name as SurfaceName] as (a: unknown) => unknown;
    const result = fn(args);
    return { ok: true, result: result === undefined ? null : result };
  } catch (e) {
    return { ok: false, error: { code: 'threw', message: describe(e) } };
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export { ENGINE_VERSION };
