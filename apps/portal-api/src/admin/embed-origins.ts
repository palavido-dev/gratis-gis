// SPDX-License-Identifier: AGPL-3.0-or-later
import { normalizeEmbedOrigins } from '@gratis-gis/shared-types';

import type { PrismaService } from '../prisma/prisma.service.js';
import { installOrg, resolvePublicOrg } from '../common/public-org.js';
import { isMultiTenant } from '../common/tenancy.js';

/**
 * Admin allow-list of sites the Embed widget may frame (review
 * 28b-5). Stored per organization (`organization.embed_origins`).
 * portal-web reads the list through GET /public/embed-origins and adds
 * it to `frame-src` on app runtime pages only. Every other page keeps
 * `frame-src 'self' blob:`.
 *
 * Which organization's list:
 * - single mode: the install's organization (the oldest one), for the
 *   admin page and the public read alike. The list used to be one
 *   install-wide setting; the upgrade copied it onto that org.
 * - multi mode: the admin's own org, and for the public read the org
 *   the request names.
 */
/** The key of the install-wide row this list used to live in. */
export const EMBED_ORIGINS_KEY = 'embed_origins';

type OrgPrisma = Pick<PrismaService, 'organization'>;

/** The saved list, normalized again on read so a hand-edited row
 *  can never put a stray token into the CSP. */
export async function readEmbedOrigins(prisma: OrgPrisma, orgId: string): Promise<string[]> {
  const row = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { embedOrigins: true },
  });
  const list = Array.isArray(row?.embedOrigins)
    ? row.embedOrigins.filter((o): o is string => typeof o === 'string')
    : [];
  return normalizeEmbedOrigins(list).origins;
}

export async function writeEmbedOrigins(
  prisma: OrgPrisma,
  orgId: string,
  origins: string[],
): Promise<string[]> {
  await prisma.organization.update({
    where: { id: orgId },
    data: { embedOrigins: origins },
  });
  return origins;
}

/** The org whose list the admin page reads and writes. */
export async function adminEmbedOriginsOrgId(
  prisma: OrgPrisma,
  user: { orgId: string },
): Promise<string> {
  if (isMultiTenant()) return user.orgId;
  return (await installOrg(prisma))?.id ?? user.orgId;
}

/**
 * The org whose list a public read returns, or null when there is
 * none (the caller answers 404). Single mode ignores `?org=`: the
 * list has always been the install's.
 */
export async function publicEmbedOriginsOrgId(
  prisma: OrgPrisma,
  orgSlug: string | undefined,
): Promise<string | null> {
  const org = isMultiTenant()
    ? await resolvePublicOrg(prisma, { slug: orgSlug })
    : await installOrg(prisma);
  return org?.id ?? null;
}
