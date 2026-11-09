// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, timingSafeEqual } from 'node:crypto';

import { textEnv } from '../common/env.js';

/**
 * Shortest METRICS_TOKEN the API accepts. `openssl rand -hex 32` gives
 * 64 characters; 32 is the floor so a placeholder like "changeme" or a
 * short word can never switch the endpoint on.
 */
export const MIN_METRICS_TOKEN_LENGTH = 32;

export type MetricsTokenSetting =
  | { enabled: true; token: string }
  | { enabled: false; reason: 'unset' | 'too_short' };

/**
 * Read METRICS_TOKEN. The endpoint exists only when this returns
 * enabled; an unset, blank or too short value leaves it off, so an
 * install that never sets the variable behaves exactly as before.
 */
export function readMetricsToken(
  raw: string | undefined = process.env.METRICS_TOKEN,
): MetricsTokenSetting {
  const token = textEnv(raw, '');
  if (!token) return { enabled: false, reason: 'unset' };
  if (token.length < MIN_METRICS_TOKEN_LENGTH) {
    return { enabled: false, reason: 'too_short' };
  }
  return { enabled: true, token };
}

/**
 * True when the Authorization header carries exactly `Bearer <token>`.
 * Both sides are hashed to a fixed length before timingSafeEqual, so the
 * comparison takes the same time whatever the caller sent, including a
 * value of a different length.
 */
export function bearerMatches(header: unknown, token: string): boolean {
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  const presented = match?.[1] ?? '';
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

/**
 * Fixed-window counter of failed token checks per client address. A
 * caller guessing tokens gets 429 after `limit` misses in a window. The
 * map is cleared every window, so it cannot grow past one window's
 * distinct callers.
 *
 * The block is per address and is checked before the token, so a
 * scraper with the right token is also refused while anything else on
 * the same address is over the limit (for example a second scrape job
 * still sending the old token after a rotation). Checking the token
 * first would let a guesser keep testing tokens, so the order stays.
 */
export class FailedAuthLimiter {
  private windowStart = 0;
  private readonly misses = new Map<string, number>();

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private roll(): void {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.misses.clear();
    }
  }

  blocked(client: string): boolean {
    this.roll();
    return (this.misses.get(client) ?? 0) >= this.limit;
  }

  recordMiss(client: string): void {
    this.roll();
    this.misses.set(client, (this.misses.get(client) ?? 0) + 1);
  }
}
