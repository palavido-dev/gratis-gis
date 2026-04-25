import { Controller, Get, NotFoundException, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Unauthenticated surface area for the portal. Anything here is
 * readable by the internet without a session cookie or bearer
 * token. Keep it narrow: public item metadata, org landing config,
 * public feeds.
 *
 * All responses deliberately carry a lean projection: no shares
 * list, no dependent lookups, nothing that would leak private
 * content through a public endpoint. If in doubt, do not expose it
 * here.
 */
@ApiTags('public')
@Controller('public')
export class PublicController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Landing page payload for unauthenticated visitors. Returns:
   *   - resolved org (title, subtitle, hero image URL)
   *   - show-items toggle
   *   - grid of public items (honoring featuredItemIds order) OR
   *     empty array when the toggle is off
   *
   * In single-tenant deployments the `org` query param is optional
   * and resolves to the only organization. Multi-tenant deployments
   * require the slug.
   */
  @Public()
  @Get('landing')
  async landing(@Query('org') orgSlug?: string) {
    const org = orgSlug
      ? await this.prisma.organization.findUnique({ where: { slug: orgSlug } })
      : await this.resolveSingleOrg();
    if (!org) {
      throw new NotFoundException(
        orgSlug
          ? `No organization with slug "${orgSlug}"`
          : 'No organization configured on this portal yet',
      );
    }

    const items = org.landingShowPublicItems
      ? await this.publicItemsFor(org.id, org.landingFeaturedItemIds)
      : [];

    return {
      org: {
        slug: org.slug,
        name: org.name,
        title: org.landingTitle ?? org.name,
        subtitle: org.landingSubtitle ?? null,
        heroImageUrl: org.landingHeroImageUrl ?? null,
        showPublicItems: org.landingShowPublicItems,
      },
      items,
    };
  }

  /**
   * DCAT-lite machine-readable catalog of every public item. Shape
   * follows the W3C Data Catalog Vocabulary loosely: each item
   * becomes a dcat:Dataset with the license, description, tags, and
   * a landing URL back at the portal. Downstream consumers (open-data
   * aggregators, search crawlers, internal tooling) can crawl this to
   * discover what's shareable.
   *
   * The spec-strict DCAT feed (turtle / JSON-LD with full @context)
   * lands in #66: this is the Phase-1 JSON version, which is enough
   * for most aggregators that just want a list of URLs + metadata.
   */
  @Public()
  @Get('catalog.json')
  async catalog(@Req() req: Request, @Query('org') orgSlug?: string) {
    const org = orgSlug
      ? await this.prisma.organization.findUnique({ where: { slug: orgSlug } })
      : await this.resolveSingleOrg();
    if (!org) {
      throw new NotFoundException(
        orgSlug
          ? `No organization with slug "${orgSlug}"`
          : 'No organization configured on this portal yet',
      );
    }

    // Best-effort self URL for the catalog so clients can deref.
    // We honour X-Forwarded-* because portals are typically behind
    // a reverse proxy.
    const proto =
      (req.headers['x-forwarded-proto'] as string | undefined) ??
      req.protocol ??
      'http';
    const host =
      (req.headers['x-forwarded-host'] as string | undefined) ??
      req.headers.host ??
      'localhost';
    const portalBase = `${proto}://${host}`;

    const items = await this.prisma.item.findMany({
      where: {
        orgId: org.id,
        access: 'public',
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        tags: true,
        license: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      '@context': 'https://project-open-data.cio.gov/v1.1/schema/catalog.jsonld',
      conformsTo: 'https://project-open-data.cio.gov/v1.1/schema',
      publisher: { name: org.name },
      dataset: items.map((it) => ({
        '@type': 'dcat:Dataset',
        identifier: it.id,
        title: it.title,
        description: it.description || it.title,
        keyword: it.tags ?? [],
        issued: it.createdAt.toISOString(),
        modified: it.updatedAt.toISOString(),
        landingPage: `${portalBase}/items/${it.id}`,
        // License is optional in v1; absent means "rights reserved".
        // Clients that want a discoverable open-data feed should
        // filter to items with a license set.
        ...(it.license ? { license: it.license } : {}),
        // Rough theme mapping from item type. Not standards-strict
        // but more useful than nothing for downstream facets.
        theme: [it.type],
      })),
    };
  }

  /**
   * Resolve the org for single-tenant portals where the query param
   * is unnecessary. Orders by createdAt so the original seed wins;
   * additional orgs (if any) can still be reached by explicit slug.
   */
  private async resolveSingleOrg() {
    const orgs = await this.prisma.organization.findMany({
      orderBy: { createdAt: 'asc' },
      take: 1,
    });
    return orgs[0] ?? null;
  }

  /**
   * Public items in the org, featured ones first. Lean projection
   * stripped of anything that would leak share lists or tag clouds
   * an admin didn't mean to publish.
   */
  private async publicItemsFor(orgId: string, featuredIds: string[]) {
    const all = await this.prisma.item.findMany({
      where: {
        orgId,
        access: 'public',
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        thumbnailUrl: true,
        updatedAt: true,
        tags: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (featuredIds.length === 0) return all;

    // Featured-first ordering: respect the admin's author order for
    // the featured set, then everything else newest-first. Items no
    // longer public that were in featuredIds are silently dropped.
    const byId = new Map(all.map((i) => [i.id, i]));
    const featured = featuredIds
      .map((id) => byId.get(id))
      .filter((i): i is NonNullable<typeof i> => !!i);
    const rest = all.filter((i) => !featuredIds.includes(i.id));
    return [...featured, ...rest];
  }
}
