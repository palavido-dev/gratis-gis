// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CredentialService,
  type CredentialPayload,
} from '../items/credential.service.js';
import { exchangeBasicForArcgisToken } from '../items/arcgis-auth.js';
import {
  composeUpstreamHeaders,
  composeUpstreamUrl,
  extractSubPath,
  isArcgisRest,
  maskCredential,
} from '../items/item-proxy.controller.js';
import { isUuidShape } from './public.controller.js';
import { safeFetch, UnsafeOutboundUrlError } from '../common/net-guards.js';
import {
  PROXY_FETCH_TIMEOUT_MS,
  streamUpstreamToResponse,
} from '../common/proxy-stream.js';

/**
 * Anonymous twin of ItemProxyController for #307. Proxies upstream
 * GETs the same way the auth'd endpoint does, but only when the
 * underlying item is access='public' (and not soft-deleted). Used
 * by the runtime when an anonymous visitor opens a publicly shared
 * viewer that references an external service item (ArcGIS / WMS /
 * WFS / WMTS).
 *
 * The credential injection logic is identical: stored credentials
 * are looked up server-side, used to fetch the upstream, and the
 * proxied response body is streamed back to the anonymous client.
 * The credential itself never leaves the server. Marking an item
 * 'public' is the admin's explicit consent for anonymous traffic
 * to flow through the proxy on its behalf.
 *
 * No write surface here: GET only. Everything else still requires
 * auth via the ItemProxyController.
 */
@ApiTags('public', 'proxy')
@Controller('public/items/:id/proxy')
// Tight per-IP throttle: 30 GETs/minute from a single IP is more than
// any legitimate viewer needs (the runtime issues a handful of fetches
// per visited page).  Anything beyond that is enumeration / fan-out
// against the upstream we proxy.  Burst protection at the edge would
// be the ideal complement; this is the in-process equivalent.
@Throttle({ default: { ttl: 60_000, limit: 30 } })
export class PublicProxyController {
  private readonly log = new Logger(PublicProxyController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialService,
  ) {}

  @Public()
  @Get()
  async proxyRoot(
    @Param('id') itemId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.proxy(itemId, req, res);
  }

  @Public()
  @Get('*')
  async proxy(
    @Param('id') itemId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Same 500-to-404 gate the rest of the public surface uses:
    // a malformed UUID would otherwise surface Prisma's parser
    // error to anonymous callers.
    if (!isUuidShape(itemId)) {
      throw new NotFoundException('Item not found');
    }
    // Public-only gate: existence is hidden behind the same 404
    // private items see, so the anonymous endpoint never reveals
    // whether a private id exists.
    const item = await this.prisma.item.findFirst({
      where: { id: itemId, access: 'public', deletedAt: null },
      select: { id: true, data: true },
    });
    if (!item) throw new NotFoundException('Item not found');

    const itemData = item.data as
      | { url?: unknown; requiresAuth?: unknown }
      | null;
    const itemUrl = itemData?.url;
    if (typeof itemUrl !== 'string' || itemUrl.length === 0) {
      throw new BadRequestException(
        'Item has no upstream URL configured for proxying',
      );
    }

    // Same credential pipeline as the authed proxy. Public items
    // that point at a secured upstream still need their stored
    // credential injected; the admin who marked the item public
    // is explicitly opting in to "anonymous visitors get the data
    // through my server-side credential."
    const requiresAuth = itemData?.requiresAuth === true;
    let credential: CredentialPayload | null = null;
    if (requiresAuth) {
      credential = await this.credentials.getCredentialForProxy(itemId);
      if (credential.kind === 'basic' && isArcgisRest(itemUrl)) {
        try {
          const token = await exchangeBasicForArcgisToken({
            serviceUrl: itemUrl,
            username: credential.username,
            password: credential.password,
            cacheKey: itemId,
          });
          credential = { kind: 'arcgis_token', token };
        } catch (err) {
          this.log.warn(
            `public proxy token-exchange failed for item=${itemId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          res.status(401).json({
            message:
              err instanceof Error
                ? err.message
                : 'Could not exchange credentials for an ArcGIS token.',
          });
          return;
        }
      }
    }

    const subPath = extractSubPath(req.url);
    const target = composeUpstreamUrl(itemUrl, subPath, credential);
    const headers = composeUpstreamHeaders(credential);

    // SSRF guard.  The public-proxy path is anonymous, so anyone on
    // the internet can hit it for any access='public' item.  If a
    // (compromised or careless) admin marked an item public whose
    // url points at an internal host, the entire internet could
    // read internal responses through that item id.  safeFetch
    // re-validates every redirect hop, so a public host that 302s to
    // http://169.254.169.254/ (cloud metadata) or an internal docker
    // service is refused too, not just a directly-internal url.
    let upstream: globalThis.Response;
    try {
      upstream = await safeFetch(target, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof UnsafeOutboundUrlError) {
        res.status(400).json({ message: err.message });
        return;
      }
      this.log.warn(
        `public proxy fetch failed for item=${itemId} target=${maskCredential(
          target,
        )}: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(502).json({ message: 'Upstream proxy fetch failed' });
      return;
    }

    await streamUpstreamToResponse(upstream, res);
  }
}
