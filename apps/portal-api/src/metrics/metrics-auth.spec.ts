// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  FailedAuthLimiter,
  MIN_METRICS_TOKEN_LENGTH,
  bearerMatches,
  readMetricsToken,
} from './metrics-auth';

const TOKEN = 'a'.repeat(MIN_METRICS_TOKEN_LENGTH);

describe('readMetricsToken', () => {
  it('is off when unset, empty or blank', () => {
    expect(readMetricsToken(undefined)).toEqual({ enabled: false, reason: 'unset' });
    expect(readMetricsToken('')).toEqual({ enabled: false, reason: 'unset' });
    expect(readMetricsToken('   ')).toEqual({ enabled: false, reason: 'unset' });
  });

  it('stays off for a short token', () => {
    expect(readMetricsToken('changeme')).toEqual({ enabled: false, reason: 'too_short' });
  });

  it('is on for a long enough token, trimmed', () => {
    expect(readMetricsToken(` ${TOKEN} `)).toEqual({ enabled: true, token: TOKEN });
  });
});

describe('bearerMatches', () => {
  it('accepts the exact bearer token, any scheme case', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects missing, other schemes, prefixes and extensions', () => {
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches('', TOKEN)).toBe(false);
    expect(bearerMatches('Bearer ', TOKEN)).toBe(false);
    expect(bearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
    expect(bearerMatches(['Bearer', TOKEN], TOKEN)).toBe(false);
  });
});

describe('FailedAuthLimiter', () => {
  it('blocks a client after the limit and resets with the window', () => {
    let now = 0;
    const limiter = new FailedAuthLimiter(2, 1000, () => now);
    expect(limiter.blocked('a')).toBe(false);
    limiter.recordMiss('a');
    limiter.recordMiss('a');
    expect(limiter.blocked('a')).toBe(true);
    expect(limiter.blocked('b')).toBe(false);
    now = 1000;
    expect(limiter.blocked('a')).toBe(false);
  });
});
