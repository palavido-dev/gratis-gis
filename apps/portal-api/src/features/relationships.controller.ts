import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FeaturesService } from './features.service.js';
import type { FeatureRelationship, ChildRelationshipRef } from '@gratis-gis/shared-types';

class CreateRelationshipDto {
  @IsString() @MinLength(1) @MaxLength(200) label!: string;
  @IsUUID('loose') relatedItemId!: string;
  @IsOptional() @IsString() @MaxLength(63) fkColumn?: string;
  @IsOptional() @IsEnum(['one-to-many', 'one-to-one']) cardinality?: 'one-to-many' | 'one-to-one';
}

/**
 * Manages parent-child relationships between data_layer items.
 *
 * POST /items/:id/relationships
 *   Register a new relationship. Adds a UUID FK column to the child table
 *   and records the relationship in both the parent and child item metadata.
 *
 * GET /items/:id/relationships
 *   List relationships for a feature service (both parent and child roles).
 *
 * DELETE /items/:id/relationships/:relId
 *   Remove a registered relationship. Does NOT drop the FK column: that
 *   would destroy data. The column becomes unmanaged.
 */
@ApiTags('relationships')
@ApiBearerAuth()
@Controller('items/:id/relationships')
export class RelationshipsController {
  constructor(
    private readonly features: FeaturesService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly prisma: PrismaService,
  ) {}

  // -------------------------------------------------------------------------
  // Auth helpers
  // -------------------------------------------------------------------------

  private async requireAdmin(user: AuthUser, itemId: string) {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'data_layer') {
      throw new BadRequestException('Item is not a feature service');
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can manage relationships');
    }
    return item;
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  @Get()
  async list(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const item = await this.items.get(user, id);
    if (item.type !== 'data_layer') {
      return { relationships: [], parentRelationship: null };
    }
    const data = item.data as Record<string, unknown> | null;
    return {
      relationships: (data?.['relationships'] as FeatureRelationship[]) ?? [],
      parentRelationship: (data?.['parentRelationship'] as ChildRelationshipRef) ?? null,
    };
  }

  /**
   * Register a parent-child relationship.
   *
   * Steps:
   * 1. Validate both items are feature_services and have PostGIS tables.
   * 2. Add the FK column to the child table (idempotent).
   * 3. Update parent item.data.relationships with the new relationship.
   * 4. Update child item.data.parentRelationship with the back-reference.
   */
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateRelationshipDto,
  ) {
    await this.requireAdmin(user, id);

    if (id === dto.relatedItemId) {
      throw new BadRequestException('A feature service cannot relate to itself');
    }

    // Validate the child item.
    const childItem = await this.items.get(user, dto.relatedItemId);
    if (childItem.type !== 'data_layer') {
      throw new BadRequestException('relatedItemId must reference a data_layer item');
    }

    if (!(await this.features.tableExists(id))) {
      throw new BadRequestException('Parent feature table is not yet provisioned. Ingest some features first.');
    }
    if (!(await this.features.tableExists(dto.relatedItemId))) {
      throw new BadRequestException('Child feature table is not yet provisioned. Ingest some features first.');
    }

    const fkColumn = dto.fkColumn ?? 'parent_global_id';
    const cardinality = dto.cardinality ?? 'one-to-many';

    // Add the FK column to the child table.
    await this.features.addParentKeyColumn(dto.relatedItemId, fkColumn);

    const relId = randomUUID();
    const newRel: FeatureRelationship = {
      id: relId,
      label: dto.label,
      relatedItemId: dto.relatedItemId,
      fkColumn,
      cardinality,
    };

    // Update parent metadata.
    const parentData = (await this.prisma.item.findUnique({ where: { id }, select: { data: true } }))?.data;
    const parentRels = ((parentData as Record<string, unknown>)?.['relationships'] as FeatureRelationship[]) ?? [];
    // Prevent duplicate registrations for the same child.
    if (parentRels.some((r) => r.relatedItemId === dto.relatedItemId && r.fkColumn === fkColumn)) {
      throw new BadRequestException('A relationship with this child item and FK column already exists');
    }
    await this.prisma.item.update({
      where: { id },
      data: {
        data: {
          ...(parentData as Record<string, unknown>),
          relationships: [...parentRels, newRel],
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // Update child back-reference.
    const childData = (await this.prisma.item.findUnique({ where: { id: dto.relatedItemId }, select: { data: true } }))?.data;
    await this.prisma.item.update({
      where: { id: dto.relatedItemId },
      data: {
        data: {
          ...(childData as Record<string, unknown>),
          parentRelationship: {
            parentItemId: id,
            fkColumn,
            relationshipId: relId,
          } satisfies ChildRelationshipRef,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return newRel;
  }

  /**
   * Remove a registered relationship from the parent's metadata.
   * The FK column on the child table is left intact (it may contain data).
   */
  @Delete(':relId')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('relId') relId: string,
  ) {
    const item = await this.requireAdmin(user, id);
    const data = item.data as Record<string, unknown>;
    const rels = (data?.['relationships'] as FeatureRelationship[]) ?? [];
    const target = rels.find((r) => r.id === relId);
    if (!target) throw new NotFoundException('Relationship not found');

    const updated = rels.filter((r) => r.id !== relId);
    await this.prisma.item.update({
      where: { id },
      data: {
        data: { ...data, relationships: updated } as unknown as Prisma.InputJsonValue,
      },
    });

    // Clear the back-reference on the child if it points to this relationship.
    const childData = (await this.prisma.item.findUnique({
      where: { id: target.relatedItemId },
      select: { data: true },
    }))?.data as Record<string, unknown> | null;
    if (childData) {
      const ref = childData['parentRelationship'] as ChildRelationshipRef | undefined;
      if (ref?.relationshipId === relId) {
        const { parentRelationship: _ref, ...rest } = childData;
        void _ref;
        await this.prisma.item.update({
          where: { id: target.relatedItemId },
          data: { data: rest as unknown as Prisma.InputJsonValue },
        });
      }
    }

    return { removed: true };
  }
}
