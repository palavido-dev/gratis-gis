import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  decryptCredential,
  encryptCredential,
} from './credential-cipher.js';

/**
 * Per-item stored credentials for secured external services (#36).
 *
 * Three auth schemes today:
 *   - 'bearer'       : Authorization: Bearer <token>
 *   - 'basic'        : Authorization: Basic <base64(user:pass)>
 *   - 'arcgis_token' : ?token=<token> appended to each request URL
 *
 * Encryption: AES-256-GCM via credential-cipher.ts. Plaintext
 * never leaves this module's `getCredentialForProxy`; the public
 * read methods only return metadata ("a credential is set, of
 * kind X"). Callers must hold admin on the item to set or clear
 * credentials -- enforcement lives in the controller via the
 * existing canAdmin gate.
 */

export type AuthKind = 'bearer' | 'basic' | 'arcgis_token';

export const AUTH_KINDS: readonly AuthKind[] = [
  'bearer',
  'basic',
  'arcgis_token',
];

/** Plaintext payload per scheme, validated at write time. */
export type CredentialPayload =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'arcgis_token'; token: string };

/** Read-side metadata: enough for the editor to render
 *  "credential set ✓" without exposing the secret. */
export interface CredentialMeta {
  kind: AuthKind;
  hasSecret: true;
  updatedAt: Date;
  updatedBy: string;
}

@Injectable()
export class CredentialService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Set or replace the credential for an item. Caller has already
   * been authz-checked at the controller. Plaintext is encrypted
   * synchronously here; the upsert ensures we never have two
   * credentials for the same item.
   */
  async setCredential(
    itemId: string,
    actorId: string,
    payload: CredentialPayload,
  ): Promise<CredentialMeta> {
    if (!AUTH_KINDS.includes(payload.kind)) {
      throw new BadRequestException(`Unknown auth kind: ${payload.kind}`);
    }
    const plaintext = serializePayload(payload);
    const { ciphertext, iv } = encryptCredential(plaintext, itemId);
    const row = await this.prisma.itemCredential.upsert({
      where: { itemId },
      update: {
        authKind: payload.kind,
        encryptedPayload: ciphertext,
        iv,
        updatedBy: actorId,
      },
      create: {
        itemId,
        authKind: payload.kind,
        encryptedPayload: ciphertext,
        iv,
        updatedBy: actorId,
      },
    });
    return {
      kind: row.authKind as AuthKind,
      hasSecret: true,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  /** Read-side metadata. Returns null when no credential is set. */
  async getCredentialMeta(itemId: string): Promise<CredentialMeta | null> {
    const row = await this.prisma.itemCredential.findUnique({
      where: { itemId },
    });
    if (!row) return null;
    return {
      kind: row.authKind as AuthKind,
      hasSecret: true,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  /** Drop the credential entirely. No-op when none exists. */
  async clearCredential(itemId: string): Promise<void> {
    await this.prisma.itemCredential.deleteMany({ where: { itemId } });
  }

  /**
   * Resolve the plaintext payload for the proxy controller. Throws
   * NotFoundException when no credential is configured -- callers
   * should let that bubble up as a 404 so a misconfigured item
   * doesn't masquerade as a successful upstream call.
   *
   * Stays in the service module (not exported) so the proxy is the
   * only path that can reach plaintext. The HTTP layer never sees
   * the secret directly: the proxy reads the response body and
   * forwards bytes only.
   */
  async getCredentialForProxy(itemId: string): Promise<CredentialPayload> {
    const row = await this.prisma.itemCredential.findUnique({
      where: { itemId },
    });
    if (!row) {
      throw new NotFoundException('Item has no stored credential');
    }
    let plaintext: string;
    try {
      plaintext = decryptCredential(row.encryptedPayload, row.iv, itemId);
    } catch {
      // Treat decrypt failure (key rotation, tampering, AAD
      // mismatch) the same as "no credential" so the proxy fails
      // closed rather than leaking that something went wrong.
      throw new NotFoundException('Item has no stored credential');
    }
    return parsePayload(row.authKind as AuthKind, plaintext);
  }
}

/** Pack a payload into the JSON shape we store. Kind is implicit
 *  in the column so the JSON only carries the secret fields. */
function serializePayload(payload: CredentialPayload): string {
  switch (payload.kind) {
    case 'bearer':
    case 'arcgis_token':
      if (!payload.token || payload.token.length === 0) {
        throw new BadRequestException('Token must be non-empty');
      }
      return JSON.stringify({ token: payload.token });
    case 'basic':
      if (!payload.username || !payload.password) {
        throw new BadRequestException('Username and password are required');
      }
      return JSON.stringify({
        username: payload.username,
        password: payload.password,
      });
  }
}

/** Reverse of serializePayload. Throws if the on-disk shape
 *  doesn't match the kind column (corruption / hand-editing). */
function parsePayload(kind: AuthKind, plaintext: string): CredentialPayload {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(plaintext) as Record<string, unknown>;
  } catch {
    throw new Error('Stored credential JSON is malformed.');
  }
  switch (kind) {
    case 'bearer':
      if (typeof parsed.token !== 'string') {
        throw new Error('Stored bearer credential missing token.');
      }
      return { kind: 'bearer', token: parsed.token };
    case 'arcgis_token':
      if (typeof parsed.token !== 'string') {
        throw new Error('Stored arcgis_token credential missing token.');
      }
      return { kind: 'arcgis_token', token: parsed.token };
    case 'basic':
      if (
        typeof parsed.username !== 'string' ||
        typeof parsed.password !== 'string'
      ) {
        throw new Error('Stored basic credential missing username/password.');
      }
      return {
        kind: 'basic',
        username: parsed.username,
        password: parsed.password,
      };
  }
}
