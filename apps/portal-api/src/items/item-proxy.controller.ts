// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from './items.service.js';
import {
  CredentialService,
  type CredentialPayload,
} from './credential.service.js';
import { exchangeBasicForArcgisToken } from './arcgis-auth.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LastUsageStamp } from './last-usage-stamp.js';
import {
  ProxyPathError,
  composeUpstreamUrl,
  extractSubPath,
} from './proxy-subpath.js';
import { safeFetch, UnsafeOutboundUrlError } from '../common/net-guards.js';
import {
  PROXY_FETCH_TIMEOUT_MS,
  streamUpstreamToResponse,
} from '../common/proxy-stream.js';

/**
 * Authenticated upstream proxy for secured external services (#36).
 *
 * GET /api/items/:id/proxy/<rest> looks up the item's stored
 * credential, fetches `<item.data.url>/<rest>` with the credential
 * injected, and streams the upstream body back. Read-only: writes
 * into a third-party service from the portal are out of scope and
 * almost certainly the wrong abstraction.
 *
 * Auth schemes:
 *   - bearer        : Authorization: Bearer <token>
 *   - basic         : Authorization: Basic <base64(user:pass)>
 *   - arcgis_token  : ?token=<token> appended to the request URL
 *
 * Authz: caller must be able to read the underlying item via the
 * existing items.get() check. Per-share access on the item gates
 * who can hit the proxy at all; the credential itself is opaque
 * to the caller.
 */
@ApiTags('items', 'proxy')
@ApiBearerAuth()
@Controller('items/:id/proxy')
export class ItemProxyController {
  private readonly log = new Logger(ItemProxyController.name);

  /**
   * Throttled `lastUsageAt` writer. The per-item "last stamped"
   * map and the throttle live in `LastUsageStamp` so this controller
   * and `ItemsController` share one implementation; the interval
   * below is the only knob kept here.
   */
  private lastUsage!: LastUsageStamp;
  private static readonly USAGE_THROTTLE_MS = 60_000;

  constructor(
    private readonly items: ItemsService,
    private readonly credentials: CredentialService,
    private readonly prisma: PrismaService,
  ) {
    this.lastUsage = new LastUsageStamp(
      this.prisma,
      this.log,
      ItemProxyController.USAGE_THROTTLE_MS,
    );
  }

  // Two routes wired to the same handler so a bare /proxy (no
  // sub-path, with or without query string) also matches. Nest's
  // wildcard '*' requires at least one path segment, so the
  // detail-page Probe call -- /api/items/<id>/proxy?f=json -- was
  // 404'ing without this companion. (#80)
  @Get()
  async proxyRoot(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.proxy(user, itemId, req, res);
  }

  @Get('*')
  async proxy(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // items.get enforces visibility (404 for caller-can't-see)
    // before we look at anything else. No credential leak through
    // a bogus item id even if a guess hits a real row.
    const item = await this.items.get(user, itemId);
    const itemData = item.data as
      | { url?: unknown; requiresAuth?: unknown }
      | null;
    const itemUrl = itemData?.url;
    if (typeof itemUrl !== 'string' || itemUrl.length === 0) {
      throw new BadRequestException(
        'Item has no upstream URL configured for proxying',
      );
    }

    // Credential lookup is conditional on data.requiresAuth (#83).
    // Items that don't require auth (most public ArcGIS services)
    // shouldn't be denied by the proxy just because no credential
    // was ever stored. We still go through the proxy for those
    // because it sidesteps browser CORS constraints and gives us
    // one consistent path for previews and live data fetches.
    const requiresAuth = itemData?.requiresAuth === true;
    let credential: CredentialPayload | null = null;
    if (requiresAuth) {
      credential = await this.credentials.getCredentialForProxy(itemId);

      // ArcGIS doesn't honour HTTP Basic on data endpoints (#76).
      // When the stored credential is Basic and the item points at
      // an ArcGIS REST URL, exchange username + password for a
      // short-lived token via the service's self-described token
      // endpoint. The exchange helper caches the token in-process
      // until it expires so we don't pay the round trip on every
      // proxied request.
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
            `proxy token-exchange failed for item=${itemId}: ${
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

    // The wildcard captures the path AFTER /proxy/. Express puts
    // it on the params object under a numeric key, but it can also
    // be reconstructed from req.url which is more portable across
    // route nesting changes. The helper refuses dot segments and any
    // composition whose pathname leaves the stored URL; see
    // proxy-subpath.ts for why that is load bearing.
    const target = resolveProxyTarget(itemUrl, req.url, credential);
    const headers = composeUpstreamHeaders(credential);

    // SSRF guard.  An item with a malicious data.url that pointed
    // at an internal host would otherwise be a free SSRF reflector
    // for any user with read access to that item.  safeFetch
    // re-validates every redirect hop, so a data.url that 302s to an
    // internal host or the cloud-metadata endpoint is refused too.
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
        `proxy fetch failed for item=${itemId} target=${maskCredential(target)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(502).json({ message: 'Upstream proxy fetch failed' });
      return;
    }

    // Stream the upstream body back with a byte ceiling and
    // backpressure. Content-length is not forwarded: Node's fetch
    // transparently decompresses gzip / br, so the upstream count
    // describes the compressed payload while we emit decompressed
    // bytes; a forwarded, wrong length truncates the document
    // mid-parse in the browser.
    await streamUpstreamToResponse(upstream, res);

    // Stamp lastUsageAt for the stale heuristic (#96). Only on a
    // successful upstream fetch -- a 4xx / 5xx upstream isn't real
    // usage, and counting failed requests would mask a dead service
    // as "still active". Throttled per-process so the inevitable
    // pan/zoom storm doesn't blow up DB writes; matches the
    // auth-sync lastSeenAt pattern (#50). Fire-and-forget so a slow
    // write can't tail-latency a successful response.
    // Goes through LastUsageStamp rather than prisma.item.update so
    // the stamp cannot drag `updatedAt` with it: a tile fetch is not
    // an edit of the basemap or service item being proxied. See
    // last-usage-stamp.ts.
    if (upstream.ok) {
      this.lastUsage.stamp(itemId);
    }
  }
}

/**
 * Turn the request URL into the upstream target, mapping a refused
 * sub-path to the 400 both proxy controllers answer with. Shared by
 * the anonymous twin so the two cannot disagree about what is
 * refused.
 */
export function resolveProxyTarget(
  itemUrl: string,
  requestUrl: string,
  credential: CredentialPayload | null,
): string {
  try {
    const subPath = extractSubPath(requestUrl);
    return composeUpstreamUrl(itemUrl, subPath, credential);
  } catch (err) {
    if (err instanceof ProxyPathError) {
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}

/** Compose request headers based on the credential kind. Bearer
 *  and basic ride in Authorization; arcgis_token uses the URL
 *  query param branch above and contributes no header. Null
 *  credential produces just the accept header (anonymous request). */
export function composeUpstreamHeaders(
  credential: CredentialPayload | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.8',
  };
  if (credential?.kind === 'bearer') {
    headers.authorization = `Bearer ${credential.token}`;
  } else if (credential?.kind === 'basic') {
    const encoded = Buffer.from(
      `${credential.username}:${credential.password}`,
      'utf8',
    ).toString('base64');
    headers.authorization = `Basic ${encoded}`;
  }
  return headers;
}

/** Redact ?token= from a URL so logs don't leak the credential
 *  even when an upstream proxy fetch fails. */
export function maskCredential(url: string): string {
  return url.replace(/([?&]token=)[^&]+/gi, '$1***');
}

/** Heuristic mirror of the probe controller's check: does the
 *  item's URL look like an ArcGIS REST endpoint that would need
 *  a token instead of HTTP Basic? Same rules so a credential that
 *  works in the wizard works through the proxy. (#76) */
export function isArcgisRest(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname === 'arcgis.com' || u.hostname.endsWith('.arcgis.com')) {
      return true;
    }
    if (/\/arcgis\/rest\//i.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}
