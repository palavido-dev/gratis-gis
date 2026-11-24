// SPDX-License-Identifier: AGPL-3.0-or-later
import { isMultiTenant, logTenancyMode, resetTenancyModeForTests, tenancyMode } from './tenancy.js';

describe('tenancy mode', () => {
  const saved = process.env.GRATIS_TENANCY;

  afterEach(() => {
    if (saved === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = saved;
    resetTenancyModeForTests();
  });

  function modeFor(value: string | undefined) {
    if (value === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = value;
    resetTenancyModeForTests();
    return tenancyMode();
  }

  it('is single when unset, empty or anything but multi', () => {
    expect(modeFor(undefined)).toBe('single');
    expect(modeFor('')).toBe('single');
    expect(modeFor('single')).toBe('single');
    expect(modeFor('mult')).toBe('single');
    expect(modeFor('true')).toBe('single');
    expect(isMultiTenant()).toBe(false);
  });

  it('is multi for multi, ignoring case and surrounding space', () => {
    expect(modeFor('multi')).toBe('multi');
    expect(modeFor(' MULTI ')).toBe('multi');
    expect(isMultiTenant()).toBe(true);
  });

  it('is read once and kept until reset', () => {
    expect(modeFor('multi')).toBe('multi');
    process.env.GRATIS_TENANCY = 'single';
    expect(tenancyMode()).toBe('multi');
  });

  it('logs the mode', () => {
    const log = jest.fn();
    modeFor(undefined);
    expect(logTenancyMode({ log })).toBe('single');
    expect(log).toHaveBeenCalledWith('Tenancy mode: single');
  });
});
