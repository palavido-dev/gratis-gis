// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

import { AuthSyncService, type AuthUser } from './auth-sync.service.js';
import {
  assertAllowedAzp,
  parseJwtAllowedAzp,
} from './jwt-allowed-azp.js';

/**
 * Validates Keycloak-issued JWTs against the realm's JWKS endpoint.
 * On success, upserts the local User row and returns the AuthUser object
 * that gets attached to `request.user` for the duration of the request.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly allowedAzp = parseJwtAllowedAzp();

  constructor(private readonly authSync: AuthSyncService) {
    const keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
    const realm = process.env.KEYCLOAK_REALM ?? 'gratis-gis';

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      algorithms: ['RS256'],
      issuer: `${keycloakUrl}/realms/${realm}`,
      // Keycloak omits `aud` on access tokens by default; passport-jwt
      // audience checking would 401 every caller. We allowlist `azp`
      // in validate() instead (SEC-jwt-aud).
      audience: undefined,
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri: `${keycloakUrl}/realms/${realm}/protocol/openid-connect/certs`,
      }),
    });
  }

  async validate(payload: KeycloakClaims): Promise<AuthUser> {
    assertAllowedAzp(payload.azp, this.allowedAzp);
    return this.authSync.upsertFromClaims(payload);
  }
}

/** The claim shape we expect from Keycloak. Extras are tolerated but ignored. */
export interface KeycloakClaims {
  sub: string;
  preferred_username: string;
  /**
   * Authorized party: the Keycloak client id that obtained the
   * token. Required by {@link assertAllowedAzp}.
   */
  azp?: string;
  // Email is optional because Keycloak users created without the
  // `email` profile attribute (or with the email scope unmapped)
  // omit it from the token entirely. AuthSyncService synthesizes a
  // local placeholder so the user upsert can never crash on a
  // missing email, which would otherwise 500 every authed request
  // from that account (#365).
  email?: string;
  name: string;
  org?: string;
  org_role?: 'viewer' | 'contributor' | 'admin';
}
