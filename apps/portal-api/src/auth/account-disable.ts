// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The local half of disabling an account. Keycloak's `enabled` flag
 * stops sign-in, but API keys and scheduled scripts never ask
 * Keycloak, so every disable path (admin Disable, housekeeping
 * auto-disable, the Keycloak reconcile) calls this as well.
 *
 * It stamps `user.disabled_at` and revokes every live API key the
 * user holds. Revocation is permanent: enabling the account later
 * clears `disabled_at` and lets scheduled scripts run again, but the
 * old keys stay revoked and the owner creates new ones. A key that
 * may have been handed to someone during offboarding should not come
 * back on its own.
 */
export async function disableLocalAccount(
  prisma: Pick<PrismaClient, '$transaction'>,
  userId: string,
  at: Date = new Date(),
): Promise<{ newlyDisabled: boolean; revokedKeys: number }> {
  return prisma.$transaction(async (tx) => {
    const marked = await tx.user.updateMany({
      where: { id: userId, disabledAt: null },
      data: { disabledAt: at },
    });
    const revoked = await tx.apiKey.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    });
    return { newlyDisabled: marked.count > 0, revokedKeys: revoked.count };
  });
}

/** Clear the local disabled marker. Revoked keys stay revoked. */
export async function enableLocalAccount(
  prisma: Pick<PrismaClient, 'user'> | Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const r = await prisma.user.updateMany({
    where: { id: userId, disabledAt: { not: null } },
    data: { disabledAt: null },
  });
  return r.count > 0;
}
