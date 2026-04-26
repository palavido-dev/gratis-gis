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

  constructor(
    private readonly items: ItemsService,
    private readonly credentials: CredentialService,
  ) {}

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
    // route nesting changes.
    const subPath = extractSubPath(req.url);
    const target = composeUpstreamUrl(itemUrl, subPath, credential);
    const headers = composeUpstreamHeaders(credential);

    let upstream: Response | globalThis.Response;
    try {
      upstream = await fetch(target, { method: 'GET', headers });
    } catch (err) {
      this.log.warn(
        `proxy fetch failed for item=${itemId} target=${maskCredential(target)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(502).json({ message: 'Upstream proxy fetch failed' });
      return;
    }

    // Forward status + body. Filter the headers to a known-safe
    // subset so we don't accidentally leak server internals
    // (e.g. some upstreams set Set-Cookie or proprietary headers
    // we don't want to bridge into the browser context).
    //
    // Don't forward content-length: Node's fetch transparently
    // decompresses gzip / br, so the upstream's reported byte
    // count refers to the compressed payload while our buffer
    // holds the decompressed bytes. Browsers truncate at the
    // header's count and the JSON parse fails mid-document
    // ("Expected ',' or '}' at position N"). Letting Express
    // set the header from the actual body length avoids the
    // mismatch.
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    const body = Buffer.from(await upstream.arrayBuffer());
    res.end(body);
  }
}

/** Pull everything after `/proxy/` from the request URL. Returns
 *  '' when the request hits exactly /proxy with no trailing path. */
function extractSubPath(url: string): string {
  const idx = url.indexOf('/proxy');
  if (idx < 0) return '';
  let after = url.slice(idx + '/proxy'.length);
  if (after.startsWith('/')) after = after.slice(1);
  return after;
}

/** Compose the final upstream URL: <item.data.url> + '/' +
 *  <subPath>, preserving query params on both sides. arcgis_token
 *  credentials are appended as a query param here so they end up
 *  in the URL the upstream sees. Null credential = no token to
 *  inject (item doesn't require auth). */
function composeUpstreamUrl(
  base: string,
  subPath: string,
  credential: CredentialPayload | null,
): string {
  // Strip a trailing slash on the base so we can join with
  // subPath cleanly without a double slash.
  const trimmed = base.replace(/\/$/, '');
  let joined: string;
  if (subPath.length === 0) {
    joined = trimmed;
  } else if (subPath.startsWith('?')) {
    // subPath is just a query string (e.g. probing the service
    // root with ?f=json from the detail page's Probe button).
    // Don't insert a slash before the '?' or we'd produce an
    // empty path segment that some servers reject.
    joined = `${trimmed}${subPath}`;
  } else {
    joined = `${trimmed}/${subPath}`;
  }
  if (credential?.kind === 'arcgis_token') {
    const u = new URL(joined);
    u.searchParams.set('token', credential.token);
    return u.toString();
  }
  return joined;
}

/** Compose request headers based on the credential kind. Bearer
 *  and basic ride in Authorization; arcgis_token uses the URL
 *  query param branch above and contributes no header. Null
 *  credential produces just the accept header (anonymous request). */
function composeUpstreamHeaders(
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
function maskCredential(url: string): string {
  return url.replace(/([?&]token=)[^&]+/gi, '$1***');
}

/** Heuristic mirror of the probe controller's check: does the
 *  item's URL look like an ArcGIS REST endpoint that would need
 *  a token instead of HTTP Basic? Same rules so a credential that
 *  works in the wizard works through the proxy. (#76) */
function isArcgisRest(url: string): boolean {
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
