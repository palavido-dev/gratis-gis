// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth-sync.service.js';
import { effectiveCapabilities } from './capabilities.js';
import { hashApiKey, mintApiKey } from './api-key-token.js';

/** What the list endpoint returns. Never includes the token. */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  readOnly: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * Resolution + lifecycle for personal API keys (#219).
 *
 * The contract that makes this safe to bolt onto every existing
 * guard: a key resolves to EXACTLY the AuthUser its owner would get
 * from a JWT. Same org, same role, same groups, same capability
 * overrides. Nothing downstream needs to know how the caller
 * authenticated, so no service or guard has to grow a second code
 * path that could drift from the first.
 *
 * The two restrictions on keys are enforced outside this resolution:
 * `readOnly` in the guard (method allowlist) and the /admin/* block
 * in AdminGuard, both keyed on `AuthUser.authKind`.
 */
@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Throttle for `last_used_at`. A script polling every second would
   * otherwise turn every read into a write on a row that only needs
   * "roughly when was this last used" resolution. Mirrors the
   * lastSeenAt throttle in auth-sync.
   */
  private readonly lastUsedWrites = new Map<string, number>();
  private static readonly LAST_USED_THROTTLE_MS = 60_000;

  /**
   * Verify a presented token and build its AuthUser, or throw 401.
   *
   * Every rejection raises the same generic message: a caller holding
   * a bad token learns only that it did not work, never whether it
   * was unknown, revoked, expired, or owned by a disabled account.
   */
  async resolve(token: string): Promise<AuthUser> {
    const row = await this.prisma.apiKey.findUnique({
      where: { tokenHash: hashApiKey(token) },
      include: { user: { include: { org: true } } },
    });
    if (!row) throw new UnauthorizedException('Invalid API key.');
    if (row.revokedAt !== null) {
      throw new UnauthorizedException('Invalid API key.');
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid API key.');
    }

    const user = row.user;
    // Account lockout. The JWT path leans on Keycloak to stop a
    // deleted or disabled user at the SSO gate, but a long-lived key
    // never revisits Keycloak, so both checks have to live here or a
    // key would outlive the account that owns it. `deletedAt` in
    // particular is NOT checked on the JWT path at all.
    if (user.deletedAt !== null) {
      throw new UnauthorizedException('Invalid API key.');
    }
    if (
      user.autoDisableAt !== null &&
      user.autoDisableAt.getTime() <= Date.now() &&
      user.orgRole !== 'admin'
    ) {
      throw new UnauthorizedException('Invalid API key.');
    }

    const [groups, overrides] = await Promise.all([
      this.prisma.groupMember.findMany({
        where: { userId: user.id, group: { deletedAt: null } },
        select: { groupId: true },
      }),
      this.prisma.userCapabilityOverride.findMany({
        where: { userId: user.id },
        select: { capability: true, enabled: true },
      }),
    ]);

    void this.touch(row.id);

    return {
      id: user.id,
      orgId: user.orgId,
      // The SLUG, not the UUID. Passing the UUID here re-triggers the
      // phantom-org bug documented on AuthUser.orgSlug.
      orgSlug: user.org.slug,
      username: user.username,
      email: user.email,
      orgRole: user.orgRole,
      groupIds: groups.map((g) => g.groupId),
      capabilities: effectiveCapabilities(user.orgRole, overrides),
      authKind: 'api_key',
      apiKeyReadOnly: row.readOnly,
    };
  }

  /** Best-effort, throttled `last_used_at` write. Never blocks or
   *  fails a request: this is telemetry for the key list UI. */
  private async touch(keyId: string): Promise<void> {
    const now = Date.now();
    const last = this.lastUsedWrites.get(keyId) ?? 0;
    if (now - last < ApiKeyService.LAST_USED_THROTTLE_MS) return;
    this.lastUsedWrites.set(keyId, now);
    try {
      await this.prisma.apiKey.update({
        where: { id: keyId },
        data: { lastUsedAt: new Date(now) },
      });
    } catch {
      /* telemetry only */
    }
  }

  async list(userId: string): Promise<ApiKeySummary[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      readOnly: r.readOnly,
      expiresAt: r.expiresAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Mint a key for a user. Returns the plaintext token exactly once;
   * it is unrecoverable afterwards, which is the whole point.
   */
  async create(
    user: AuthUser,
    input: { name: string; readOnly?: boolean; expiresInDays?: number | null },
  ): Promise<ApiKeySummary & { token: string }> {
    const minted = mintApiKey();
    const expiresAt =
      typeof input.expiresInDays === 'number' && input.expiresInDays > 0
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : null;
    const row = await this.prisma.apiKey.create({
      data: {
        userId: user.id,
        name: input.name.trim(),
        tokenHash: minted.tokenHash,
        prefix: minted.prefix,
        readOnly: input.readOnly ?? false,
        expiresAt,
      },
    });
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      readOnly: row.readOnly,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
      token: minted.token,
    };
  }

  /**
   * Mint a short-lived key for one server-side script run (#221).
   *
   * Separate from `create` for two reasons. The public path takes an
   * AuthUser and a TTL in days, neither of which fits a run: the
   * caller here is the runner acting on a stored user id, and the
   * lifetime is measured against a wall-clock timeout in seconds.
   * Expressing that as a fraction of a day would work and would be
   * unreadable.
   *
   * The key is expected to be revoked the moment the run ends. The
   * expiry is the backstop for the case that matters: the worker
   * being SIGKILLed between minting and revoking, which would
   * otherwise leave a live credential with nobody left to clean it up.
   * Belt and braces on purpose, because the failure mode is a
   * long-lived key nobody knows exists.
   */
  async mintForRun(
    userId: string,
    input: { label: string; ttlSeconds: number },
  ): Promise<{ id: string; token: string }> {
    const minted = mintApiKey();
    const row = await this.prisma.apiKey.create({
      data: {
        userId,
        name: input.label,
        tokenHash: minted.tokenHash,
        prefix: minted.prefix,
        // Not read-only: the whole point of a scheduled script is that
        // it can refresh a layer. Its authority is still bounded by
        // the owning user's own permissions, which is the actual
        // control; read-only would just make the feature useless.
        readOnly: false,
        expiresAt: new Date(Date.now() + Math.max(input.ttlSeconds, 1) * 1000),
      },
      select: { id: true },
    });
    return { id: row.id, token: minted.token };
  }

  /**
   * Revoke a key the system minted, by id alone.
   *
   * The user-facing `revoke` scopes by userId so one person cannot
   * revoke another's key. That check is meaningless here: the caller
   * is the runner cleaning up a key it minted seconds ago, and it must
   * succeed even if the owning user was deleted mid-run. Never reachable
   * from a request.
   */
  async revokeSystemKey(keyId: string): Promise<void> {
    await this.prisma.apiKey.updateMany({
      where: { id: keyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revoke by id, scoped to the owner so one user can never revoke
   * another's key by guessing an id. Idempotent: revoking an already
   * revoked key keeps the original timestamp.
   */
  async revoke(userId: string, keyId: string): Promise<ApiKeySummary> {
    const row = await this.prisma.apiKey.findFirst({
      where: { id: keyId, userId },
    });
    if (!row) throw new UnauthorizedException('API key not found.');
    const updated =
      row.revokedAt === null
        ? await this.prisma.apiKey.update({
            where: { id: row.id },
            data: { revokedAt: new Date() },
          })
        : row;
    return {
      id: updated.id,
      name: updated.name,
      prefix: updated.prefix,
      readOnly: updated.readOnly,
      expiresAt: updated.expiresAt,
      lastUsedAt: updated.lastUsedAt,
      revokedAt: updated.revokedAt,
      createdAt: updated.createdAt,
    };
  }
}
