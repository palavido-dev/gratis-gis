// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { PortalInfo } from '@gratis-gis/shared-types';
import { expressionTimeZone } from './expressions/time-zone.js';

import { isAnalysisEnabled } from './analysis/analysis-tiers.js';
import { Public } from './auth/public.decorator.js';
import { textEnv } from './common/env.js';
import { isMultiTenant, tenancyMode } from './common/tenancy.js';
import { isFeedbackEnabled } from './feedback/feedback-config.js';
import { PrismaService } from './prisma/prisma.service.js';
import { isScriptsEnabled } from './scripts/scripts-config.js';
import { absoluteBase } from './public/ogc/url.js';

/**
 * Portal discovery endpoint. Returns the minimum a fresh client
 * (QGIS plugin, mobile field-app, future SDKs) needs to bootstrap
 * itself with just a portal URL: a display name, the OIDC issuer
 * for sign-in, and the API base URL.
 *
 * Unauthenticated by design: clients have to hit this BEFORE they
 * can sign in, so requiring a token here would be circular. On an
 * install that serves one organization the response does not vary
 * per user or per session. On an install that serves many, the name
 * and time zone are the signed-in caller's org, and the install's
 * name and UTC for a signed-out caller.
 *
 * Per-client OIDC client IDs are deliberately NOT returned. Each
 * client knows its own client_id by virtue of being that client.
 * Keeping the contract minimal makes the endpoint cacheable on the
 * edge and prevents a malicious client from learning sibling client
 * IDs to impersonate them.
 */
@ApiTags('portal-info')
@Controller('portal-info')
export class PortalInfoController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async info(@Req() req: Request): Promise<PortalInfo> {
    const callerOrgId = callerOrgIdOf(req);
    return {
      name: await this.resolveName(callerOrgId),
      // GG_VERSION is stamped by deploy.sh/install.sh from
      // `git describe --tags --always` and reaches the container via
      // compose, so it is the truthful deployed ref. The npm fallback
      // only fires under `pnpm dev` (the Docker runtime starts node
      // directly, where npm_package_version does not exist).
      version:
        process.env.GG_VERSION ??
        process.env.npm_package_version ??
        '0.0.0',
      gitSha: process.env.GIT_SHA?.trim() || null,
      channel: process.env.GG_CHANNEL?.trim() || null,
      api: {
        baseUrl: this.resolveApiBase(req),
      },
      auth: {
        type: 'oidc',
        issuer: this.resolveIssuer(),
      },
      timeZone: await expressionTimeZone(this.prisma, callerOrgId),
      tenancy: tenancyMode(),
      features: {
        feedback: isFeedbackEnabled(),
        scripts: isScriptsEnabled(),
        analysis: isAnalysisEnabled(),
      },
    };
  }

  /**
   * Prefer the org's `landingTitle`, fall back to the org name, then
   * to a generic default. On a one-organization install the org is
   * the install's, so this endpoint and PublicController.landing
   * describe the same org. On an install that serves many it is the
   * signed-in caller's org; a signed-out caller gets the install's
   * name (PORTAL_NAME), never another org's.
   */
  private async resolveName(callerOrgId: string | null): Promise<string> {
    const fallback = textEnv(process.env.PORTAL_NAME, 'GratisGIS Portal');
    if (isMultiTenant() && !callerOrgId) return fallback;
    const org = isMultiTenant()
      ? await this.prisma.organization.findUnique({
          where: { id: callerOrgId as string },
          select: { name: true, landingTitle: true },
        })
      : await this.prisma.organization.findFirst({
          orderBy: { createdAt: 'asc' },
          select: { name: true, landingTitle: true },
        });
    if (org?.landingTitle) return org.landingTitle;
    if (org?.name) return org.name;
    return fallback;
  }

  /**
   * The API base URL clients should use for subsequent calls. Always
   * ends in /api (no trailing slash) to match how the rest of the
   * portal is mounted. PORTAL_BASE_URL wins over the forwarded
   * headers, as for every other absolute link (absoluteBase): a
   * request that reached the API without the proxy rewriting them
   * could otherwise plant its own host in the discovery document
   * QGIS and the mobile apps bootstrap from.
   */
  private resolveApiBase(req: Request): string {
    const explicit = process.env.PORTAL_API_BASE_URL;
    if (explicit) return explicit.replace(/\/$/, '');
    return `${absoluteBase(req)}/api`;
  }

  /**
   * OIDC issuer. For the bundled Keycloak this is
   * `{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}`. Operators who run their
   * own OIDC provider can override the whole URL via OIDC_ISSUER.
   */
  private resolveIssuer(): string {
    const explicit = process.env.OIDC_ISSUER;
    if (explicit) return explicit.replace(/\/$/, '');
    const url = (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(
      /\/$/,
      '',
    );
    const realm = process.env.KEYCLOAK_REALM ?? 'gratis-gis';
    return `${url}/realms/${realm}`;
  }
}

/** The signed-in caller's org id, or null for a signed-out request. */
function callerOrgIdOf(req: Request): string | null {
  const user = (req as Request & { user?: { orgId?: unknown } | null }).user;
  return typeof user?.orgId === 'string' && user.orgId.length > 0 ? user.orgId : null;
}
