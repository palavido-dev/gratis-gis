// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { deriveServerSigningKey } from '../storage/signing-key.js';
import type { AuthUser } from './auth-sync.service.js';
import { hashApiKey, looksLikeApiKey } from './api-key-token.js';
import { ApiKeyService } from './api-key.service.js';
import {
  ESRI_TOKEN_KEY_LABEL,
  ESRI_TOKEN_MAX_MINUTES,
  signEsriToken,
  verifyEsriToken,
} from './esri-token.js';

/** Mints and checks Esri client tokens. See esri-token.ts. */
@Injectable()
export class EsriTokenService {
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeyService,
    cfg: ConfigService,
  ) {
    // The same secret the print credential and upload handles use,
    // under a label of its own.
    this.key = deriveServerSigningKey(cfg.get<string>('MINIO_SECRET_KEY', 'devpassword'), ESRI_TOKEN_KEY_LABEL);
  }

  /**
   * A token for the owner of `apiKey`, who must be `username` (or that
   * user's email). The same answer for every refusal, so the endpoint
   * does not tell a guesser which half was wrong.
   */
  async generate(
    username: string,
    apiKey: string,
    minutes: number,
    now = Date.now(),
  ): Promise<{ token: string; expires: number }> {
    const refuse = (): never => {
      throw new UnauthorizedException('Invalid username or password.');
    };
    if (!looksLikeApiKey(apiKey)) refuse();
    let user: AuthUser;
    try {
      user = await this.apiKeys.resolve(apiKey);
    } catch {
      return refuse();
    }
    const name = username.trim().toLowerCase();
    if (name !== user.username.toLowerCase() && name !== (user.email ?? '').toLowerCase()) refuse();
    const row = await this.prisma.apiKey.findUnique({
      where: { tokenHash: hashApiKey(apiKey) },
      select: { id: true, expiresAt: true },
    });
    if (!row) return refuse();
    const life = Math.min(Math.max(Math.floor(minutes) || ESRI_TOKEN_MAX_MINUTES, 1), ESRI_TOKEN_MAX_MINUTES);
    let expires = now + life * 60_000;
    // Never outlive the key itself.
    if (row.expiresAt) expires = Math.min(expires, row.expiresAt.getTime());
    return { token: signEsriToken({ kid: row.id, exp: expires }, this.key), expires };
  }

  /** The user a token speaks for, or a 401 when it is bad, expired or its key is gone. */
  async resolve(token: string): Promise<AuthUser> {
    const claims = verifyEsriToken(token, this.key);
    if (!claims) throw new UnauthorizedException('Invalid token.');
    return this.apiKeys.resolveId(claims.kid);
  }
}
