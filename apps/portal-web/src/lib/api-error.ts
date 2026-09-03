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
  let body = '';
  try {
    body = await res.text();
  } catch {
    return status;
  }
  const trimmed = body.trim();
  if (!trimmed) return status;
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown };
    if (Array.isArray(parsed.message)) {
      const lines = parsed.message.filter(
        (m): m is string => typeof m === 'string' && m.length > 0,
      );
      if (lines.length > 0) return lines.join(' ');
    } else if (typeof parsed.message === 'string' && parsed.message) {
      return parsed.message;
    }
    return status;
  } catch {
    // Not JSON. A short plain-text body is worth showing; a long one
    // is almost certainly a proxy's HTML error page.
    return trimmed.length <= 300 && !trimmed.startsWith('<')
      ? `${status} ${trimmed}`
      : status;
  }
}
