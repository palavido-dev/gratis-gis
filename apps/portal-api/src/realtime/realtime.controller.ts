// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { RealtimeService } from './realtime.service.js';

class CursorDto {
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsNumber() @Min(-90) @Max(90) lat!: number;
}

class HeartbeatDto {
  @IsOptional() @IsString() @MaxLength(80) connectionId?: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => CursorDto)
  cursor?: CursorDto | null;
}

class TicketDto {
  @IsOptional() @IsString() @MaxLength(80) connectionId?: string;
}

class LeaveBodyDto {
  @IsString() @MaxLength(80) connectionId!: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException('mapId must be a UUID');
  }
}

@ApiTags('realtime')
@ApiBearerAuth()
@Controller('realtime/maps/:mapId/presence')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Post('heartbeat')
  heartbeat(
    @CurrentUser() user: AuthUser,
    @Param('mapId') mapId: string,
    @Body() dto: HeartbeatDto,
  ) {
    assertUuid(mapId);
    return this.realtime.heartbeat(user, mapId, {
      ...(dto.connectionId !== undefined
        ? { connectionId: dto.connectionId }
        : {}),
      ...(dto.cursor !== undefined ? { cursor: dto.cursor ?? null } : {}),
    });
  }

  /**
   * Mint a short-lived WS ticket. Browser never sees the session
   * JWT on the WebSocket URL; it opens wss://.../api/realtime/ws
   * with this ticket instead (#156 Phase 1.5).
   */
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('ticket')
  ticket(
    @CurrentUser() user: AuthUser,
    @Param('mapId') mapId: string,
    @Body() dto: TicketDto,
  ) {
    assertUuid(mapId);
    return this.realtime.mintTicket(
      user,
      mapId,
      dto.connectionId,
    );
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('mapId') mapId: string) {
    assertUuid(mapId);
    return this.realtime.list(user, mapId);
  }

  @Delete(':connectionId')
  leave(
    @CurrentUser() user: AuthUser,
    @Param('mapId') mapId: string,
    @Param('connectionId') connectionId: string,
  ) {
    assertUuid(mapId);
    return this.realtime.leave(user, mapId, connectionId);
  }

  /**
   * Beacon-friendly leave. navigator.sendBeacon can only POST;
   * the DELETE route above stays for explicit client leave.
   */
  @Post('leave')
  @HttpCode(204)
  leavePost(
    @CurrentUser() user: AuthUser,
    @Param('mapId') mapId: string,
    @Body() dto: LeaveBodyDto,
  ) {
    assertUuid(mapId);
    return this.realtime.leave(user, mapId, dto.connectionId);
  }
}
