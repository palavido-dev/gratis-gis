// SPDX-License-Identifier: AGPL-3.0-or-later
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
