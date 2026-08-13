// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrintRenderService } from './print-render.service.js';

class RenderDto {
  @IsUUID() templateId!: string;
  @IsUUID() mapId!: string;
  @IsOptional() @IsObject() parameterValues?: Record<string, string>;
}

class ConsumeTokenDto {
  @IsString() @MaxLength(128) token!: string;
}

@ApiTags('print')
@ApiBearerAuth()
@Controller('print')
export class PrintRenderController {
  constructor(private readonly svc: PrintRenderService) {}

  /**
   * Trigger a server-side render. Returns the PDF bytes.
   * Permission-checked: the user must be able to read both the
   * print_template and the map item.
   */
  @Post('render')
  async render(
    @CurrentUser() user: AuthUser,
    @Body() dto: RenderDto,
    @Res() res: Response,
  ): Promise<void> {
    const pdf = await this.svc.render(user, {
      templateId: dto.templateId,
      mapId: dto.mapId,
      ...(dto.parameterValues ? { parameterValues: dto.parameterValues } : {}),
    });
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-length', String(pdf.byteLength));
    res.setHeader(
      'content-disposition',
      `attachment; filename="map-print.pdf"`,
    );
    res.end(pdf);
  }

  /**
   * Token consumer used by the print-preview route to validate
   * that the calling chromium session is legitimately rendering
   * a job portal-api previously authorized. @Public() because
   * the chromium sidecar can't carry the user's Keycloak token;
   * authorization is via the single-use render token instead.
   */
  @Public()
  @Post('consume-render-token')
  async consume(@Body() dto: ConsumeTokenDto) {
    const claims = await this.svc.consumeToken(dto.token);
    if (!claims) {
      throw new BadRequestException('Render token is missing or expired');
    }
    return claims;
  }

  /**
   * #159 Phase 2.2 internal load endpoint. Validates the render
   * token AND resolves the template + map items with the user's
   * permissions, returning the full bundle the print-preview
   * route needs. Lets the preview render private maps (not just
   * publicly-shared ones) because portal-api does the permission
   * resolution server-side rather than relying on the chromium
   * sidecar to forward a Bearer token. @Public() because the
   * sidecar still can't carry a Bearer; authorization is via
   * the single-use token.
   */
  @Public()
  @Post('internal/load-job')
  async loadJob(@Body() dto: ConsumeTokenDto) {
    const bundle = await this.svc.loadJobByToken(dto.token);
    if (!bundle) {
      throw new BadRequestException('Render token is missing or expired');
    }
    return bundle;
  }
}
