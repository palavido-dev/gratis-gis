// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every sentence the offline field arc can produce, as a code plus its
 * parameters instead of as English text.
 *
 * The download manager and the two queue drains write text that is both
 * shown live AND persisted: a shortfall reason lands in
 * `CachedDeployment.partial.reasons` in IndexedDB, and a replay failure
 * lands on the queue row, where the rejected-edits dialog, the field
 * runtime and the admin field-queues view read it back days later.
 * Swapping a translation key in at the render site fixes neither: the
 * bytes already on a device are English, and the admin reading them is
 * not necessarily the collector who wrote them.
 *
 * So the producers write one of these, and rendering happens at the
 * edge (`portal-web/src/lib/offline-message.ts`). A row written on a
 * German phone and read by a French admin renders in French.
 *
 * Three things earn their keep here rather than in portal-web:
 *
 *   - the API DTO (`apps/portal-api/src/field-queue/`) validates the
 *     same shape the client posts,
 *   - the admin view reads the same type back,
 *   - `public/sw.js` cannot import TypeScript and mirrors the codes it
 *     writes by hand, so `sw-contract.spec.ts` needs both lists in one
 *     place to compare.
 *
 * TRANSLATION: every code needs `offlineMessage.<code>` in
 * `portal-web/src/lib/i18n/messages/en.ts` and in all four other
 * catalogs; `offline-message.spec.ts` renders every code and fails on a
 * leftover `{placeholder}`.
 */

/**
 * Text this build cannot describe any other way.
 *
 * Two sources, deliberately sharing one code because the renderer does
 * the same thing with both: a string persisted by a build that predates
 * codes (the IndexedDB v4 upgrade rewrites those into this shape), and
 * the API's own sentence, which the server chose and which no client
 * can translate.
 */
export interface OfflineLegacyTextParams {
  text: string;
}

/** The counts the download summary reports. */
export interface OfflineDownloadDoneParams {
  layers: number;
  features: number;
  forms: number;
  pickLists: number;
}

/**
 * Every message, discriminated by `code`.
 *
 * Grouped by producer: `download.*` comes from `offline-download.ts`
 * and the field runtime's own download bookkeeping, `sync.*` from
 * `offline-sync.ts` and the service worker's drain.
 */
export type OfflineMessage =
  // Text with no code of its own.
  | { code: 'legacy.text'; params: OfflineLegacyTextParams }
  // Download progress.
  | { code: 'download.estimating' }
  | { code: 'download.estimated'; params: { bytes: number } }
  | { code: 'download.fetchingLayer'; params: { layer: string } }
  | { code: 'download.layerCached'; params: { layer: string; count: number } }
  | { code: 'download.layerHttpError'; params: { layer: string; status: number } }
  | { code: 'download.layerMalformed'; params: { layer: string } }
  | { code: 'download.layerOutOfSpace'; params: { layer: string } }
  | { code: 'download.layerFailed'; params: { layer: string; error: string } }
  | { code: 'download.fetchingForm'; params: { form: string } }
  | { code: 'download.formHttpError'; params: { form: string; status: number } }
  | { code: 'download.formNoSchema'; params: { form: string } }
  | { code: 'download.formFailed'; params: { form: string } }
  | { code: 'download.fetchingPickList'; params: { pickList: string } }
  | {
      code: 'download.pickListHttpError';
      params: { pickList: string; status: number };
    }
  | { code: 'download.pickListNoData'; params: { pickList: string } }
  | { code: 'download.pickListFailed'; params: { pickList: string } }
  // The prepared-basemap phase names which area it is on, and a
  // deployment with one area should not read "map 1 of 1", so the
  // single-area wording is its own code rather than a plural case:
  // the i18n runtime cannot nest a placeholder inside a plural body.
  | { code: 'download.basemapOne' }
  | { code: 'download.basemapNth'; params: { index: number; count: number } }
  | { code: 'download.basemapOnePercent'; params: { percent: number } }
  | {
      code: 'download.basemapNthPercent';
      params: { index: number; count: number; percent: number };
    }
  | { code: 'download.basemapOneMegabytes'; params: { megabytes: string } }
  | {
      code: 'download.basemapNthMegabytes';
      params: { index: number; count: number; megabytes: string };
    }
  | { code: 'download.basemapOutOfSpace' }
  | { code: 'download.basemapFailed'; params: { error: string } }
  | { code: 'download.basemapAreaMissing'; params: { area: string } }
  | { code: 'download.cachingTiles' }
  | { code: 'download.tilesProgress'; params: { fetched: number; total: number } }
  | { code: 'download.tilesRefused'; params: { reason: string } }
  | { code: 'download.tilesRefusedGeneric' }
  | { code: 'download.tilesCached'; params: { fetched: number; failed: number } }
  | { code: 'download.tilesOutOfSpace' }
  | { code: 'download.tilesFailed'; params: { error: string } }
  | { code: 'download.tilesMissing'; params: { count: number } }
  | { code: 'download.tilesMissingAll' }
  | { code: 'download.saving' }
  | { code: 'download.done'; params: OfflineDownloadDoneParams }
  | {
      code: 'download.donePartial';
      params: OfflineDownloadDoneParams & { missing: OfflineMessage[] };
    }
  | {
      code: 'download.donePartialOutOfSpace';
      params: { missing: OfflineMessage[] };
    }
  | { code: 'download.quotaRefused' }
  | { code: 'download.stopped' }
  | { code: 'download.failed' }
  // Queue replay.
  | { code: 'sync.networkUnavailable' }
  | { code: 'sync.networkUnavailableDetail'; params: { error: string } }
  | { code: 'sync.unknownOp'; params: { op: string } }
  | {
      code: 'sync.fileTooLarge';
      params: { fileName: string; sizeMb: string; limitMb: string };
    }
  // The server's own sentence. It named the field and what it would not
  // accept, in the language the server chose, and no client can
  // translate it; it is carried verbatim rather than thrown away.
  | { code: 'sync.serverRefused'; params: { serverMessage: string } }
  | {
      code: 'sync.serverRefusedWithStatus';
      params: { serverMessage: string; status: number };
    }
  | { code: 'sync.requestFailed'; params: { status: number } }
  | { code: 'sync.attachmentPresignFailed'; params: { status: number } }
  | { code: 'sync.attachmentUploadFailed'; params: { status: number } }
  | { code: 'sync.attachmentRegisterFailed'; params: { status: number } }
  | { code: 'sync.queueReadFailed' }
  | { code: 'sync.unexpected'; params: { error: string } };

/**
 * Every code, as a runtime list.
 *
 * Kept beside the union rather than derived from it, because a type
 * cannot be enumerated at runtime and both the sanitizer and the
 * service-worker contract spec need the values. `OFFLINE_MESSAGE_CODES`
 * and the union are pinned to each other by the assertion below, so
 * adding a member to one without the other fails typecheck.
 */
export const OFFLINE_MESSAGE_CODES = [
  'legacy.text',
  'download.estimating',
  'download.estimated',
  'download.fetchingLayer',
  'download.layerCached',
  'download.layerHttpError',
  'download.layerMalformed',
  'download.layerOutOfSpace',
  'download.layerFailed',
  'download.fetchingForm',
  'download.formHttpError',
  'download.formNoSchema',
  'download.formFailed',
  'download.fetchingPickList',
  'download.pickListHttpError',
  'download.pickListNoData',
  'download.pickListFailed',
  'download.basemapOne',
  'download.basemapNth',
  'download.basemapOnePercent',
  'download.basemapNthPercent',
  'download.basemapOneMegabytes',
  'download.basemapNthMegabytes',
  'download.basemapOutOfSpace',
  'download.basemapFailed',
  'download.basemapAreaMissing',
  'download.cachingTiles',
  'download.tilesProgress',
  'download.tilesRefused',
  'download.tilesRefusedGeneric',
  'download.tilesCached',
  'download.tilesOutOfSpace',
  'download.tilesFailed',
  'download.tilesMissing',
  'download.tilesMissingAll',
  'download.saving',
  'download.done',
  'download.donePartial',
  'download.donePartialOutOfSpace',
  'download.quotaRefused',
  'download.stopped',
  'download.failed',
  'sync.networkUnavailable',
  'sync.networkUnavailableDetail',
  'sync.unknownOp',
  'sync.fileTooLarge',
  'sync.serverRefused',
  'sync.serverRefusedWithStatus',
  'sync.requestFailed',
  'sync.attachmentPresignFailed',
  'sync.attachmentUploadFailed',
  'sync.attachmentRegisterFailed',
  'sync.queueReadFailed',
  'sync.unexpected',
] as const;

export type OfflineMessageCode = (typeof OFFLINE_MESSAGE_CODES)[number];

type BothWays<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
/** Fails typecheck as `never` when the union and the list disagree. */
const CODES_AGREE: BothWays<OfflineMessage['code'], OfflineMessageCode> = true;
void CODES_AGREE;

/**
 * The subset `public/sw.js` can produce.
 *
 * The worker replays feature edits only (it cannot run the presign +
 * PUT + register walk, so it never touches an attachment) and has no
 * download manager, which is why its list is four codes rather than all
 * of them. It declares the same list by hand; `sw-contract.spec.ts`
 * compares them, because a worker writing a code the renderer has never
 * heard of shows a field worker a fallback line instead of the reason
 * their edit was refused.
 */
export const SW_OFFLINE_MESSAGE_CODES = [
  'sync.requestFailed',
  'sync.serverRefused',
  'sync.serverRefusedWithStatus',
  'sync.unknownOp',
] as const;

const CODE_SET: ReadonlySet<string> = new Set(OFFLINE_MESSAGE_CODES);

/** Whether this build knows how to render `code`. */
export function isOfflineMessageCode(code: string): code is OfflineMessageCode {
  return CODE_SET.has(code);
}

/**
 * A message as it may ARRIVE, rather than as this build writes them.
 *
 * The code is a plain string because a device on a newer build can name
 * one this build has never heard of, and the whole point of persisting
 * the reason an edit was refused is that somebody reads it later. See
 * `sanitizeOfflineMessage` for what happens to those.
 */
export interface OfflineMessageEnvelope {
  code: string;
  params?: Record<string, string | number | boolean>;
}

/** Cap on any one param string, and on how many params a message may
 *  carry, so a chatty or hostile client cannot bloat a manifest row. */
const MAX_PARAM_LENGTH = 500;
const MAX_PARAMS = 12;
/** A code is `group.name`, optionally deeper. Bounded and
 *  character-restricted so an unknown one is still safe to store and to
 *  echo back into a UI. */
const CODE_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/;
const MAX_CODE_LENGTH = 64;

/**
 * Coerce whatever a client posted into something safe to persist.
 *
 * Three inputs, three answers:
 *
 *   - A string. That is a client old enough to predate codes, so it
 *     becomes `legacy.text`; the text is what it always was.
 *   - An object with a code this build knows: kept, params trimmed.
 *   - An object with a well-formed code this build does NOT know: also
 *     KEPT. It came from a device on a newer build, and dropping it
 *     would blank the only record of why a stuck edit was refused; the
 *     renderer shows a fallback naming the code instead. A malformed or
 *     oversized code is the only thing that becomes null, because at
 *     that point there is nothing a future build could render either.
 */
export function sanitizeOfflineMessage(
  input: unknown,
): OfflineMessageEnvelope | null {
  if (typeof input === 'string') {
    const text = input.slice(0, MAX_PARAM_LENGTH);
    return text ? { code: 'legacy.text', params: { text } } : null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as { code?: unknown; params?: unknown };
  if (typeof raw.code !== 'string') return null;
  const code = raw.code;
  if (code.length > MAX_CODE_LENGTH || !CODE_PATTERN.test(code)) return null;
  const params = sanitizeParams(raw.params);
  return params ? { code, params } : { code };
}

/** Keep only scalar params, trimmed and bounded. Anything nested (the
 *  download summary's list of shortfalls) is dropped rather than walked:
 *  no download message ever travels to the server, so nothing that
 *  reaches here legitimately carries one. */
function sanitizeParams(
  input: unknown,
): Record<string, string | number | boolean> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const out: Record<string, string | number | boolean> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (kept >= MAX_PARAMS) break;
    if (typeof value === 'string') {
      out[key] = value.slice(0, MAX_PARAM_LENGTH);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      continue;
    }
    kept += 1;
  }
  return kept > 0 ? out : undefined;
}
