// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { isReadOnlySafeMethod, looksLikeApiKey } from './api-key-token.js';
import { ApiKeyService } from './api-key.service.js';

/**
 * JWT auth guard with proper @Public() semantics.
 *
 * The naive shape (pre-fix) was: if the route is @Public, short-circuit
 * canActivate to true and skip the JWT strategy entirely. That breaks
 * any @Public route that branches on whether the caller is signed in
 * (e.g. storage.controller's getPrivateAsset, which returns a private
 * file to the owner but rejects anonymous reads of non-public items).
 * With the strategy skipped, `req.user` was always null even when the
 * client sent a valid Bearer token, so the controller always took the
 * anonymous branch -- the WV Parcel Viewer logo 403'd even for the
 * owning admin.
 *
 * Correct shape: run the strategy whenever an Authorization header is
 * present so `req.user` gets populated for authed callers; only allow
 * the request through with `req.user = null` when the route is @Public
 * AND no token was provided AND token validation failed for some
 * reason. Private routes keep their existing "no user = 401" semantics.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
  ) {
    super();
  }

  override async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    // #219: a personal API key arrives in the same Authorization
    // header as a JWT, so branch on the token's own scheme marker
    // before handing anything to passport (which would reject a
    // non-JWT outright). This runs ahead of the @Public shortcut so a
    // key-authenticated caller gets its real identity on public
    // routes too, matching what a Bearer JWT does there.
    const bearer = readBearer(ctx);
    if (bearer !== null && looksLikeApiKey(bearer)) {
      const user = await this.apiKeys.resolve(bearer);
      if (user.apiKeyReadOnly === true) {
        const req = ctx.switchToHttp().getRequest<{ method?: string }>();
        if (!isReadOnlySafeMethod(req.method ?? 'GET')) {
          throw new ForbiddenException(
            'This API key is read-only. Create a key without the read-only option to make changes.',
          );
        }
      }
      const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
      req.user = user;
      return true;
    }

    // Skip the strategy entirely for @Public routes with no Bearer
    // token. Avoids paying the JWKS fetch + DB upsert cost on every
    // anonymous hit to a public surface (e.g. landing-page items,
    // anon storage GETs on public-shared web-apps).
    if (isPublic) {
      const req = ctx.switchToHttp().getRequest<{
        headers?: { authorization?: string };
      }>();
      const hasBearer =
        typeof req.headers?.authorization === 'string' &&
        req.headers.authorization.toLowerCase().startsWith('bearer ');
      if (!hasBearer) return true;
    }
    // Wrap super.canActivate() so that the fully-synchronous failure
    // chain inside passport-jwt cannot crash the Node worker (#117).
    //
    // When passport-jwt's strategy.authenticate fails synchronously
    // (missing token, signature mismatch, hot JWKS cache), the call
    // chain strategy.fail -> passport.allFailed -> @nestjs/passport
    // inner callback -> our handleRequest runs in a single sync stack.
    // The throw at the top of that stack was escaping @nestjs/passport's
    // createPassportContext try/catch (Promise rejection went unhandled)
    // and surfacing as an uncaughtException that killed the worker.
    // Both prod replicas were crash-looping every 15-30 minutes.
    //
    // Awaiting inside an explicit try/catch attaches a rejection handler
    // in our own scope, so any error becomes a normal Nest HttpException
    // that the global exception filter turns into a 401 / 403 response.
    try {
      const result = await super.canActivate(ctx);
      return Boolean(result);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(
        `JWT auth chain threw a non-HttpException; rethrowing as 401: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new UnauthorizedException();
    }
  }

  /**
   * Decide whether a missing / invalid user is fatal. Passport calls
   * us with (err, user, info) after the strategy runs; we override so
   * @Public routes can fall through with `req.user = null` instead of
   * 401-ing. Private routes keep the standard "missing user is fatal"
   * contract.
   */
  override handleRequest<TUser = unknown>(
    err: unknown,
    user: TUser | false | null,
    info: unknown,
    ctx: ExecutionContext,
  ): TUser {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) {
      // A valid token: passport hands us a populated user. A bad
      // token (expired, wrong signature) or absent token: user is
      // false/null and we return null so the controller sees an
      // anonymous caller. Errors aren't surfaced because the route
      // explicitly opted into "I'll handle the no-auth case."
      if (err || !user) return null as TUser;
      return user;
    }
    // Private route: existing strict behavior. Always throw an
    // HttpException so the canActivate try/catch above can pass it
    // straight through to Nest's exception filter. (Before #117 we
    // could throw a raw Error here; that path is preserved by the
    // canActivate fallback, but normalising to HttpException keeps
    // the response shape predictable.)
    if (err || !user) {
      if (err instanceof HttpException) throw err;
      throw new UnauthorizedException();
    }
    return user;
  }
}

/**
 * The raw credential from an `Authorization: Bearer <x>` header, or
 * null when the header is absent or not a bearer. Case-insensitive on
 * the scheme, matching the check the @Public shortcut already does.
 */
function readBearer(ctx: ExecutionContext): string | null {
  const req = ctx.switchToHttp().getRequest<{
    headers?: { authorization?: string };
  }>();
  const raw = req.headers?.authorization;
  if (typeof raw !== 'string') return null;
  if (!raw.toLowerCase().startsWith('bearer ')) return null;
  const value = raw.slice('bearer '.length).trim();
  return value.length > 0 ? value : null;
}
