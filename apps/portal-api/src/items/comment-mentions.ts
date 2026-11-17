// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parse `@username` tokens from a comment body (R2-comments-mentions).
 *
 * Usernames match `[A-Za-z0-9._-]{1,64}` after `@`. Email-like
 * `name@host` is ignored: the `@` must not be preceded by a word
 * character. Cap and resolve happen in CommentsService.
 */

/** Max unique resolved mentions notified per comment. */
export const MAX_MENTIONS_PER_COMMENT = 10;

const MENTION_RE = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]{1,64})\b/g;

/** Unique usernames in first-seen order (case preserved from body). */
export function extractMentionUsernames(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body)) !== null) {
    const raw = m[2] ?? '';
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= MAX_MENTIONS_PER_COMMENT) break;
  }
  return out;
}

/** Plain-text snippet for email (trim + collapse whitespace). */
export function commentSnippet(body: string, maxLen = 160): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}
