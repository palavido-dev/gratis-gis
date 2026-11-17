// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sentence for a thrown fetch error. Keeps the HTTP status in the
 * text when the server's own message does not already contain it,
 * because pages still branch on `message.includes('404')` to render
 * the not-found screen instead of the crash boundary.
 */
export async function apiErrorMessage(
  res: Response,
  fallback = 'Request failed',
): Promise<string> {
  const sentence = await parseApiError(res, fallback);
  const status = String(res.status);
  return sentence.includes(status) ? sentence : `${sentence} (${status})`;
}

/**
 * Turn a failed portal-api response into the sentence a person should
 * read.
 *
 * portal-api answers a refused write in two shapes. A service-level
 * check (the schema validator, a permission gate) throws with a single
 * `message: string`, already written as a sentence that names the
 * field and what it would not accept. Nest's ValidationPipe, which
 * runs first on the DTO, throws with `message: string[]`, one entry
 * per constraint. Before this helper every caller parsed one of those
 * shapes and threw the other away, so a validator's "Depth is a number
 * field; \"n/a\" is not a number" reached the screen from one dialog
 * and became "Save failed (400)" from the next.
 *
 * Never throws. A body that is not JSON, or is JSON without a message,
 * falls back to a status line, with the raw text appended only when it
 * is short enough to be a message rather than an HTML error page.
 */
export async function parseApiError(
  res: Response,
  fallback = 'Request failed',
): Promise<string> {
  const status = `${fallback} (${res.status}).`;
  const detail = await parseApiErrorDetail(res);
  if (detail.kind === 'message') return detail.text;
  if (detail.kind === 'body') return `${status} ${detail.text}`;
  return status;
}

/**
 * The same read, without composing the sentence.
 *
 * The offline queue persists why an edit was refused, and it stores a
 * code rather than English so the reason can be rendered later in
 * whoever's language reads it (see `offline-message.ts`). It therefore
 * needs to know WHICH of the three outcomes it got rather than a string
 * that has already blended them:
 *
 *   - `message`: the server's own sentence. It named the field and what
 *     it would not accept, and no client can translate it, so it is
 *     carried verbatim.
 *   - `body`: a short non-JSON body, worth showing next to a status
 *     line. A long one is almost certainly a proxy's HTML error page
 *     and is dropped.
 *   - `none`: nothing usable; the caller has only the status code.
 *
 * Reads the body, so a Response can go through this or `parseApiError`
 * once, not both.
 */
export type ApiErrorDetail =
  | { kind: 'message'; text: string }
  | { kind: 'body'; text: string }
  | { kind: 'none' };

export async function parseApiErrorDetail(
  res: Response,
): Promise<ApiErrorDetail> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    return { kind: 'none' };
  }
  const trimmed = body.trim();
  if (!trimmed) return { kind: 'none' };
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown };
    if (Array.isArray(parsed.message)) {
      const lines = parsed.message.filter(
        (m): m is string => typeof m === 'string' && m.length > 0,
      );
      if (lines.length > 0) return { kind: 'message', text: lines.join(' ') };
    } else if (typeof parsed.message === 'string' && parsed.message) {
      return { kind: 'message', text: parsed.message };
    }
    return { kind: 'none' };
  } catch {
    return trimmed.length <= 300 && !trimmed.startsWith('<')
      ? { kind: 'body', text: trimmed }
      : { kind: 'none' };
  }
}

/**
 * What the Add layer dialog (and any other caller that wants the
 * same shape) can show under a localized sentence.
 *
 * `detail` is a server sentence with secrets and stack traces
 * removed. A generic "Internal server error" is not a detail: the
 * caller shows the HTTP status instead, plus `requestId` when the
 * response carried one. The id is the same token portal-api logs.
 */
export interface ApiFailure {
  status: number | null;
  detail: string | null;
  /** Machine code such as `session-expired`. Not Nest's "Bad Request". */
  code: string | null;
  requestId: string | null;
}

export interface ShownApiError {
  summary: string;
  detail: string | null;
  requestId: string | null;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MACHINE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GENERIC_MESSAGE = /^(internal server error|request failed)\.?$/i;

export function readRequestId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Id for a failure that never reached portal-api, so the web log and
 *  the dialog still name the same attempt. */
export function mintRequestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read a failed response once. Safe to show to someone who is not an
 * admin: stack frames are removed and secret-shaped values are
 * replaced. An admin-only `detail` the server already redacted is
 * kept when the `message` itself is only the generic status sentence.
 */
export async function readApiFailure(res: Response): Promise<ApiFailure> {
  const requestIdHeader = readRequestId(res.headers.get('x-request-id'));
  const status = res.status || null;
  let body = '';
  try {
    body = await res.text();
  } catch {
    return { status, detail: null, code: null, requestId: requestIdHeader };
  }
  const trimmed = body.trim();
  if (!trimmed || trimmed.startsWith('<') || /<html/i.test(trimmed)) {
    return { status, detail: null, code: null, requestId: requestIdHeader };
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown;
      detail?: unknown;
      code?: unknown;
      requestId?: unknown;
    };
    const requestId =
      requestIdHeader ??
      readRequestId(typeof parsed.requestId === 'string' ? parsed.requestId : null);
    const code =
      typeof parsed.code === 'string' && MACHINE_CODE.test(parsed.code)
        ? parsed.code
        : null;
    const message = sanitizePublicDetail(messageText(parsed.message));
    const extra =
      typeof parsed.detail === 'string'
        ? sanitizePublicDetail(parsed.detail)
        : null;
    const detail = usefulDetail(message) ? message : usefulDetail(extra) ? extra : null;
    return { status, detail, code, requestId };
  } catch {
    if (trimmed.length > 300) {
      return { status, detail: null, code: null, requestId: requestIdHeader };
    }
    return {
      status,
      detail: sanitizePublicDetail(trimmed),
      code: null,
      requestId: requestIdHeader,
    };
  }
}

export function presentApiFailure(
  summary: string,
  failure: ApiFailure,
  statusLine: (status: number, code: string | null) => string,
): ShownApiError {
  const detail = failure.detail
    ? failure.detail
    : failure.status != null
      ? statusLine(failure.status, failure.code)
      : null;
  return { summary, detail, requestId: failure.requestId };
}

/** A failure that threw in the browser, before a response existed. */
export function presentClientFailure(
  summary: string,
  err: unknown,
): ShownApiError {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return {
    summary,
    detail: sanitizePublicDetail(raw),
    requestId: null,
  };
}

/**
 * Same redaction the API applies, repeated here so an older server
 * or a proxy error page cannot put a stack or a secret on screen.
 * Stacks are always dropped: the request id is how an admin finds
 * the trace in the log.
 */
export function sanitizePublicDetail(text: string | null): string | null {
  if (!text) return null;
  const redacted = redactSecrets(text).replace(/\0/g, '').trim();
  if (!redacted || redacted.startsWith('<') || /<html/i.test(redacted)) {
    return null;
  }
  if (looksLikeStack(redacted)) return null;
  return redacted.length <= 300 ? redacted : `${redacted.slice(0, 299)}…`;
}

function messageText(message: unknown): string | null {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return null;
  const lines = message.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  return lines.length > 0 ? lines.join(' ') : null;
}

function usefulDetail(text: string | null): text is string {
  return !!text && !GENERIC_MESSAGE.test(text.trim());
}

function redactSecrets(text: string): string {
  // Fresh expressions each call. A shared /g pattern keeps lastIndex
  // and silently skips the next secret.
  return text
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*)(\S+)/gi,
      '$1$2[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s'")]+/gi,
      '[redacted]',
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]');
}

function looksLikeStack(text: string): boolean {
  return text.split('\n').some(
    (line) =>
      /^\s*at\s+\S/.test(line) ||
      /\([^()\n]*\.(?:js|ts|mjs|cjs):\d+:\d+\)/.test(line),
  );
}
