// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { deriveServerSigningKey } from '../storage/signing-key.js';
import { AuthSyncService, type AuthUser } from './auth-sync.service.js';
import {
  PRINT_READ_KEY_LABEL,
  PRINT_READ_MAX_ITEMS,
  PRINT_READ_TTL_MS,
  signPrintReadCredential,
  verifyPrintReadCredential,
} from './print-read-credential.js';

/** What the guard knows about the request a credential arrived on. */
export interface PrintReadRequest {
  /** The handler is marked @PrintReadable(). */
  routeAllowed: boolean;
  method: string;
  /** The `:id` route param. */
  itemId: unknown;
  /** The `?clip=` boundary item, when sent. */
  clip: unknown;
}

/**
 * Mints and checks print read credentials. See print-read-credential.ts
 * for what the credential is and why it is narrow.
 */
@Injectable()
export class PrintReadCredentialService {
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authSync: AuthSyncService,
    cfg: ConfigService,
  ) {
    // The same secret and default StorageService signs upload handles
    // with, under a label of its own.
    this.key = deriveServerSigningKey(
      cfg.get<string>('MINIO_SECRET_KEY', 'devpassword'),
      PRINT_READ_KEY_LABEL,
    );
  }

  /** A credential for `userId` that reads only `itemIds`, for one minute. */
  mint(userId: string, itemIds: Iterable<string>, now = Date.now()): string {
    const ids = Array.from(new Set(itemIds)).slice(0, PRINT_READ_MAX_ITEMS);
    return signPrintReadCredential(
      { uid: userId, ids, exp: now + PRINT_READ_TTL_MS },
      this.key,
    );
  }

  /**
   * The principal a request with this credential runs as, or an
   * exception. The route, the method and the item ids are checked
   * here; the item's sharing is checked by the handler itself, as the
   * user, so access removed after the mint is honoured.
   */
  async resolve(token: string, req: PrintReadRequest): Promise<AuthUser> {
    const claims = verifyPrintReadCredential(token, this.key);
    if (!claims) {
      throw new UnauthorizedException('Print credential is invalid or expired.');
    }
    if (!req.routeAllowed || req.method.toUpperCase() !== 'GET') {
      throw new ForbiddenException('A print credential can only read map layers.');
    }
    if (typeof req.itemId !== 'string' || !claims.ids.includes(req.itemId)) {
      throw new ForbiddenException('This item is not part of the print.');
    }
    if (
      req.clip !== undefined &&
      (typeof req.clip !== 'string' || !claims.ids.includes(req.clip))
    ) {
      throw new ForbiddenException('This item is not part of the print.');
    }
    // Rebuilt on every request, so a user who is deleted, disabled or
    // dropped from a group since the mint gets exactly what they can
    // read now. Same lockout rules as an API key.
    const row = await this.prisma.user.findUnique({
      where: { id: claims.uid },
      select: {
        deletedAt: true,
        disabledAt: true,
        autoDisableAt: true,
        orgRole: true,
      },
    });
    if (
      !row ||
      row.deletedAt !== null ||
      row.disabledAt !== null ||
      (row.autoDisableAt !== null &&
        row.autoDisableAt.getTime() <= Date.now() &&
        row.orgRole !== 'admin')
    ) {
      throw new UnauthorizedException('Print credential is invalid or expired.');
    }
    const principal = await this.authSync.principalForUserId(claims.uid);
    if (!principal) {
      throw new UnauthorizedException('Print credential is invalid or expired.');
    }
    return { ...principal, authKind: 'print_read' };
  }
}
