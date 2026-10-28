// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { CommentsService } from './comments.service.js';

class CreateThreadDto {
  @IsString() @MinLength(1) @MaxLength(10_000) body!: string;
  @IsOptional()
  @IsIn(['map', 'layer', 'feature', 'drawing'])
  parentKind?: 'map' | 'layer' | 'feature' | 'drawing';
  @IsOptional() @IsString() @MaxLength(200) parentId?: string;
}

class ReplyDto {
  @IsString() @MinLength(1) @MaxLength(10_000) body!: string;
}

class EditCommentDto {
  @IsString() @MinLength(1) @MaxLength(10_000) body!: string;
}

class ResolveDto {
  @IsBoolean() resolved!: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(name: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
}

@ApiTags('comments')
@ApiBearerAuth()
@Controller('items/:itemId/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  /**
   * List every thread on an item. Public for public items
   * (the service gates non-public reads against canRead).
   *
   * Rate limit is tighter than the global 300/min default
   * (matches Public OGC Records list at 60/min): anonymous
   * pollers on public item threads are an easy burn if left at
   * the global ceiling. Authenticated create/reply/resolve stay
   * on the global default.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get()
  list(
    @CurrentUser() user: AuthUser | null,
    @Param('itemId') itemId: string,
  ) {
    assertUuid('itemId', itemId);
    return this.comments.list(user, itemId);
  }

  @Post()
  createThread(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() dto: CreateThreadDto,
  ) {
    assertUuid('itemId', itemId);
    return this.comments.createThread(user, itemId, {
      body: dto.body,
      ...(dto.parentKind ? { parentKind: dto.parentKind } : {}),
      ...(dto.parentId ? { parentId: dto.parentId } : {}),
    });
  }

  @Post(':threadId/replies')
  reply(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Param('threadId') threadId: string,
    @Body() dto: ReplyDto,
  ) {
    assertUuid('itemId', itemId);
    assertUuid('threadId', threadId);
    return this.comments.reply(user, itemId, threadId, { body: dto.body });
  }

  @Patch(':threadId')
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Param('threadId') threadId: string,
    @Body() dto: ResolveDto,
  ) {
    assertUuid('itemId', itemId);
    assertUuid('threadId', threadId);
    return this.comments.setThreadResolved(
      user,
      itemId,
      threadId,
      dto.resolved,
    );
  }

  @Patch(':threadId/replies/:commentId')
  editReply(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Param('threadId') threadId: string,
    @Param('commentId') commentId: string,
    @Body() dto: EditCommentDto,
  ) {
    assertUuid('itemId', itemId);
    assertUuid('threadId', threadId);
    assertUuid('commentId', commentId);
    return this.comments.editComment(user, itemId, threadId, commentId, {
      body: dto.body,
    });
  }

  @Delete(':threadId/replies/:commentId')
  deleteReply(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Param('threadId') threadId: string,
    @Param('commentId') commentId: string,
  ) {
    assertUuid('itemId', itemId);
    assertUuid('threadId', threadId);
    assertUuid('commentId', commentId);
    return this.comments.deleteComment(user, itemId, threadId, commentId);
  }
}
