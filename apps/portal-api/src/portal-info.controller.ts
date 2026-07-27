// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { PortalInfo } from '@gratis-gis/shared-types';

import { Public } from './auth/public.decorator.js';
import { PrismaService } from './prisma/prisma.service.js';

/**
 * Portal discovery endpoint. Returns the minimum a fresh client
 * (QGIS plugin, mobile field-app, future SDKs) needs to bootstrap
 * itself with just a portal URL: a display name, the OIDC issuer
 * for sign-in, and the API base URL.
 *
 * Unauthenticated by design: clients have to hit this BEFORE they
 * can sign in, so requiring a token here would be circular. The
 * response is also fully cacheable; nothing here varies per-user
 * or per-session.
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
    return {
      name: await this.resolveName(),
      // GG_VERSION is stamped by deploy.sh/install.sh from
      // `git describe --tags --always` and reaches the container via
      // compose, so it is the truthful deployed ref. The npm fallback
      // only fires under `pnpm dev` (the Docker runtime starts node
      // directly, where npm_package_version does not exist).
      version:
        process.env.GG_VERSION ??
        process.env.npm_package_version ??
        '0.0.0',
      api: {
        baseUrl: this.resolveApiBase(req),
      },
      auth: {
        type: 'oidc',
        issuer: this.resolveIssuer(),
      },
    };
  }

  /**
   * Prefer a configured org's `landingTitle` when the deployment is
   * single-tenant. Fall back to the org name, then to a generic
   * default. Multi-tenant portals that want different display names
   * per landing page can keep using PublicController.landing instead;
   * this discovery endpoint is portal-level, not org-level.
   */
  private async resolveName(): Promise<string> {
    const org = await this.prisma.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { name: true, landingTitle: true },
    });
    if (org?.landingTitle) return org.landingTitle;
    if (org?.name) return org.name;
    return process.env.PORTAL_NAME ?? 'GratisGIS Portal';
  }

  /**
   * The API base URL clients should use for subsequent calls.
   * Honors X-Forwarded-* so portals behind a reverse proxy advertise
   * the right hostname. Always ends in /api (no trailing slash) to
   * match how the rest of the portal is mounted.
   */
  private resolveApiBase(req: Request): string {
    const explicit = process.env.PORTAL_API_BASE_URL;
    if (explicit) return explicit.replace(/\/$/, '');
    const proto =
      (req.headers['x-forwarded-proto'] as string | undefined) ??
      req.protocol ??
      'http';
    const host =
      (req.headers['x-forwarded-host'] as string | undefined) ??
      req.headers.host ??
      'localhost';
    return `${proto}://${host}/api`;
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
