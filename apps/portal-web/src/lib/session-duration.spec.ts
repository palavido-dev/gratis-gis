// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DEFAULT_SESSION_MAX_AGE_SECONDS,
  sessionIdleSeconds,
  sessionMaxAgeSeconds,
} from './session-duration';

describe('session duration', () => {
  it('keeps the existing 365-day default when unset or invalid', () => {
    expect(sessionMaxAgeSeconds(undefined)).toBe(DEFAULT_SESSION_MAX_AGE_SECONDS);
    expect(sessionMaxAgeSeconds('')).toBe(DEFAULT_SESSION_MAX_AGE_SECONDS);
    expect(sessionMaxAgeSeconds('nope')).toBe(DEFAULT_SESSION_MAX_AGE_SECONDS);
    expect(sessionMaxAgeSeconds('10')).toBe(DEFAULT_SESSION_MAX_AGE_SECONDS);
  });

  it('accepts an operator lifetime inside the bounds', () => {
    expect(sessionMaxAgeSeconds('86400')).toBe(86400);
  });

  it('does not add an idle timeout unless one is configured', () => {
    expect(sessionIdleSeconds(undefined)).toBeNull();
    expect(sessionIdleSeconds('')).toBeNull();
    expect(sessionIdleSeconds('3600')).toBe(3600);
    expect(sessionIdleSeconds('10')).toBeNull();
  });
});
