// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { deriveServerSigningKey } from '../storage/signing-key.js';
import { AuthSyncService, type AuthUser } from './auth-sync.service.js';
import { hashApiKey, looksLikeApiKey } from './api-key-token.js';
import { ApiKeyService } from './api-key.service.js';
import { esriSigningSecret } from './esri-signing-secret.js';
import {
  ESRI_TOKEN_KEY_LABEL,
  ESRI_TOKEN_MAX_MINUTES,
  signEsriToken,
  verifyEsriToken,
} from './esri-token.js';
import type { KeycloakClaims } from './jwt.strategy.js';

/**
 * The Keycloak client that checks passwords for Esri clients. Public,
 * password grant only, no redirects: it can do nothing but answer
 * "is this the user's password". Its tokens are not accepted by the
 * API (it is not in JWT_ALLOWED_AZP); this service reads one and
 * throws it away.
 */
export const ESRI_DESKTOP_CLIENT_ID = 'esri-desktop';

/** Mints and checks Esri client tokens. See esri-token.ts. */
@Injectable()
export class EsriTokenService {
  private readonly key: Buffer;
  private readonly log = new Logger(EsriTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeyService,
    private readonly authSync: AuthSyncService,
    cfg: ConfigService,
  ) {
    // A token stands for a whole user, so it is signed with a secret
    // of its own (GRATIS_SIGNING_SECRET), not the MinIO secret other
    // services hold. Until an older install gets one, the MinIO secret
    // is used as before; main.ts warns about that and refuses a
    // placeholder in production. See esri-signing-secret.ts.
    const { secret } = esriSigningSecret({
      GRATIS_SIGNING_SECRET: cfg.get<string>('GRATIS_SIGNING_SECRET'),
      MINIO_SECRET_KEY: cfg.get<string>('MINIO_SECRET_KEY'),
    });
    this.key = deriveServerSigningKey(secret, ESRI_TOKEN_KEY_LABEL);
  }

  /**
   * A token for `username`, who proves it with either their password
   * or one of their personal API keys. The same refusal for every
   * failure, so the endpoint does not tell a guesser which part was
   * wrong.
   */
  async generate(
    username: string,
    secret: string,
    minutes: number,
    now = Date.now(),
  ): Promise<{ token: string; expires: number }> {
    const life = Math.min(Math.max(Math.floor(minutes) || ESRI_TOKEN_MAX_MINUTES, 1), ESRI_TOKEN_MAX_MINUTES);
    let expires = now + life * 60_000;
    if (looksLikeApiKey(secret)) {
      const { id, expiresAt } = await this.keyOwnedBy(username, secret);
      // Never outlive the key itself.
      if (expiresAt) expires = Math.min(expires, expiresAt.getTime());
      return { token: signEsriToken({ kid: id, exp: expires }, this.key), expires };
    }
    const user = await this.keycloakSignIn(username, secret);
    return { token: signEsriToken({ uid: user.id, exp: expires }, this.key), expires };
  }

  /** The user a token speaks for, or a 401 when it is bad, expired, or its key or account is gone. */
  async resolve(token: string): Promise<AuthUser> {
    const claims = verifyEsriToken(token, this.key);
    if (!claims) throw new UnauthorizedException('Invalid token.');
    if ('kid' in claims) return this.apiKeys.resolveId(claims.kid);
    const row = await this.prisma.user.findUnique({
      where: { id: claims.uid },
      select: { deletedAt: true, disabledAt: true, autoDisableAt: true, orgRole: true },
    });
    // The same account checks as an API key: a token minted before the
    // account was disabled must stop working when it is.
    if (
      !row ||
      row.deletedAt !== null ||
      row.disabledAt !== null ||
      (row.autoDisableAt !== null && row.autoDisableAt.getTime() <= Date.now() && row.orgRole !== 'admin')
    ) {
      throw new UnauthorizedException('Invalid token.');
    }
    const user = await this.authSync.principalForUserId(claims.uid);
    if (!user) throw new UnauthorizedException('Invalid token.');
    return { ...user, authKind: 'jwt' };
  }

  private refuse(): never {
    throw new UnauthorizedException('Invalid username or password.');
  }

  private async keyOwnedBy(username: string, apiKey: string): Promise<{ id: string; expiresAt: Date | null }> {
    let user: AuthUser;
    try {
      user = await this.apiKeys.resolve(apiKey);
    } catch {
      return this.refuse();
    }
    if (!this.namesUser(username, user)) this.refuse();
    const row = await this.prisma.apiKey.findUnique({
      where: { tokenHash: hashApiKey(apiKey) },
      select: { id: true, expiresAt: true },
    });
    if (!row) return this.refuse();
    return row;
  }

  private namesUser(username: string, user: AuthUser): boolean {
    const name = username.trim().toLowerCase();
    return name === user.username.toLowerCase() || name === (user.email ?? '').toLowerCase();
  }

  /**
   * Check a password with Keycloak (the password grant on the
   * esri-desktop client) and build the user it belongs to, the same
   * way a browser sign-in does. Keycloak applies its own lockout after
   * repeated failures. An account with two-step sign-in, or one that
   * signs in through Google or Microsoft, has no password this can
   * check and is refused; those users use a personal API key.
   */
  private async keycloakSignIn(username: string, secret: string): Promise<AuthUser> {
    if (username.trim() === '' || secret === '') this.refuse();
    const base = (process.env.KEYCLOAK_INTERNAL_URL ?? process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/$/, '');
    const realm = process.env.KEYCLOAK_REALM ?? 'gratis-gis';
    const url = `${base}/realms/${encodeURIComponent(realm)}/protocol/openid-connect`;
    let res: Response;
    try {
      res = await fetch(`${url}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: ESRI_DESKTOP_CLIENT_ID,
          username: username.trim(),
          password: secret,
          scope: 'openid',
        }),
      });
    } catch (err) {
      this.log.warn(`Keycloak password check unreachable: ${String(err)}`);
      return this.refuse();
    }
    if (!res.ok) {
      await res.body?.cancel();
      return this.refuse();
    }
    const body = (await res.json()) as { access_token?: string; refresh_token?: string };
    // End the Keycloak session at once: the Esri token is what the
    // client holds, and a session per hourly sign-in would pile up.
    if (body.refresh_token) {
      void fetch(`${url}/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: ESRI_DESKTOP_CLIENT_ID, refresh_token: body.refresh_token }),
      })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
    }
    const claims = decodeClaims(body.access_token);
    if (!claims) return this.refuse();
    // Straight from Keycloak's token endpoint over our own connection,
    // so the payload is trusted without checking its signature.
    try {
      return await this.authSync.upsertFromClaims(claims);
    } catch {
      return this.refuse();
    }
  }
}

function decodeClaims(jwt: string | undefined): KeycloakClaims | null {
  if (typeof jwt !== 'string') return null;
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as KeycloakClaims;
    return typeof c.sub === 'string' ? c : null;
  } catch {
    return null;
  }
}
