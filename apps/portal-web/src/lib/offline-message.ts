// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Render an `OfflineMessage` in the reader's language.
 *
 * The offline arc stores codes rather than sentences (see
 * `packages/shared-types/src/offline-message.ts` for why), so this is
 * the one place a code becomes text. Every surface that shows a
 * download shortfall or a replay failure goes through here: the
 * download modal, the offline panel's "Incomplete" line, the
 * rejected-edits dialog, and the admin field-queues view, which is
 * reading rows a different person wrote on a different device.
 *
 * Two rules the switch below exists to hold:
 *
 *   - Params are coerced, not trusted. A row on disk was written by
 *     some build of this app, possibly an older or newer one, and a
 *     missing param would otherwise render as the literal `{layer}` in
 *     front of a field worker.
 *   - An unrecognised code renders a fallback that names it rather than
 *     rendering nothing. A newer device's reason is still evidence.
 */

import {
  isOfflineMessageCode,
  type OfflineMessage,
  type OfflineMessageEnvelope,
} from '@gratis-gis/shared-types';

import { formatBytes } from './format-bytes';
import type { Translator } from './i18n';

/** How many shortfalls the download summary names before it counts the
 *  rest. The panel's own line stops at two (`describeMissing` in the
 *  field runtime); the summary has a whole modal and can afford three. */
const SUMMARY_MISSING_SHOWN = 3;

type ScalarParams = Record<string, string | number>;

export function formatOfflineMessage(
  t: Translator,
  message: OfflineMessage | OfflineMessageEnvelope,
): string {
  const code = message.code;
  if (!isOfflineMessageCode(code)) {
    return t('offlineMessage.unknown', { code: code.slice(0, 80) });
  }
  const raw = (message as { params?: Record<string, unknown> }).params;
  const params = scalarParams(raw);
  switch (code) {
    case 'legacy.text':
      // The stored sentence, whoever wrote it: an older build with no
      // codes, or the server, whose wording no client can translate.
      return String(params.text ?? '');
    case 'download.estimated':
      return t(key(code), { size: formatBytes(Number(params.bytes) || 0) });
    case 'download.done':
      return formatDone(t, params);
    case 'download.donePartial':
      return t(key(code), {
        missing: formatMissing(t, raw),
        summary: formatDone(t, params),
      });
    case 'download.donePartialOutOfSpace':
      return t(key(code), { missing: formatMissing(t, raw) });
    // Three sentences the catalog already carries, because the same
    // words appear on the panel that starts the download and on the
    // runtime's own failure copy. Pointed at rather than copied so the
    // two cannot drift into disagreeing about what the reader was told
    // a moment ago.
    case 'download.quotaRefused':
      return t('fieldOffline.quotaTitle');
    case 'download.stopped':
      return t('offlineBasemap.downloadStopped');
    case 'sync.queueReadFailed':
      return t('fieldRuntime.queueReadFailed');
    default:
      // Every other code names its placeholders after its params, so
      // there is nothing to translate between them.
      return t(key(code), params);
  }
}

/** Render a list of shortfalls into the `{missing}` slot of a sentence,
 *  naming the first few and counting the rest so the line never grows
 *  past what a collector reads before leaving signal. */
export function formatOfflineMessages(
  t: Translator,
  messages: ReadonlyArray<OfflineMessage | OfflineMessageEnvelope>,
  shown: number,
): string {
  const head = messages
    .slice(0, shown)
    .map((m) => formatOfflineMessage(t, m))
    .join(', ');
  if (messages.length <= shown) return head;
  return t('offlineMessage.download.missingMore', {
    missing: head,
    count: messages.length - shown,
  });
}

function key(code: string): string {
  return `offlineMessage.${code}`;
}

/**
 * "Cached 3 layers (12 features, 1 form)."
 *
 * The breakdown is built here rather than in the producer because which
 * parts to name is a presentation decision: a zero is left out so a
 * brand-new deployment does not report "0 features, 0 forms, 0 pick
 * lists" and read like a download that did nothing.
 */
function formatDone(t: Translator, params: ScalarParams): string {
  const layers = t('offlineMessage.download.layers', {
    count: Number(params.layers) || 0,
  });
  const detail: string[] = [];
  const features = Number(params.features) || 0;
  const forms = Number(params.forms) || 0;
  const pickLists = Number(params.pickLists) || 0;
  if (features > 0) {
    detail.push(t('offlineMessage.download.detailFeatures', { count: features }));
  }
  if (forms > 0) {
    detail.push(t('offlineMessage.download.detailForms', { count: forms }));
  }
  if (pickLists > 0) {
    detail.push(
      t('offlineMessage.download.detailPickLists', { count: pickLists }),
    );
  }
  return detail.length > 0
    ? t('offlineMessage.download.done', { layers, detail: detail.join(', ') })
    : t('offlineMessage.download.doneEmpty', { layers });
}

/** The nested shortfall list carried by the two partial-summary codes.
 *  Read defensively: a row from another build may not have one. */
function formatMissing(
  t: Translator,
  raw: Record<string, unknown> | undefined,
): string {
  const missing = raw?.missing;
  if (!Array.isArray(missing) || missing.length === 0) return '';
  const messages = missing.filter(
    (m): m is OfflineMessage =>
      !!m && typeof m === 'object' && typeof (m as { code?: unknown }).code === 'string',
  );
  return formatOfflineMessages(t, messages, SUMMARY_MISSING_SHOWN);
}

/** Keep the params the interpolator can substitute and drop the rest.
 *  A number stays a number so a plural case still selects on it. */
function scalarParams(raw: Record<string, unknown> | undefined): ScalarParams {
  const out: ScalarParams = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}
