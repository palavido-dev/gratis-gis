// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  parseDeltaAfterParam,
  parseDeltaLimit,
  parseSinceParam,
  syncVersionSource,
} from './layer-delta.js';

describe('parseSinceParam', () => {
  it('defaults missing or empty to 0', () => {
    expect(parseSinceParam(undefined)).toBe(0);
    expect(parseSinceParam('')).toBe(0);
  });

  it('accepts non-negative integers', () => {
    expect(parseSinceParam('0')).toBe(0);
    expect(parseSinceParam('42')).toBe(42);
  });

  it.each(['-1', '1.5', 'abc', '1e3'])('refuses %s', (raw) => {
    expect(() => parseSinceParam(raw)).toThrow(BadRequestException);
  });
});

describe('parseDeltaLimit', () => {
  it('defaults to 1000', () => {
    expect(parseDeltaLimit(undefined)).toBe(1000);
  });

  it('accepts the max', () => {
    expect(parseDeltaLimit('10000')).toBe(10000);
  });

  it.each(['0', '10001', 'nope'])('refuses %s', (raw) => {
    expect(() => parseDeltaLimit(raw)).toThrow(BadRequestException);
  });
});

describe('syncVersionSource', () => {
  it('stamps syncVersion under source.details for delta filters', () => {
    expect(syncVersionSource(7)).toEqual({
      kind: 'data_layer:write',
      details: { syncVersion: 7 },
    });
  });
});

describe('parseDeltaAfterParam', () => {
  it('treats missing or empty as no cursor', () => {
    expect(parseDeltaAfterParam(undefined)).toBeUndefined();
    expect(parseDeltaAfterParam('')).toBeUndefined();
  });

  it('accepts an observation uuid and lowercases it', () => {
    expect(parseDeltaAfterParam('0190A0B0-0000-7000-8000-00000000000A')).toBe(
      '0190a0b0-0000-7000-8000-00000000000a',
    );
  });

  it.each(['1', 'abc', "x' OR 1=1"])('refuses %s', (raw) => {
    expect(() => parseDeltaAfterParam(raw)).toThrow(BadRequestException);
  });
});
