// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Get, HttpCode, Post, Query, UnauthorizedException, UseFilters } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { EsriTokenService } from '../auth/esri-token.service.js';
import { Public } from '../auth/public.decorator.js';
import { EsriErrorFilter, EsriHttpError } from './esri-error.filter.js';
import { param, type RawParams } from './esri-query-params.js';

/**
 * `/api/arcgis/tokens/generateToken`, where Esri clients sign in. The
 * username is the GratisGIS username (or email) and the password is a
 * personal API key, so accounts that sign in through single sign-on,
 * and have no password here, can use ArcGIS Pro too. A read-only key
 * gives a token that can query but not edit.
 */
@ApiTags('featureserver')
@Controller('arcgis/tokens')
@UseFilters(EsriErrorFilter)
export class FeatureServerTokensController {
  constructor(private readonly tokens: EsriTokenService) {}

  // Tight: this endpoint checks credentials.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('generateToken')
  @HttpCode(200)
  async generatePost(@Query() q: RawParams, @Body() b: RawParams) {
    return this.generate({ ...q, ...(b && typeof b === 'object' ? b : {}) });
  }

  // Some clients ask with GET. The key then sits in the URL, as it
  // would with any Esri server; POST is what Pro uses.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Get('generateToken')
  async generateGet(@Query() q: RawParams) {
    return this.generate(q);
  }

  private async generate(p: RawParams) {
    const username = param(p, 'username') ?? '';
    const password = param(p, 'password') ?? '';
    const minutes = Number(param(p, 'expiration') ?? '60');
    try {
      const { token, expires } = await this.tokens.generate(username, password, minutes);
      return { token, expires, ssl: true };
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        throw new EsriHttpError(400, 400, 'Unable to generate token.', [
          'Invalid username or password. Use your GratisGIS username and a personal API key as the password.',
        ]);
      }
      throw err;
    }
  }
}
