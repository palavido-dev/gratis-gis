// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';
import type { Organization, Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service.js';
import { resolvePublicOrg } from './public-org.js';
import { isMultiTenant } from './tenancy.js';
import { isUuidShape } from './uuid-shape.js';

/**
 * Which organization's items a list shows.
 *
 * Every list, count, facet and feed of items (and every list of
 * groups) limits its rows with one of the two functions here, so the
 * rule lives in one place:
 * - a signed-in list uses `ownOrgListScope(user)`;
 * - a signed-out list or feed uses `publicListScope(prisma, lookup)`.
 *
 * Single mode adds no limit: lists behave as they always have. In
 * multi mode a list holds only the items of one organization. An item
 * of another organization that the caller may read (a public item, for
 * one) stays readable by its direct link: the read checks are elsewhere
 * and do not change. It only stays out of lists, counts and feeds.
 *
 * Items shared with a user from another organization are not listed.
 * When that kind of sharing exists it is added here as its own,
 * explicit source next to the org limit, not by loosening the limit.
 */

/** The org a list is limited to, or null when it is not limited. */
export type ItemListScope = { orgId: string } | null;

/** The limit for a signed-in caller's lists: their own org's items. */
export function ownOrgListScope(user: { orgId: string }): ItemListScope {
  return isMultiTenant() ? { orgId: user.orgId } : null;
}

/**
 * `where` limited by `scope`. With no scope the same object comes
 * back, so a list that is not limited runs exactly the query it ran
 * before. Works for any model with an `orgId` column (items, groups).
 */
export function scopedWhere(
  where: Prisma.ItemWhereInput,
  scope: ItemListScope,
): Prisma.ItemWhereInput;
export function scopedWhere(
  where: Prisma.GroupWhereInput,
  scope: ItemListScope,
): Prisma.GroupWhereInput;
export function scopedWhere(where: object, scope: ItemListScope): object {
  return scope ? { AND: [where, scope] } : where;
}

/** How a signed-out request names the organization of a list. */
export type PublicListLookup = {
  /** `?org=<slug>`. */
  slug?: string | undefined;
  /** An org id, for the one route that has always taken `?orgId=`. */
  orgId?: string | undefined;
};

export type PublicListScope = {
  /** The organization named, when the request named one by slug. */
  org: Organization | null;
  /** The limit to add to the list's `where`. */
  scope: ItemListScope;
  /** The slug to carry into the links a list or feed writes. */
  slug: string | undefined;
};

/**
 * The organization a signed-out list or feed is for.
 *
 * - A slug that matches an org: that org's items, in either mode.
 * - A slug that matches nothing: 404.
 * - An org id (uuid shaped): that org's items, without a lookup; an
 *   id that matches nothing simply lists nothing.
 * - Nothing named: in single mode every public item, as before; in
 *   multi mode 404, never a mix of organizations and never "the first
 *   organization".
 */
export async function publicListScope(
  prisma: Pick<PrismaService, 'organization'>,
  lookup: PublicListLookup,
): Promise<PublicListScope> {
  const slug = typeof lookup.slug === 'string' ? lookup.slug.trim() : '';
  if (slug.length > 0) {
    const org = await resolvePublicOrg(prisma, { slug });
    if (!org) throw publicOrgNotFound(slug);
    return { org, scope: { orgId: org.id }, slug: org.slug };
  }
  if (isUuidShape(lookup.orgId)) {
    return { org: null, scope: { orgId: lookup.orgId }, slug: undefined };
  }
  if (isMultiTenant()) throw publicOrgNotFound(undefined);
  return { org: null, scope: null, slug: undefined };
}

/** The 404 for a signed-out request whose organization is unknown. */
export function publicOrgNotFound(slug: string | undefined): NotFoundException {
  if (slug) return new NotFoundException(`No organization with slug "${slug}"`);
  return new NotFoundException(
    isMultiTenant()
      ? 'Name the organization with ?org=<slug>'
      : 'No organization configured on this portal yet',
  );
}
