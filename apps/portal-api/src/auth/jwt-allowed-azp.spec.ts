// SPDX-License-Identifier: AGPL-3.0-or-later
import { UnauthorizedException } from '@nestjs/common';

import {
  DEFAULT_JWT_ALLOWED_AZP,
  assertAllowedAzp,
  parseJwtAllowedAzp,
} from './jwt-allowed-azp.js';

describe('jwt-allowed-azp', () => {
  it('defaults to the known portal fronts', () => {
    expect([...parseJwtAllowedAzp(undefined)].sort()).toEqual(
      [...DEFAULT_JWT_ALLOWED_AZP].sort(),
    );
    expect([...parseJwtAllowedAzp('')].sort()).toEqual(
      [...DEFAULT_JWT_ALLOWED_AZP].sort(),
    );
  });

  it('parses a comma-separated override', () => {
    expect(parseJwtAllowedAzp(' portal-web , custom-client ')).toEqual(
      new Set(['portal-web', 'custom-client']),
    );
  });

  it('accepts an allowlisted azp', () => {
    expect(() => assertAllowedAzp('portal-web')).not.toThrow();
    expect(() => assertAllowedAzp('field-app')).not.toThrow();
    expect(() => assertAllowedAzp('qgis-plugin')).not.toThrow();
  });

  it('rejects missing or unknown azp', () => {
    expect(() => assertAllowedAzp(undefined)).toThrow(UnauthorizedException);
    expect(() => assertAllowedAzp('')).toThrow(UnauthorizedException);
    expect(() => assertAllowedAzp('portal-api-admin')).toThrow(
      UnauthorizedException,
    );
    expect(() =>
      assertAllowedAzp('portal-web', new Set(['field-app'])),
    ).toThrow(UnauthorizedException);
  });
});
