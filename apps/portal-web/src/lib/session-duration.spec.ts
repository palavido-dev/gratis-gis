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
  });

  it('clamps an idle value that is set but out of range, instead of turning it off (54-6)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(sessionIdleSeconds('600')).toBe(15 * 60);
    expect(sessionIdleSeconds('10m')).toBe(15 * 60);
    expect(sessionIdleSeconds(String(400 * 24 * 60 * 60))).toBe(DEFAULT_SESSION_MAX_AGE_SECONDS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
