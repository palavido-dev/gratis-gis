import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  AUTH_KINDS,
  type AuthKind,
  type CredentialPayload,
} from './credential.service.js';
import { exchangeBasicForArcgisToken } from './arcgis-auth.js';

/**
 * Inline service probe with optional ephemeral credential (#74).
 *
 * The wizard uses this when an ArcGIS / WMS / WFS endpoint returns
 * 401 / 403 / 499 to a public probe: the user types the token (or
 * username + password), we make the upstream call server-side with
 * the credential injected, and stream the JSON back. The credential
 * is NOT persisted by this endpoint -- callers reuse the same
 * payload shape against PUT /api/items/:id/credential after the
 * item has been created so the proxy keeps working.
 *
 * Authz: any logged-in user can probe. SSRF guards and audit
 * logging are intentionally minimal because this is the same blast
 * radius as `fetch()` from the user's browser; we just want the
 * credential to live on the server for the duration of the round
 * trip. If the platform later restricts outbound network access on
 * the API box, this endpoint inherits that.
 */

class ProbeCredentialDto {
  @IsEnum(AUTH_KINDS) kind!: AuthKind;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4096) token?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) username?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(1024) password?: string;
}

class ProbeRequestDto {
  /** Service URL to fetch. The wizard hands us the URL the user
   *  pasted, after it's been split into a service-root form (we
   *  don't normalise here -- caller is responsible). */
  @IsUrl({ require_tld: false }) url!: string;

  /** Optional credential to inject. Omit for an anonymous probe. */
  @IsOptional() credential?: ProbeCredentialDto;
}

@ApiTags('services', 'probe')
@ApiBearerAuth()
@Controller('services/probe')
export class ServiceProbeController {
  private readonly log = new Logger(ServiceProbeController.name);

  @Post()
  async probe(
    @CurrentUser() user: AuthUser,
    @Body() dto: ProbeRequestDto,
  ): Promise<unknown> {
    // Build the credential payload up-front so a malformed shape
    // 400s before we ever touch the network.
    let credential: CredentialPayload | null = null;
    if (dto.credential) {
      credential = buildCredentialPayload(dto.credential);
    }

    // ArcGIS doesn't honour HTTP Basic on data endpoints (#76).
    // When the user gives us a Basic credential, exchange the
    // username + password for an ArcGIS token via the service's
    // self-described token endpoint and use that for the actual
    // upstream call. The ephemeral cache key is the username so
    // the wizard can re-probe (e.g. layer pick changed) without
    // a fresh round trip.
    if (credential && credential.kind === 'basic' && isArcgisRest(dto.url)) {
      try {
        const token = await exchangeBasicForArcgisToken({
          serviceUrl: dto.url,
          username: credential.username,
          password: credential.password,
          cacheKey: `probe|${user.id}`,
        });
        credential = { kind: 'arcgis_token', token };
      } catch (err) {
        return {
          ok: false,
          status: 401,
          statusText:
            err instanceof Error
              ? err.message
              : 'Could not exchange credentials for an ArcGIS token.',
          body: '',
        };
      }
    }

    // Compose the request: headers carry bearer / basic, the URL
    // gets ?token=... for arcgis_token. Same logic the per-item
    // proxy uses, deliberately copy-pasted here so the two paths
    // can evolve independently if the auth shapes diverge.
    const target = composeUrl(dto.url, credential);
    const headers = composeHeaders(credential);
    // ArcGIS service roots only emit JSON when ?f=json is set;
    // bake it into the URL if the caller didn't already.
    const finalUrl = ensureJsonFormat(target);

    let upstream: Response;
    try {
      upstream = await fetch(finalUrl, {
        method: 'GET',
        headers,
      });
    } catch (err) {
      this.log.warn(
        `probe fetch failed user=${user.id} url=${maskCredential(finalUrl)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new BadRequestException(
        `Could not reach ${dto.url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!upstream.ok) {
      // ArcGIS often returns 200 with an "error" body for token
      // problems, but some deployments use a real 4xx. Either way,
      // we want the wizard to recognise the auth case so it can
      // pop the credential form. Forward status + body so the
      // caller can branch on it; we don't mutate the body.
      const body = await safeText(upstream);
      return {
        ok: false,
        status: upstream.status,
        statusText: upstream.statusText,
        body,
      };
    }

    const text = await upstream.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Upstream returned a 200 with non-JSON. Treat as a soft
      // failure and let the wizard show the message.
      return {
        ok: false,
        status: 200,
        statusText: 'Upstream did not return JSON',
        body: text.slice(0, 2000),
      };
    }
    // Detect ArcGIS's 200-with-error envelope. Token-required errors
    // come back as { error: { code: 499, message: 'Token Required' } }.
    if (
      json &&
      typeof json === 'object' &&
      'error' in (json as Record<string, unknown>)
    ) {
      const err = (json as { error?: { code?: unknown; message?: unknown } })
        .error;
      const code =
        typeof err?.code === 'number' ? err.code : 0;
      const message =
        typeof err?.message === 'string' ? err.message : 'Upstream error';
      return {
        ok: false,
        status: code || 400,
        statusText: message,
        body: text.slice(0, 2000),
      };
    }
    return { ok: true, status: 200, body: json };
  }
}

function buildCredentialPayload(dto: ProbeCredentialDto): CredentialPayload {
  switch (dto.kind) {
    case 'bearer':
      if (!dto.token) {
        throw new BadRequestException('bearer requires a token');
      }
      return { kind: 'bearer', token: dto.token };
    case 'arcgis_token':
      if (!dto.token) {
        throw new BadRequestException('arcgis_token requires a token');
      }
      return { kind: 'arcgis_token', token: dto.token };
    case 'basic':
      if (!dto.username || !dto.password) {
        throw new BadRequestException('basic requires username and password');
      }
      return {
        kind: 'basic',
        username: dto.username,
        password: dto.password,
      };
  }
}

function composeUrl(base: string, credential: CredentialPayload | null): string {
  if (credential?.kind === 'arcgis_token') {
    const u = new URL(base);
    u.searchParams.set('token', credential.token);
    return u.toString();
  }
  return base;
}

function composeHeaders(
  credential: CredentialPayload | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
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

function ensureJsonFormat(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('f')) {
      u.searchParams.set('f', 'json');
    }
    return u.toString();
  } catch {
    // Caller will get a network failure on a malformed URL anyway;
    // surface that downstream rather than throwing here.
    return url;
  }
}

function maskCredential(url: string): string {
  return url.replace(/([?&]token=)[^&]+/gi, '$1***');
}

/**
 * Heuristic: does the URL look like an ArcGIS REST endpoint? Used
 * to decide whether to exchange Basic credentials for an ArcGIS
 * token (#76). We match either "/arcgis/rest/" anywhere in the
 * path (the canonical ArcGIS Server context) or any *.arcgis.com
 * host (covers ArcGIS Online's services{N}.arcgis.com fleet).
 */
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

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return '';
  }
}
