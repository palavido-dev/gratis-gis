// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isAiBuildDisabled,
  isAiConfigLocked,
  orgDailyCallLimit,
  userDailyCallLimit,
  userMinuteCallLimit,
} from './ai-env.js';

describe('ai-env', () => {
  const keys = [
    'PORTAL_LOCK_ADMIN_TIER',
    'PORTAL_LOCK_AI_CONFIG',
    'PORTAL_AI_DISABLE_BUILD',
    'PORTAL_AI_ORG_DAILY_CALL_LIMIT',
    'PORTAL_AI_USER_DAILY_CALL_LIMIT',
    'PORTAL_AI_USER_MINUTE_CALL_LIMIT',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('locks AI config when the admin tier is locked', () => {
    expect(isAiConfigLocked()).toBe(false);
    process.env.PORTAL_LOCK_ADMIN_TIER = 'true';
    expect(isAiConfigLocked()).toBe(true);
    process.env.PORTAL_LOCK_AI_CONFIG = '0';
    expect(isAiConfigLocked()).toBe(false);
  });

  it('disables build under admin-tier lock unless opted out', () => {
    expect(isAiBuildDisabled()).toBe(false);
    process.env.PORTAL_LOCK_ADMIN_TIER = '1';
    expect(isAiBuildDisabled()).toBe(true);
    process.env.PORTAL_AI_DISABLE_BUILD = '0';
    expect(isAiBuildDisabled()).toBe(false);
  });

  it('applies demo default quotas when the admin tier is locked', () => {
    expect(orgDailyCallLimit()).toBe(0);
    expect(userDailyCallLimit()).toBe(0);
    expect(userMinuteCallLimit()).toBe(12);
    process.env.PORTAL_LOCK_ADMIN_TIER = 'yes';
    expect(orgDailyCallLimit()).toBe(100);
    expect(userDailyCallLimit()).toBe(20);
    expect(userMinuteCallLimit()).toBe(6);
    process.env.PORTAL_AI_ORG_DAILY_CALL_LIMIT = '40';
    process.env.PORTAL_AI_USER_DAILY_CALL_LIMIT = '5';
    process.env.PORTAL_AI_USER_MINUTE_CALL_LIMIT = '2';
    expect(orgDailyCallLimit()).toBe(40);
    expect(userDailyCallLimit()).toBe(5);
    expect(userMinuteCallLimit()).toBe(2);
  });
});
