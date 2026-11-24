// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Organization } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service.js';
import { isMultiTenant } from './tenancy.js';

/**
 * Which organization a public (signed-out) request is about.
 *
 * This is the one place that answers that question. Naming the org a
 * new way (for example from the request's host name) is a new field
 * on PublicOrgLookup and a change here; the rules below stay put.
 *
 * Today the caller names the org with `?org=<slug>`:
 * - A slug that matches an org returns that org, in either mode.
 * - A slug that matches nothing returns null (the caller answers 404).
 * - No slug: in single mode, the install's organization (the oldest
 *   one), as before. In multi mode, null: a request that does not say
 *   which org it is for gets nothing, never "the first org".
 */
export type PublicOrgLookup = {
  /** The `org` query value, as the route received it. */
  slug?: string | undefined;
};

type OrgPrisma = Pick<PrismaService, 'organization'>;

export async function resolvePublicOrg(
  prisma: OrgPrisma,
  lookup: PublicOrgLookup,
): Promise<Organization | null> {
  const slug = typeof lookup.slug === 'string' ? lookup.slug.trim() : '';
  if (slug.length > 0) return prisma.organization.findUnique({ where: { slug } });
  if (isMultiTenant()) return null;
  return installOrg(prisma);
}

/**
 * The install's own organization in single mode: the oldest one.
 * Only for places where single mode has always meant "the org of this
 * install". Multi mode code must not call it.
 */
export async function installOrg(prisma: OrgPrisma): Promise<Organization | null> {
  return prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
}
