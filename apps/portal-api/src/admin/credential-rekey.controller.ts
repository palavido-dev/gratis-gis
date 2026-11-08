// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminGuard } from './admin.guard.js';
import { CredentialRekeyService } from './credential-rekey.service.js';

class RekeyDto {
  @IsString()
  @MaxLength(80)
  confirm!: string;
}

@ApiTags('admin', 'rekey')
@ApiBearerAuth()
@Controller('admin/rekey')
@UseGuards(AdminGuard)
export class CredentialRekeyController {
  constructor(private readonly rekey: CredentialRekeyService) {}

  @Get()
  preflight() {
    return this.rekey.preflight().then((counts) => ({
      ...counts,
      ...this.rekey.coverage(),
    }));
  }

  @Post()
  @HttpCode(409)
  async run(@CurrentUser() user: AuthUser, @Body() _body: RekeyDto) {
    await this.rekey.refuse(user);
  }
}
